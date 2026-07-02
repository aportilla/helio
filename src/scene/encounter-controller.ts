// EncounterController — the thin scene-side glue that runs an encounter as a MODE on SystemScene. It
// owns the transient EncounterState, its own ortho overlay Scene+camera (the SystemActionMenu
// precedent), and the combat-specific chrome (the bottom encounter bar + End Turn button + the
// per-action tracers); SystemScene owns the freeze flag + the sidebar/turn gates and drives this from
// its tick/resize/input. The per-sprite HP / energy GAUGES are NOT owned here: they are a persistent
// part of the system view's ship rendering (ShipGaugesOverlay, owned by SystemScene), so combat just
// FEEDS them the live combatant values through the injected `paintGauges` sink — at rest SystemScene
// feeds the same overlay each ship's full charge. It imports the encounter RULES (createEncounterState /
// applyCommand / isTerminal) + DTOs from src/encounter/ — never the reverse. No second SystemDiagram:
// combat is an extra render PASS over the one live diagram, anchored to the fleet slots via the
// slotCenterFor accessor SystemScene passes in.
//
// E4 — the interactive loop: the SAME anchored menu drives the round. On enter (and after every
// committed action) the controller opens the menu on the ACTIVE combatant (it IS an Actor, carrying
// seeded energy/energyMax so the gate works); a confirm routes through the menu's onEncounterCommit
// sink to `commit`, which folds the intent into the reducer and re-opens on the new activeId — keeping
// strict lockstep with the reducer's "intent actor === active combatant" assertion. A DEV `autoPlay`
// flag auto-drives that same `commit` path on a timer (the demo / spectator), so one code path serves
// both the player and the headless verification.
//
// EV (§14) — the action-event animation seam: the reducer is synchronous, but an action's beat (a bolt
// crossing to its target, the HP drop landing) needs frames of wall-clock time. So `commit` no longer
// reopens the menu in its own call stack — it applies the reducer, fans the returned events into the
// CombatTracers layer's BOLTS, and opens an animation `playback` WINDOW; the existing per-frame `tick`
// advances the tracers and only `settle`s (repaint to the post-action truth, terminal check, reopen the
// menu) once the window elapses. The HP drop thus lands at the END of the beat, not at the click. A
// barrage's `count` and the per-weapon look are recovered render-side from the firing command (§14.4/
// §14.5); render-only pacing — no float reaches the integer-milli reducer (§6.4).

import { OrthographicCamera, Scene, type WebGLRenderer } from 'three';
import { applyCommand, createEncounterState, endPhase, selectActor } from '../encounter/step';
import { chooseAutoIntent } from '../encounter/ai';
import { neighborActor } from '../encounter/turn-order';
import { isTerminal } from '../encounter/terminal';
import { ENERGY_STAT, ENERGY_MAX_STAT, isDown, type Combatant, type EncounterEvent, type EncounterState } from '../encounter/state';
import { fullInitiative } from '../encounter/initiative';
import { HULL_POOL } from '../encounter/pools';
import type { EncounterSpec } from '../encounter/encounter-spec';
import type { ActionCommand, ActionIntent, TargetAllegiance, TargetCandidate } from '../actions/types';
import { commandFor } from '../actions/derive';
import { filterCandidates } from '../actions/menu';
import { CONTROLLED_FACTION_ID, factionColor } from '../factions/registry';
import type { ShipGauge } from './ship-gauges';
import { EncounterHud, EndTurnButton, ActivePip, ENCOUNTER_BAR_HEIGHT } from '../ui/encounter-hud';
import { CombatTracers, vfxForCommand, type Bolt } from './encounter-tracers';
import type { SlotCenter, SystemActionMenu } from './actions/system-action-menu';

// Wall-clock pacing for the DEV auto-play (ms between reducer steps) — slow enough to read each hit +
// the HP drain. Render-only timing; it never feeds back into the integer-milli reducer.
const STEP_MS = 800;

// EV barrage tuning (render-only, §14.4/§14.6). MAX_BARRAGE caps how many bolts one hit fans (so a hugely
// stacked weapon can't stretch the window absurdly); SRC_FAN spreads a barrage's launch points vertically
// at the source. Per-weapon colour + per-bolt timing live in the tracer layer's vfxForCommand.
const MAX_BARRAGE = 6;
const SRC_FAN = 4;

// Active-pip wiggle (render-only): the acting side's frontier pip shimmers along its OWN slant by
// adding/removing whole pixel rows at its ends (the amplitude, in rows, lives in ActivePip so its
// stair-steps stay grid-locked). ACTIVE_PIP_PERIOD sets the cycle off the frame clock.
const ACTIVE_PIP_PERIOD = 120;

export class EncounterController {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);
  private readonly bar = new EncounterHud();
  private readonly endTurn = new EndTurnButton();
  private readonly activePip = new ActivePip();
  private readonly tracers: CombatTracers;

  private state: EncounterState | null = null;
  // The content width is still read by the encounter bar + the End Turn button placement (the per-sprite
  // gauges moved to SystemScene's overlay, which holds its OWN content dims — so no buffer height here).
  private contentW = 1;
  // Cached at each repaint (it only changes when the state does): true when NONE of the controlled side's
  // living ships has an affordable, target-having action left — the trigger for the End Turn button's gold
  // CTA blink. tick() reads it per frame to drive the blink without re-scanning the roster each frame.
  private noPlayerActions = false;
  // The home slot of the acting side's frontier pip (null = the acting side holds no initiative). Cached
  // at each repaint (moves only on state change + resize); tick() slides the ActivePip widget along its
  // slant from this home each frame.
  private activePipHome: { left: number; bottom: number } | null = null;
  // PREVIEW mode (no live encounter): SystemScene raises this while the player drills the action menu past
  // its root, showing the bar populated with the tactical state a fight WOULD open with (both fleets at
  // full initiative, the player acting). `previewRoster` is the combatant snapshot, re-painted on resize.
  // `previewing` reads true only when no real encounter owns the bar.
  private previewRoster: readonly Combatant[] | null = null;
  private lastStepAt = 0; // 0 = re-arm: the first tick shows the opening state before stepping
  // EV (§14): a post-action animation window in flight. While set, `tick` advances nothing else (the round
  // is paused on the beat), drives the CombatTracers layer each frame, and `settle`s when it elapses.
  // `startedAt` is stamped lazily on the first tick that sees it — the commit that opens the window has no
  // frame clock. Null between beats; a window opens only when an action produces an animatable beat.
  // durationMs is DERIVED per action by buildBolts (a staggered barrage runs longer than a single shot),
  // so the window always fits its bolts — no flat constant.
  private playback: { startedAt: number; readonly durationMs: number } | null = null;

  // OFF by default: the live path drives the round from player input via the menu. The DEV demo flips
  // it on to auto-drive the same commit path (so the loop is visible headlessly).
  autoPlay = false;
  // Raised by the controller when the encounter ends (side-elimination or mutual disengage); SystemScene wires
  // this to exitEncounter (lower the freeze, re-enable Next Turn).
  onExit: () => void = () => {};

  constructor(
    private readonly slotCenterFor: (id: string) => SlotCenter | null,
    private readonly menu: SystemActionMenu,
    private readonly nameFor: (id: string) => string,
    // The persistent per-sprite HP / energy gauges are owned + rendered by SystemScene (they show even
    // outside combat); combat just FEEDS them the live combatant values through this sink at each repaint.
    private readonly paintGauges: (gauges: readonly ShipGauge[]) => void,
  ) {
    this.tracers = new CombatTracers(this.slotCenterFor);
    this.bar.addTo(this.scene);
    this.endTurn.addTo(this.scene);
    this.activePip.addTo(this.scene);
    this.tracers.addTo(this.scene);
  }

  get active(): boolean {
    return this.state !== null;
  }

  // True while the bar is showing a PRE-COMBAT preview (never during a live encounter, which owns the bar
  // itself). SystemScene gates the encounter overlay's tick + render on `active || previewing`.
  get previewing(): boolean {
    return this.previewRoster !== null && this.state === null;
  }

  // Raise the pre-combat preview: paint the bar from a snapshot of the system's fleets (both sides at full
  // initiative, the player acting so its frontier pip shimmers) — but NO End Turn button (nothing to end)
  // and no reducer. SystemScene calls this when the action menu drills past its root.
  showPreview(combatants: readonly Combatant[]): void {
    if (this.state) return; // a live encounter owns the bar; a preview never overrides it
    this.previewRoster = combatants;
    this.paintPreview();
  }

  // Drop the preview (menu backed out to root / closed). A no-op on the bar while a live encounter owns it.
  hidePreview(): void {
    this.previewRoster = null;
    if (this.state) return;
    this.bar.hide();
    this.activePip.setVisible(false);
    this.endTurn.setVisible(false);
  }

  private paintPreview(): void {
    if (!this.previewRoster) return;
    const initiative = fullInitiative(this.previewRoster);
    const phaseSide = CONTROLLED_FACTION_ID;
    this.bar.paint(this.previewRoster, initiative, phaseSide, this.contentW);
    this.activePipHome = this.bar.activePipHome(this.previewRoster, initiative, phaseSide, this.contentW);
    if (this.activePipHome) {
      this.activePip.setColor(factionColor(phaseSide));
      this.activePip.moveTo(this.activePipHome.left, this.activePipHome.bottom);
    }
    this.endTurn.setVisible(false);
  }

  // Wiggle the acting side's frontier pip (its slot left empty by the bar) — a variant swap, not a
  // translate, so the body stays crawl-free. Shared by the live round and the preview.
  private driveActivePip(now: number, show: boolean): void {
    if (show && this.activePipHome) {
      this.activePip.setPhase(Math.sin(now / ACTIVE_PIP_PERIOD));
      this.activePip.setVisible(true);
    } else {
      this.activePip.setVisible(false);
    }
  }

  // Begin the encounter from a launch spec: seed the reducer state, route the menu's confirm sink to this
  // controller, paint the opening roster, then FIRE the launching attack (`spec.initiator`) as the
  // initiator's opening move — so the action that ENTERED combat also lands (with its animation + effects),
  // not a no-op that merely opens the mode. The menu opens on the NEXT turn, after the opening shot settles.
  enter(spec: EncounterSpec): void {
    this.previewRoster = null; // a live encounter supersedes any pre-combat preview
    this.state = createEncounterState(spec);
    this.menu.onEncounterCommit = (intent) => this.commit(intent);
    this.menu.setEncounterMode(true);
    // Fail closed: a spec already terminal at birth (a degenerate <2-living-sides roster) must not open
    // the menu over a dead encounter — tear down at once, mirroring commit()/endActivePhase(). The live
    // launch path can't produce this (combat is born from an attack on a living enemy), but enter()
    // shouldn't depend on the caller's invariant — otherwise a controlled active just sits, since tick()
    // returns on `playerWaits` before it reaches its own terminal check.
    if (isTerminal(this.state)) {
      this.onExit();
      return;
    }
    this.repaint();
    // Fire the action that TRIGGERED the encounter as the initiator's opening move — entering combat and
    // the first shot are ONE beat, not two. createEncounterState put `activeId` on the initiator, so the
    // intent's actor IS the active combatant (commit/applyCommand's invariant); commit animates it, applies
    // its effects, and settles into the next turn (opening the menu there).
    this.commit(spec.initiator);
  }

  exit(): void {
    this.menu.setEncounterMode(false);
    this.menu.close();
    this.state = null;
    this.previewRoster = null; // combat's teardown drops any preview intent too
    this.playback = null; // drop any in-flight beat so it can't gate a re-entered encounter's tick
    this.tracers.clearBolts();
    // The gauges aren't ours to hide — SystemScene repaints them to the at-rest (full charge) readout on
    // exitEncounter, so they persist as part of the ship rendering instead of blanking when combat ends.
    this.bar.hide();
    this.endTurn.setVisible(false);
    this.activePip.setVisible(false);
  }

  resize(contentBufferW: number, bufferH: number): void {
    this.contentW = contentBufferW;
    this.camera.right = contentBufferW;
    this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.tracers.resize(contentBufferW, bufferH);
    if (this.state) this.repaint();
    else if (this.previewRoster) this.paintPreview();
  }

  // Per-frame: advance any in-flight animation WINDOW first (the beat the last commit opened) — while one
  // plays, nothing else moves — then drive the auto-turns on a timer. A CONTROLLED combatant's turn waits
  // for the player's menu input — UNLESS auto-play (the demo) drives it too; an OPPONENT's turn is always
  // auto-driven by the AI policy. Lingers one interval before each auto-step (so the menu/turn reads), and on
  // the terminal state before exiting. The live player loop advances on confirm, not here.
  tick(now: number): void {
    if (!this.state) {
      // Pre-combat preview (no reducer): just keep the frontier pip shimmering. SystemScene only ticks us
      // here while previewing, so a bare `previewRoster` check suffices.
      if (this.previewRoster) this.driveActivePip(now, this.activePipHome !== null);
      return;
    }
    // Drive the End Turn button every frame: it shows only on the CONTROLLED side's LIVE phase (hidden
    // mid-beat — the round is paused on the animation window — and during the opponent's auto-driven
    // phase), and runs its gold CTA blink off `now` when the player has no useful action left
    // (noPlayerActions, cached at repaint). A cheap texture swap; nothing here re-scans the roster.
    const showEndTurn = this.playback === null && this.state.phaseSide === CONTROLLED_FACTION_ID;
    this.endTurn.update(now, showEndTurn, showEndTurn && this.noPlayerActions);
    // Wiggle the acting side's frontier pip along its slant (both phases), hidden mid-beat like the button
    // — the round is paused on the animation window. The pip is FIXED at its home (placed at repaint); the
    // slide is a variant swap (ActivePip adds/removes whole rows at its ends), so nothing translates and
    // the body stays crawl-free. A signed sine drives it up-and-right then down-and-left.
    this.driveActivePip(now, this.playback === null && this.activePipHome !== null);
    // A beat is playing: hold ALL turn advancement (the auto-driver below AND the player's reopened menu)
    // until its window elapses, then settle. startedAt is stamped on the first tick that sees the window
    // — the commit that opened it had no frame clock (§14.2).
    if (this.playback) {
      if (this.playback.startedAt < 0) this.playback.startedAt = now;
      const elapsed = now - this.playback.startedAt;
      this.tracers.render(elapsed);
      if (elapsed < this.playback.durationMs) return;
      this.playback = null;
      this.tracers.clearBolts();
      this.settle();
      return;
    }
    const active = this.state.combatants[this.state.activeId];
    if (!active) return;
    const playerWaits = active.factionId === CONTROLLED_FACTION_ID && !this.autoPlay;
    if (playerWaits) return;
    if (this.lastStepAt === 0) {
      this.lastStepAt = now; // hold this turn's state for one interval before auto-acting
      return;
    }
    if (now - this.lastStepAt < STEP_MS) return;
    this.lastStepAt = now;
    if (isTerminal(this.state)) {
      this.onExit();
      return;
    }
    // Auto-drive the opponent's phase via the AI policy (§3.7): chooseAutoIntent reasons over the WHOLE
    // phase side — picking which same-side ship fires and focus-firing the weakest enemy — so a mixed
    // loadout no longer forfeits the phase the instant the active ship can't fire. A null intent means the
    // side is stranded (no affordable, target-having action): end the phase so a held pool never soft-
    // locks the round (§3.8.3 auto-pass). The driver LOOPS across ticks — one activation per interval —
    // spending the pool down, then hands the phase back (the player's phase opens its menu via openOnActive).
    const intent = chooseAutoIntent(this.state);
    if (!intent) {
      this.endActivePhase();
      return;
    }
    // The policy may pick a same-side ship that isn't the active one, so re-anchor the cursor onto it (a
    // pure cursor move — no icon, no turn-start tick — the SAME selectActor the player's free actor choice
    // uses) before committing, keeping applyCommand's "intent actor === active combatant" invariant.
    // Repaint only when the cursor actually moved, so the active-turn marker tracks the firing ship.
    const chosen = this.state.combatants.find((c) => c.id === intent.actorId);
    if (chosen) {
      const moved = selectActor(this.state, chosen.combatId);
      if (moved !== this.state) {
        this.state = moved;
        this.repaint();
      }
    }
    this.commit(intent);
  }

  // The overlay anchors to the live fleet slots, so it must render in the SAME content viewport the
  // diagram does; SystemScene sets that up and calls this between the diagram and the chrome passes.
  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  // Set up the combatant whose turn it is. You command only YOUR side: the anchored menu opens on a
  // CONTROLLED combatant (carrying its own derived loadout + seeded energy gate, its durable id
  // anchoring the panel/pointer, candidates built from the live roster relative to it); an opponent's
  // turn opens NO menu and is auto-driven by tick via the AI policy (§3.7, chooseAutoIntent). Called on
  // enter and after every commit; re-arms the auto-turn timer.
  private openOnActive(state: EncounterState): void {
    this.lastStepAt = 0;
    const active = state.combatants[state.activeId];
    if (!active) return;
    if (active.factionId === CONTROLLED_FACTION_ID) {
      this.menu.openFor({
        actor: active,
        title: this.nameFor(active.id),
        resolveTargets: () => this.combatCandidates(state, active),
        slotCenterFor: this.slotCenterFor,
        // The ◄ ► arrows reflect the free in-phase actor choice (§3.8): the living combatants on
        // your side you can re-anchor onto. >1 ⇒ show them at the category level.
        actorCount: state.combatants.filter((c) => c.factionId === CONTROLLED_FACTION_ID && !isDown(c)).length,
      });
    } else {
      this.menu.close();
    }
  }

  // Resolve the post-action state once any animation window has elapsed: repaint to the new truth (the HP
  // drop lands HERE, at the END of the beat — not at commit), then either exit on a terminal (so the
  // killing blow gets to play first) or open the menu on the new active combatant. Shared by the playback
  // gate in tick, a no-event commit, and an ended phase.
  private settle(): void {
    if (!this.state) return;
    this.repaint();
    if (isTerminal(this.state)) {
      this.onExit();
      return;
    }
    this.openOnActive(this.state);
  }

  // Fold one committed intent into the reducer, then open the action's animation window (§14.2), OR exit.
  // The intent's actor is always the active combatant (the menu only ever opened on it / the auto-driver
  // targets it), satisfying applyCommand's DEV-assert. The reducer advances NOW (it is the source of
  // truth), but the menu reopen + HP repaint are DEFERRED to settle() when the window elapses, so the beat
  // (a tracer crossing, the HP drop landing) has time to read. There is no flee — an encounter is fought to
  // its terminal (side-elimination or mutual disengage, §8.4); a ship can't withdraw once it's in.
  private commit(intent: ActionIntent): void {
    if (!this.state) return;
    const actor = this.state.combatants[this.state.activeId];
    const command = actor ? commandFor(actor, intent.actionId) : undefined;
    const { state, events } = applyCommand(this.state, intent);
    this.state = state;
    // Close the menu so no input lands mid-beat; settle() reopens it on the new active combatant. Fan the
    // action's events into tracer BOLTS (a barrage of `command.count` per `damage` event, §14.4/§14.6). An
    // action with no bolt (a pass, or a self-effect like a shield — §14.6 step 4 gives those their own
    // beats) opens no window and settles at once — only a beat worth watching earns the wait.
    this.menu.close();
    const { bolts, durationMs } = this.buildBolts(events, command);
    if (bolts.length === 0) {
      this.settle();
      return;
    }
    this.tracers.setBolts(bolts);
    this.playback = { startedAt: -1, durationMs };
  }

  // Fan the reducer's events into the renderer's BOLTS. The reducer stays weapon-agnostic: it emits one
  // `damage` event per target (carrying the TOTAL amount) and a `down` when a target falls — so the BARRAGE
  // count + per-weapon look are recovered render-side from the firing command (§14.4/§14.5), never the
  // event stream. Each damage event becomes `count` bolts, staggered in launch time (salvoGapMs) and fanned
  // in launch/impact position; only the last carries the (total) number-pop, and it becomes a destruction
  // burst if a `down` accompanied that target. Returns the bolts + the window duration that fits them all.
  private buildBolts(
    events: readonly EncounterEvent[],
    command: ActionCommand | undefined,
  ): { bolts: readonly Bolt[]; durationMs: number } {
    if (!this.state) return { bolts: [], durationMs: 0 };
    const vfx = vfxForCommand(command);
    const count = Math.min(MAX_BARRAGE, Math.max(1, command?.count ?? 1));
    const downed = new Set<number>();
    for (const e of events) if (e.kind === 'down') downed.add(e.combatId);
    const bolts: Bolt[] = [];
    for (const e of events) {
      if (e.kind !== 'damage') continue;
      const source = this.state.combatants[e.source];
      const target = this.state.combatants[e.target];
      if (!source || !target) continue;
      const mid = (count - 1) / 2;
      for (let i = 0; i < count; i++) {
        const last = i === count - 1;
        bolts.push({
          sourceId: source.id,
          targetId: target.id,
          color: vfx.color,
          startMs: i * vfx.salvoGapMs,
          travelMs: vfx.travelMs,
          impactMs: vfx.impactMs,
          srcDx: 0,
          srcDy: Math.round((i - mid) * SRC_FAN),
          dstDx: ((i * 5) % 7) - 3, // a small deterministic impact scatter (no Math.random in the tick path)
          dstDy: ((i * 3) % 5) - 2,
          popMilli: last ? e.amount : null,
          kill: last && downed.has(e.target),
        });
      }
    }
    const durationMs = bolts.reduce((m, b) => Math.max(m, b.startMs + b.travelMs + b.impactMs), 0);
    return { bolts, durationMs };
  }

  // The player-facing fleet-scoped End Round (§3.8.3): forfeit the CONTROLLED side's remaining initiative
  // and hand the phase over. Only valid on your own phase — an opponent's phase is auto-driven, so a
  // stray key during it is inert. SystemScene routes the End-Round key here.
  endRound(): void {
    if (this.playback) return; // inert mid-beat — the round is paused on the animation window
    if (this.state?.phaseSide !== CONTROLLED_FACTION_ID) return;
    this.endActivePhase();
  }

  // The player's free in-phase actor choice (§3.8): re-anchor the menu (and the active-turn marker) onto
  // another of YOUR ships mid-phase, so you spend your initiative across whichever actors you pick, in any
  // order — not a forced round-robin. ◄ ► steps the ring (neighborActor); SystemScene routes the menu's
  // category-level cycle here in combat. A pure cursor move (no icon); energy + availability still gate
  // each ACTION (the menu greys what a chosen ship can't afford).
  cycleActor(delta: number): void {
    if (!this.canChooseActor()) return;
    const next = neighborActor(this.state!, delta);
    if (next !== undefined) this.reanchor(next);
  }

  // Re-anchor onto a clicked friendly combatant by its durable entity id (a ship id today; a body id once
  // E5 lands). An enemy / downed / off-side pick is rejected by selectActor.
  selectActorByEntityId(entityId: string): void {
    if (!this.canChooseActor()) return;
    const c = this.state!.combatants.find((cc) => cc.id === entityId);
    if (c) this.reanchor(c.combatId);
  }

  // You may choose an actor only on your OWN side's live phase, and not while an action's animation window
  // is playing (the round is paused on the beat).
  private canChooseActor(): boolean {
    return this.state !== null && this.playback === null && this.state.phaseSide === CONTROLLED_FACTION_ID;
  }

  // Move the active cursor to a chosen combatant and re-open on it: repaint so the active-turn marker
  // follows, then re-anchor the menu. selectActor returns the SAME state ref for an illegal/no-op pick, so
  // a stray cycle/click onto the current actor / an enemy / a downed ship changes nothing.
  private reanchor(combatId: number): void {
    if (!this.state) return;
    const next = selectActor(this.state, combatId);
    if (next === this.state) return;
    this.state = next;
    this.repaint();
    this.openOnActive(this.state);
  }

  // End the active side's phase through the reducer (End Round or the auto-pass-on-stranded), then settle.
  // A phase pass deals no damage (its events are at most phaseStart effects not yet animated), so it
  // settles synchronously with no window — the damage beat comes only through commit (§14). Shared by the
  // player's End Round and the opponent auto-driver's stranded pass.
  private endActivePhase(): void {
    if (!this.state) return;
    this.state = endPhase(this.state).state;
    this.settle();
  }

  // Every LIVING combatant as a target candidate, tagged by allegiance to the acting combatant (self =
  // itself, ally = same faction, enemy = other). The menu filters this by the cursored command's
  // TargetCriteria (a laser admits only enemies; a self verb only the actor). A downed combatant is no
  // one's target.
  private combatCandidates(state: EncounterState, active: Combatant): readonly TargetCandidate[] {
    const out: TargetCandidate[] = [];
    for (const c of state.combatants) {
      if (isDown(c)) continue;
      const allegiance: TargetAllegiance = c.id === active.id ? 'self' : c.factionId === active.factionId ? 'ally' : 'enemy';
      out.push({ id: c.id, kind: c.kind, allegiance, tags: [] });
    }
    return out;
  }

  private repaint(): void {
    if (!this.state) return;
    const activeId = this.state.activeId;
    this.paintGauges(this.state.combatants.map((c) => combatantToGauge(c, activeId)));
    this.bar.paint(this.state.combatants, this.state.initiative, this.state.phaseSide, this.contentW);
    this.activePipHome = this.bar.activePipHome(
      this.state.combatants, this.state.initiative, this.state.phaseSide, this.contentW,
    );
    if (this.activePipHome) {
      this.activePip.setColor(factionColor(this.state.phaseSide));
      this.activePip.moveTo(this.activePipHome.left, this.activePipHome.bottom);
    }
    // Recompute the CTA trigger + re-place the button while we hold the fresh state (the only times it
    // moves: state change + resize, both routed through here). tick() then animates from these cached values.
    this.noPlayerActions = !this.controlledHasAnyAction(this.state);
    this.layoutEndTurn();
  }

  // Center the End Turn button horizontally on the field and vertically within the encounter bar band, so
  // it straddles the divider the two fleets face across (the band the bar reserved a center plaza for).
  private layoutEndTurn(): void {
    const left = Math.round(this.contentW / 2 - this.endTurn.width / 2);
    const bottom = Math.round((ENCOUNTER_BAR_HEIGHT - this.endTurn.height) / 2);
    this.endTurn.placeAt(left, bottom);
  }

  // A pointer-DOWN over the encounter bar / its End Turn button. Returns true when consumed, so SystemScene
  // stops — the click never falls through to combatant targeting / the free actor choice. A hit on the End
  // Turn button fires the fleet-scoped End Round (endRound self-guards to the player's own live phase, off-
  // beat); the rest of the band is display-only chrome that simply absorbs the click.
  handleBarPointerDown(x: number, y: number): boolean {
    if (this.endTurn.visible && this.endTurn.bounds.contains(x, y)) {
      this.endRound();
      return true;
    }
    return this.bar.bounds.contains(x, y);
  }

  // A pointer-MOVE over the bar: highlight the End Turn button on hover (SystemScene turns the cursor into
  // a hand when this returns true). A no-op while the button is hidden (opponent phase / mid-beat).
  handleBarPointerMove(x: number, y: number): boolean {
    const over = this.endTurn.visible && this.endTurn.bounds.contains(x, y);
    this.endTurn.setHover(over);
    return over;
  }

  // True when ANY living combatant on the CONTROLLED side has at least one action it can both AFFORD
  // (the energy gate, mirroring the menu's D6 availability) and AIM (a valid target under the command's
  // criteria). When false the player may still hold initiative but can accomplish nothing, so the End Turn
  // button raises its gold CTA blink (the suggested move). A self-target support verb (raise-shields)
  // counts as an available action, so the CTA fires only when there is truly nothing useful left — typically
  // every ship out of salvo energy, awaiting next phase's recharge.
  private controlledHasAnyAction(state: EncounterState): boolean {
    for (const c of state.combatants) {
      if (c.factionId !== CONTROLLED_FACTION_ID || isDown(c)) continue;
      const energy = c.stats?.[ENERGY_STAT] ?? Infinity;
      for (const command of c.commands) {
        if (command.totalCost > energy) continue;
        if (this.hasValidTarget(state, c, command)) return true;
      }
    }
    return false;
  }

  // Whether a command has at least one admissible target from the acting combatant. A 'self' verb always
  // does (the living actor itself); otherwise the grant's TargetCriteria must admit at least one living
  // candidate — the SAME filter the menu applies (filterCandidates), so this availability never drifts from
  // what the player can actually drill.
  private hasValidTarget(state: EncounterState, actor: Combatant, command: ActionCommand): boolean {
    if (command.grant.targeting === 'self') return true;
    return filterCandidates(this.combatCandidates(state, actor), command.grant.targets, actor).length > 0;
  }

  dispose(): void {
    this.bar.dispose();
    this.endTurn.dispose();
    this.activePip.dispose();
    this.tracers.dispose();
  }
}

// Project one combatant onto the flat gauge DTO the persistent ShipGaugesOverlay reads: the HP bar splits
// into the hull band (bottom of the cascade) and the shields stacked above it, the amber gauge reads the
// energy salvo gate, and the two combat marks (active-turn, downed) ride along. The system view feeds the
// SAME overlay each ship's full-charge gauge at rest; combat just supplies the live numbers.
function combatantToGauge(combatant: Combatant, activeId: number): ShipGauge {
  const pools = combatant.pools ?? [];
  const max = pools.reduce((s, p) => s + p.max, 0);
  const hull = pools.find((p) => p.key === HULL_POOL)?.current ?? 0;
  const shields = pools.filter((p) => p.key !== HULL_POOL).reduce((s, p) => s + p.current, 0);
  return {
    id: combatant.id,
    hull,
    shields,
    max,
    energy: combatant.stats?.[ENERGY_STAT] ?? 0,
    energyMax: combatant.stats?.[ENERGY_MAX_STAT] ?? 0,
    hullColor: factionColor(combatant.factionId),
    active: combatant.combatId === activeId,
    down: isDown(combatant),
  };
}
