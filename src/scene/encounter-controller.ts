// EncounterController — the thin scene-side glue that runs an encounter as a MODE on SystemScene. It
// owns the transient EncounterState, its own ortho overlay Scene+camera (the SystemActionMenu
// precedent), and the combat-chrome overlay; SystemScene owns the freeze flag + the sidebar/turn gates
// and drives this from its tick/resize/input. It imports the encounter RULES (createEncounterState /
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

import { OrthographicCamera, Scene, type WebGLRenderer } from 'three';
import { applyCommand, createEncounterState } from '../encounter/step';
import { isTerminal } from '../encounter/terminal';
import { isDown, type Combatant, type EncounterState } from '../encounter/state';
import type { EncounterSpec } from '../encounter/encounter-spec';
import type { ActionIntent, TargetAllegiance, TargetCandidate } from '../actions/types';
import { commandFor } from '../actions/derive';
import { CONTROLLED_FACTION_ID } from '../factions/registry';
import { CombatOverlay } from './encounter-overlay';
import type { SlotCenter, SystemActionMenu } from './actions/system-action-menu';

// Wall-clock pacing for the DEV auto-play (ms between reducer steps) — slow enough to read each hit +
// the HP drain. Render-only timing; it never feeds back into the integer-milli reducer.
const STEP_MS = 800;

export class EncounterController {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);
  private readonly overlay = new CombatOverlay();

  private state: EncounterState | null = null;
  private contentW = 1;
  private bufH = 1;
  private lastStepAt = 0; // 0 = re-arm: the first tick shows the opening state before stepping

  // OFF by default: the live path drives the round from player input via the menu. The DEV demo flips
  // it on to auto-drive the same commit path (so the loop is visible headlessly).
  autoPlay = false;
  // Raised by the controller when the encounter ends (side-elimination or flee); SystemScene wires
  // this to exitEncounter (lower the freeze, re-enable Next Turn).
  onExit: () => void = () => {};

  constructor(
    private readonly slotCenterFor: (id: string) => SlotCenter | null,
    private readonly menu: SystemActionMenu,
    private readonly nameFor: (id: string) => string,
  ) {
    this.overlay.addTo(this.scene);
  }

  get active(): boolean {
    return this.state !== null;
  }

  // Begin the encounter from a launch spec: seed the reducer state, route the menu's confirm sink to
  // this controller, paint the opening roster, and open the menu on the initiator.
  enter(spec: EncounterSpec): void {
    this.state = createEncounterState(spec);
    this.menu.onEncounterCommit = (intent) => this.commit(intent);
    this.menu.setEncounterMode(true);
    this.repaint();
    this.openOnActive(this.state);
  }

  exit(): void {
    this.menu.setEncounterMode(false);
    this.menu.close();
    this.state = null;
    this.overlay.hide();
  }

  resize(contentBufferW: number, bufferH: number): void {
    this.contentW = contentBufferW;
    this.bufH = bufferH;
    this.camera.right = contentBufferW;
    this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    if (this.state) this.repaint();
  }

  // Per-frame: drive the auto-turns on a timer. A CONTROLLED combatant's turn waits for the player's
  // menu input — UNLESS auto-play (the demo) drives it too; an OPPONENT's turn is always auto-driven
  // (no AI yet). Lingers one interval before each auto-step (so the menu/turn reads), and on the
  // terminal state before exiting. The live player loop advances on confirm, not here.
  tick(now: number): void {
    if (!this.state) return;
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
    const intent = this.autoIntent(this.state);
    if (intent) this.commit(intent);
  }

  // The overlay anchors to the live fleet slots, so it must render in the SAME content viewport the
  // diagram does; SystemScene sets that up and calls this between the diagram and the chrome passes.
  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  // Set up the combatant whose turn it is. You command only YOUR side: the anchored menu opens on a
  // CONTROLLED combatant (carrying its own derived loadout + seeded energy gate, its durable id
  // anchoring the panel/bracket, candidates built from the live roster relative to it); an opponent's
  // turn opens NO menu and is auto-driven by tick (a placeholder for the deferred AI, §3.7). Called on
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
      });
    } else {
      this.menu.close();
    }
  }

  // Fold one committed intent into the reducer and re-open on the new active combatant, OR exit. The
  // intent's actor is always the active combatant (the menu only ever opened on it / the auto-driver
  // targets it), satisfying applyCommand's DEV-assert. A NAVIGATION command is flee-to-exit (§5.5) — a
  // controller-level withdrawal, not a reducer step (there is no flee command in the reducer).
  private commit(intent: ActionIntent): void {
    if (!this.state) return;
    const actor = this.state.combatants[this.state.activeId];
    if (actor && commandFor(actor, intent.actionId)?.grant.category === 'navigation') {
      this.onExit();
      return;
    }
    this.state = applyCommand(this.state, intent).state;
    this.repaint();
    if (isTerminal(this.state)) {
      this.onExit();
      return;
    }
    this.openOnActive(this.state);
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

  // A spectator move for the active combatant: its first attack-category command aimed at the first
  // living enemy. Defensive (skips downed, respects category); returns null when no move exists. DEV
  // auto-play only — the live loop produces real intents from the menu.
  private autoIntent(state: EncounterState): ActionIntent | null {
    const actor = state.combatants[state.activeId];
    if (!actor) return null;
    const attack = actor.commands.find((c) => c.grant.category === 'attack');
    if (!attack) return null;
    const enemy = state.combatants.find((c) => c.factionId !== actor.factionId && !isDown(c));
    if (!enemy) return null;
    return { actorId: actor.id, actionId: attack.id, targetIds: [enemy.id] };
  }

  private repaint(): void {
    if (!this.state) return;
    this.overlay.paint(this.state.combatants, this.state.activeId, this.slotCenterFor, this.contentW, this.bufH);
  }

  dispose(): void {
    this.overlay.dispose();
  }
}
