// SystemScene — flat 2D diagram of one star cluster. Peer of StarmapScene;
// AppController swaps which one's tick() loop is driving the shared canvas.
//
// The whole scene is rendered through SystemDiagram (its own ortho scene at
// 1 unit = 1 buffer pixel). No 3D camera, no orbit, no zoom — this view is
// a static screen diagram, not a navigable space. SystemHud sits on top.

import { type WebGLRenderer } from 'three';
import { BODIES, clusterDisplayName, systemIdForCluster } from '../data/stars';
import { addableTypesFor } from '../facilities';
import type { EconomyBridge } from '../facilities/economy-bridge';
import {
  addFacility,
  addFriendlyShip,
  addOpponentBody,
  addOpponentShip,
  buildingShipAtYard,
  facilitiesOnBody,
  getGameState,
  ownerFactionId,
  removeFacility,
  removeShip,
  shipsInSystem,
  startShipBuild,
} from '../game-state';
import { CONTROLLED_FACTION_ID, factionColor, factionLabel } from '../factions/registry';
import { buildTurns, DEFAULT_SHIP_CLASS, shipClassLabel } from '../ships/registry';
import { shipToActor } from '../actions/ships-to-actors';
import { bodyToActor } from '../actions/bodies-to-actors';
import { grantKeyOf } from '../actions/derive';
import { encodeBodyEntityId, parseEntityId } from '../actions/entity-id';
import type { Actor, TargetAllegiance, TargetCandidate } from '../actions/types';
import { SystemActionMenu } from './actions/system-action-menu';
import { EFFECT_HANDLERS } from './actions/effect-handlers';
import { EncounterController } from './encounter-controller';
import { buildEncounterSpec, type EncounterSpec } from '../encounter/encounter-spec';
import { shipsToCombatants } from '../encounter/ships-to-combatants';
import { SystemHud } from '../ui/system-hud';
import { Sidebar } from '../ui/sidebar/sidebar';
import { SystemContext } from '../ui/sidebar/system-context';
import { sizes } from '../ui/theme';
import { SystemDiagram, type DiagramPick } from './system-diagram';
import { picksEqual } from './system-diagram/types';
import { ViewportSizer } from './viewport-sizer';
import type { Screen } from './screen';

export class SystemScene implements Screen {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;

  private readonly diagram: SystemDiagram;
  private readonly hud: SystemHud;
  // The anchored system action menu — a SystemScene-owned chrome layer (its own ortho
  // scene), opened on a ship selection, routed FIRST in the chrome chain. See
  // src/scene/actions/ + src/actions/README.md (the as-built menu).
  private readonly actionMenu = new SystemActionMenu();
  // Persistent sidebar, owned by AppController (shared with the galaxy view).
  // Rendered + input-routed here, but not owned. Consulted before the HUD.
  private readonly sidebar: Sidebar;
  // The live economy, owned by AppController. We reconcile it after a facility
  // edit and read each selected body's standing from it for the sidebar.
  private readonly bridge: EconomyBridge;
  // The cluster this view shows. Retained (not just forwarded to SystemDiagram)
  // so refreshFlows can query the bridge for this system's cargo lanes.
  private readonly clusterIdx: number;
  // The system view's contextual region inside the sidebar (selected body's
  // facilities). Set as the sidebar's active context on start, cleared on dispose.
  private readonly context: SystemContext;
  private readonly viewport = new ViewportSizer(sizes.sidebarW);

  // The encounter MODE (E3/E4): a transient combat reducer + its overlay + the menu-driven round, run
  // in place over this same diagram (no second scene). Anchors its chrome to the live fleet slots via
  // slotCenterForEntity, drives the round through the shared action menu, titles combatants by name.
  private readonly encounter = new EncounterController(
    (id) => this.slotCenterForEntity(id),
    this.actionMenu,
    (id) => this.combatantName(id),
  );
  // True while combat is live. Backs the readonly Screen.freezesTurn (a getter is the only legal
  // backing) AND gates the overlay render + input branch, so the non-combat path is byte-identical
  // when it's down.
  private inEncounter = false;

  private rafId = 0;
  private running = false;

  // Screen.freezesTurn is readonly; back it with the mode flag so a programmatic nextTurn() short-
  // circuits (app-controller.ts) while combat runs on its own clock. The sidebar's Next Turn pill is
  // gated separately (setNextTurnEnabled) for the user-click path — both are raised together on enter.
  get freezesTurn(): boolean {
    return this.inEncounter;
  }

  private readonly _onPointerDown  = (e: PointerEvent) => this.onPointerDown(e);
  private readonly _onPointerMove  = (e: PointerEvent) => this.onPointerMove(e);
  private readonly _onPointerLeave = ()                => this.onPointerLeave();
  private readonly _onKeyDown      = (e: KeyboardEvent) => this.onKeyDown(e);
  private readonly _onResize       = () => this.resize();

  private readonly _hudPt = { x: 0, y: 0 };

  // Touch/pen has no hover, so a tap pins the body card instead. While a
  // pick is pinned the card persists — notably it survives the spurious
  // pointerleave a finger-lift fires — until the next tap re-pins or
  // clears it. Null on mouse, where the card is purely hover-driven.
  private pinnedPick: DiagramPick | null = null;

  // The body the player has selected for facility construction. Distinct from
  // hover (which follows the cursor) and from pinnedPick (the touch tooltip):
  // it persists across pointer moves and drives the sidebar's facilities context.
  // Ephemeral by design — a fresh SystemScene starts with nothing selected;
  // the facilities themselves persist in the game-state store, not here.
  private selectedPick: DiagramPick | null = null;

  // Fired when the user requests to exit the system view (ESC or back
  // button click).
  onExit: () => void = () => {};

  constructor(
    canvas: HTMLCanvasElement,
    renderer: WebGLRenderer,
    clusterIdx: number,
    sidebar: Sidebar,
    bridge: EconomyBridge,
  ) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.sidebar = sidebar;
    this.bridge = bridge;
    this.clusterIdx = clusterIdx;

    this.diagram = new SystemDiagram(clusterIdx);
    this.hud = new SystemHud();
    this.hud.onBack = () => this.onExit();

    // Facilities live in the persistent sidebar's contextual region. The context
    // owns the add/remove callbacks; we mutate game-state then re-push the updated
    // body so the list stays in sync.
    this.context = new SystemContext(clusterDisplayName(clusterIdx));
    this.context.onAddFacility = (bodyId, type) => {
      addFacility(bodyId, type);
      this.bridge.syncFacilities();
      this.pushSelectionToSidebar();
      this.refreshFlows();
      this.diagram.syncFacilities();
    };
    this.context.onRemoveFacility = (facilityId) => {
      removeFacility(facilityId);
      this.bridge.syncFacilities();
      this.pushSelectionToSidebar();
      this.refreshFlows();
      this.diagram.syncFacilities();
    };
    // A ship build carries no economy coupling (the shipyard's contribute is empty),
    // so build/cancel need no bridge/flows reconcile — just persist and re-pull the
    // sidebar. A new ship is 'building' (not in the ready fleet), and a cancel/reap
    // only ever drops a 'building' ship, so the fleet overlay is untouched until a
    // turn completes a build (afterTurnAdvance handles that).
    this.context.onBuildShip = (bodyId) => {
      startShipBuild(bodyId, DEFAULT_SHIP_CLASS, getGameState().turn + buildTurns(DEFAULT_SHIP_CLASS));
      this.pushSelectionToSidebar();
    };
    this.context.onCancelBuild = (shipId) => {
      removeShip(shipId);
      this.pushSelectionToSidebar();
    };
    // DEV-only debug action: drop a ready opponent ship into THIS system. Gated at the
    // wiring site (not just the pill) so the whole debug path — callback + addOpponentShip
    // — tree-shakes out of a production build. Opponent ships are 'ready', so they join
    // the fleet overlay immediately; refresh it to show the new sprite.
    if (import.meta.env.DEV) {
      this.context.onAddOpponentShip = () => {
        addOpponentShip(systemIdForCluster(this.clusterIdx));
        this.refreshFleet();
      };
      // DEV-only: claim the SELECTED body for an opponent by placing an opponent COLONY on it
      // — a colony facility (so it's a real colony, not a bare body) plus an ownership flip,
      // the facility being what claims it. Makes the M3 body-as-target path (an enemy colony
      // to Attack) exercisable before the live capture/colonize verbs exist.
      this.context.onAddOpponentColony = () => {
        const pick = this.selectedPick;
        if (!pick || pick.kind === 'ship' || pick.kind === 'star') return;
        const bodyId = BODIES[pick.bodyIdx]!.id;
        addFacility(bodyId, 'colony'); // no-op at the per-body cap (already has one) — fine
        addOpponentBody(bodyId);       // flip ownership: the colony is now the opponent's
        // Mirror the facility-edit reconcile so the claim lands everywhere: re-project the
        // economy (the ownership gate runs at build() time and now drops this enemy body),
        // redraw chips + lanes, re-sync the menu (an enemy body is no longer a commandable
        // actor, so its menu closes), and refresh the sidebar.
        this.bridge.syncFacilities();
        this.diagram.syncFacilities();
        this.refreshFlows();
        this.syncActionMenu(pick);
        this.pushSelectionToSidebar();
      };
    }

    // The action menu's execute DISPATCH (Menu M2). 'immediate' actions route to an app-side
    // effect handler keyed by GRANT KEY (grantKeyOf(actionId), EFFECT_HANDLERS) that mutates the
    // save now — today a no-op stub, so this is the live ROUTING with deferred mechanics; an
    // immediate verb with no handler (flee/repair/recon) falls through to a DEV log. 'encounter'
    // actions enter the combat MODE on this view (onEnterEncounter → enterEncounter, live now). The
    // menu itself (select → drill → target → confirm) is fully live; this is the seam its intent flows into.
    this.actionMenu.onImmediate = (intent) => {
      const handler = EFFECT_HANDLERS.get(grantKeyOf(intent.actionId));
      if (handler) {
        handler(intent);
        // A real effect mutates helio.game; when one lands it must also kick the
        // facility-edit reconcile chain here so the diagram + economy re-read.
        return;
      }
      if (import.meta.env.DEV) console.debug('[actions] immediate action (no handler):', intent);
    };
    // A confirmed 'encounter'-kind action enters the combat MODE: build the launch spec from this
    // system's ready ships (split by faction) + the launching intent, then run it in place over the
    // same diagram. The DEV opponent-spawn supplies the enemy side until ship movement lands.
    this.actionMenu.onEnterEncounter = (intent) =>
      this.enterEncounter(buildEncounterSpec(shipsToCombatants(this.readyShips()), intent));
    // The reducer reaching a terminal (or a flee) tells the mode to tear down + unfreeze the turn.
    this.encounter.onExit = () => this.exitEncounter();
    // The outer focus axis: ←/→ at the category level cycles the active actor (the menu re-opens
    // on the next ship). The controller routes the key; the actor ring lives here (game-state).
    this.actionMenu.onCycleActor = (delta) => this.cycleActor(delta);

    // DPR boundary crossings (zoom, monitor swap) re-trigger resize so the
    // pixel-ratio + buffer dims pick up the new integer N.
    this.viewport.subscribe(() => {
      if (this.running) this.resize();
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attachListeners();
    this.resize();
    // Make the sidebar show this system's context (persistent turn header stays).
    this.sidebar.setContext(this.context);
    // System-view settings are deferred (the panel's toggles are galaxy-specific);
    // the header glyph is a no-op here for now.
    this.sidebar.onSettings = () => {};
    this.pushSelectionToSidebar();
    // resize() has laid out the diagram (the ships layer has anchors + bounds),
    // so seed the cargo lanes before the first frame.
    this.refreshFlows();
    // Seed the built-ship fleet from the durable store so it shows on open.
    this.refreshFleet();
    // Lanes + layout are now resolved but the pool is empty — prime it to steady-state
    // occupancy so the view opens with traffic already in flight (one-shot; never
    // re-applied on the resizes/turns that re-resolve lanes).
    this.diagram.prime();
    this.tick();
    // DEV visual-test affordance: ?demo-encounter boots straight into a combat overlay. Bare = a
    // spectator (auto-runs the whole fight); =play = playable (your menu opens + waits for input, the
    // opponent auto-acts).
    const demo = new URLSearchParams(location.search);
    if (import.meta.env.DEV && demo.has('demo-encounter')) {
      this.devDemoEncounter(demo.get('demo-encounter') !== 'play');
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.detachListeners();
  }

  // Idempotent — safe to call after stop().
  dispose(): void {
    this.stop();
    // Leaving the view mid-encounter (e.g. the back button) must not leave the SHARED sidebar pill
    // disabled for the galaxy view — unfreeze before tearing down.
    if (this.inEncounter) this.exitEncounter();
    // Detach this scene's context so the (shared, AppController-owned) sidebar
    // doesn't paint a disposed context once the galaxy view resumes.
    this.sidebar.setContext(null);
    this.diagram.dispose();
    this.hud.dispose();
    this.actionMenu.dispose();
    this.encounter.dispose();
    this.viewport.dispose();
  }

  // -- encounter mode (E3) ----------------------------------------------

  // Enter combat as a MODE on this view: freeze the galaxy turn (BOTH gates — the pill for the user
  // click, the freezesTurn flag for the programmatic path), drop the live-view menu, and hand the spec
  // to the controller. The system view keeps rendering; combat composites on top. Re-entry while
  // already in an encounter is ignored.
  private enterEncounter(spec: EncounterSpec): void {
    if (this.inEncounter) return;
    this.inEncounter = true;
    this.actionMenu.close();
    this.sidebar.setNextTurnEnabled(false);
    this.encounter.enter(spec);
  }

  // Tear the mode down: lower the freeze flags and clear the overlay. The encounter ran within one
  // galaxy turn, so selection + primed cargo are exactly as they were — nothing to restore.
  private exitEncounter(): void {
    if (!this.inEncounter) return;
    this.inEncounter = false;
    this.encounter.exit();
    this.sidebar.setNextTurnEnabled(true);
  }

  // DEV-only: boot straight into a demo encounter (the ?demo-encounter URL path) — seed a friendly +
  // an opponent ready ship if this system lacks a two-side matchup, refresh the fleet so both carry
  // live slots, then launch from the friendly's first attack at the foe. A visual-test affordance for
  // iterating on the combat chrome; tree-shaken from prod.
  private devDemoEncounter(autoPlay: boolean): void {
    const systemId = systemIdForCluster(this.clusterIdx);
    if (!this.readyShips().some((s) => s.factionId === CONTROLLED_FACTION_ID)) addFriendlyShip(systemId);
    if (!this.readyShips().some((s) => s.factionId !== CONTROLLED_FACTION_ID)) addOpponentShip(systemId);
    this.refreshFleet();
    const ships = this.readyShips();
    const mine = ships.find((s) => s.factionId === CONTROLLED_FACTION_ID);
    const foe = ships.find((s) => s.factionId !== CONTROLLED_FACTION_ID);
    if (!mine || !foe) return;
    const attack = shipToActor(mine).commands.find((c) => c.grant.category === 'attack');
    if (!attack) return;
    // Spectator demo auto-drives the player's side too (the playable demo leaves it to real input).
    this.encounter.autoPlay = autoPlay;
    this.enterEncounter(buildEncounterSpec(shipsToCombatants(ships), { actorId: mine.id, actionId: attack.id, targetIds: [foe.id] }));
  }

  // -- listeners --------------------------------------------------------

  private attachListeners(): void {
    this.canvas.addEventListener('pointerdown',  this._onPointerDown);
    this.canvas.addEventListener('pointermove',  this._onPointerMove);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('resize',  this._onResize);
  }

  private detachListeners(): void {
    this.canvas.removeEventListener('pointerdown',  this._onPointerDown);
    this.canvas.removeEventListener('pointermove',  this._onPointerMove);
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('resize',  this._onResize);
  }

  private onPointerDown(e: PointerEvent): void {
    // Route to the sidebar, then the HUD (back button), before the diagram. The
    // diagram is static — no drag/orbit fallback — so a pointerdown that misses
    // chrome is a clean click on the diagram.
    this.viewport.clientToHud(e.clientX, e.clientY, this._hudPt);
    if (this.sidebar.handleClick(this._hudPt.x, this._hudPt.y)) return;
    if (this.hud.handleClick(this._hudPt.x, this._hudPt.y)) return;
    // The open action menu claims clicks ahead of the diagram (drill / fire / absorb).
    if (this.actionMenu.handleClick(this._hudPt.x, this._hudPt.y)) return;
    // In combat, a click that missed chrome does NOT pick/select the diagram (combat owns the field).
    // E4 routes a click on an enemy combatant to the menu's target lock via handleClick above.
    if (this.inEncounter) return;

    // A click on the diagram (or empty space): pick under it (null over chrome).
    const hit = this.pickAt(this._hudPt.x, this._hudPt.y);

    // Persistent facility selection (mouse + touch): select an eligible body,
    // or clear when the pick isn't one (star / ring / empty space).
    this.select(hit);

    // Touch/pen has no hover, so a tap also stands in for it: pin the body
    // card. A tap on empty space (or chrome) pins null, which dismisses it;
    // re-tapping the pinned body toggles it back off. Mouse keeps its
    // hover-driven card and never pins.
    if (e.pointerType !== 'mouse') {
      const pinned = picksEqual(hit, this.pinnedPick) ? null : hit;
      this.pinnedPick = pinned;
      this.diagram.setHovered(pinned);
      this.hud.setHoveredBody(pinned, this._hudPt.x, this._hudPt.y);
    }
  }

  // Update the persistent selection. A ship is always selectable; a body only if it can
  // host at least one facility — a star, a ring, or empty space clears it, so the
  // sidebar shows either a ship card, a buildable body's facilities, or nothing.
  private select(pick: DiagramPick | null): void {
    const next = this.isSelectable(pick) ? pick : null;
    if (picksEqual(next, this.selectedPick)) return;
    this.selectedPick = next;
    this.diagram.setSelected(next);
    this.syncActionMenu(next);
    this.pushSelectionToSidebar();
  }

  // Open the anchored action menu when a commandable actor is selected, close it otherwise.
  // A CONTROLLED fleet SHIP and a CONTROLLED facility-bearing BODY are actors (the neutral ship /
  // body adapters give each its commands); the menu anchors to the entity's live on-screen
  // center (ship slot or body disc, re-read each place so it tracks resizes / self-closes if
  // the entity vanishes). Only the controlled side is commandable; an opponent ship or an
  // enemy/empty body is inspected via the sidebar, never commanded.
  private syncActionMenu(pick: DiagramPick | null): void {
    const actor = pick ? this.actorForPick(pick) : null;
    if (!actor) {
      this.actionMenu.close();
      return;
    }
    // The candidate set is minted ONCE per open (the actor is fixed): all ready ships + all
    // facility-bearing / enemy bodies in this system, each tagged with its allegiance to the
    // actor. The menu applies each def's TargetCriteria to this flat list, so ships-as-targets
    // and bodies-as-targets fall out of one pass (Attack ⇒ enemies; a self verb ⇒ the actor).
    const candidates = this.targetCandidatesFor(actor);
    this.actionMenu.openFor({
      actor: actor.actor,
      title: actor.title,
      resolveTargets: () => candidates,
      slotCenterFor: (id) => this.slotCenterForEntity(id),
    });
  }

  // Resolve a pick into a commandable actor (+ its display title and owning faction), or null
  // if it can't be commanded. Only the CONTROLLED faction's entities are commandable: an
  // opponent ship — like an enemy or bare body — returns null, inspected via the sidebar card
  // but never opening a menu (it stays a bracketable TARGET when you command one of your own).
  // A body additionally needs its facilities to grant ≥1 command.
  private actorForPick(pick: DiagramPick): { actor: Actor; title: string; factionId: string } | null {
    if (pick.kind === 'ship') {
      const ship = this.readyShips().find((s) => s.id === pick.shipId);
      if (!ship || ship.factionId !== CONTROLLED_FACTION_ID) return null;
      return { actor: shipToActor(ship), title: ship.name, factionId: ship.factionId };
    }
    if (pick.kind === 'star') return null;
    const body = BODIES[pick.bodyIdx];
    if (!body) return null;
    const factionId = ownerFactionId(body.id);
    if (factionId !== CONTROLLED_FACTION_ID) return null;
    const actor = bodyToActor({ bodyIdx: pick.bodyIdx, factionId, facilities: facilitiesOnBody(body.id) });
    return actor.commands.length > 0 ? { actor, title: body.name, factionId } : null;
  }

  // Mint every targetable entity in this system as a rich TargetCandidate, each with its
  // allegiance to the acting actor (self = the actor itself, ally = same faction, enemy =
  // other). Tags are an open set the criteria predicates read (body kind + facility types).
  // Returns the FULL set; the menu filters it by the cursored command's TargetCriteria.
  private targetCandidatesFor(actor: { actor: Actor; factionId: string }): readonly TargetCandidate[] {
    const allegiance = (faction: string, id: string): TargetAllegiance =>
      id === actor.actor.id ? 'self' : faction === actor.factionId ? 'ally' : 'enemy';
    const out: TargetCandidate[] = [];
    for (const s of this.readyShips()) {
      out.push({ id: s.id, kind: 'ship', allegiance: allegiance(s.factionId, s.id), tags: [] });
    }
    for (const bodyIdx of this.diagram.laidOutBodyIndices()) {
      const body = BODIES[bodyIdx];
      if (!body) continue;
      const facilities = facilitiesOnBody(body.id);
      const owner = ownerFactionId(body.id);
      // A bare, player-owned rock is no one's target; facility-bearing or enemy bodies are.
      if (facilities.length === 0 && owner === CONTROLLED_FACTION_ID) continue;
      const id = encodeBodyEntityId(bodyIdx);
      out.push({ id, kind: 'body', allegiance: allegiance(owner, id), tags: [body.kind, ...facilities.map((f) => f.type)] });
    }
    return out;
  }

  // The live on-screen center of any entity id (content-buffer px) — the action menu's anchor
  // + target-bracket seam, dispatched by id namespace (body ⇒ disc center, ship ⇒ fleet slot).
  private slotCenterForEntity(id: string): { cx: number; cy: number; r: number } | null {
    const ref = parseEntityId(id);
    return ref.kind === 'body' ? this.diagram.bodyCenter(ref.bodyIdx) : this.diagram.fleetSlotCenter(ref.shipId);
  }

  // This system's ready ships (the actor + ship-candidate source). Pre-filtered to 'ready'
  // (building ships aren't in the field), keyed by the stable system handle.
  private readyShips() {
    return shipsInSystem(systemIdForCluster(this.clusterIdx)).filter((s) => s.status === 'ready');
  }

  // The display name for a combatant's durable id — its ship's name, the combat menu's title line. A
  // body combatant's name lands with E5; an unknown id falls back to the id itself.
  private combatantName(id: string): string {
    return shipsInSystem(systemIdForCluster(this.clusterIdx)).find((s) => s.id === id)?.name ?? id;
  }

  // The actor focus ring — the controlled faction's commandable actors in this system: ready
  // SHIPS first, then facility-commandable BODIES (ships-first keeps the ←/→ "my side" cycle
  // legible). Clicking one of these directly opens its menu; the keyboard ←/→ walks the same
  // ring (opponents are never in it). A body with no commands is not in it.
  private commandableActorIds(): readonly string[] {
    const ships = this.readyShips().filter((s) => s.factionId === CONTROLLED_FACTION_ID).map((s) => s.id);
    const bodies: string[] = [];
    for (const bodyIdx of this.diagram.laidOutBodyIndices()) {
      const body = BODIES[bodyIdx];
      if (!body || ownerFactionId(body.id) !== CONTROLLED_FACTION_ID) continue;
      const actor = bodyToActor({ bodyIdx, factionId: CONTROLLED_FACTION_ID, facilities: facilitiesOnBody(body.id) });
      if (actor.commands.length > 0) bodies.push(actor.id);
    }
    return [...ships, ...bodies];
  }

  // The entity id of the current selection when it is an actor-shaped pick (ship or body),
  // else null — so cycleActor can locate the selection within the ring across both kinds.
  private selectedActorId(): string | null {
    const p = this.selectedPick;
    if (!p || p.kind === 'star') return null;
    return p.kind === 'ship' ? p.shipId : encodeBodyEntityId(p.bodyIdx);
  }

  // Cycle the focused actor by delta (the category-level ←/→ of an open menu). Steps within the
  // ring of your commandable actors, wrapping. The menu only opens on one of yours, so the
  // current pick is normally already in the ring; the jump-to-an-end is a defensive fallback.
  // Re-selecting re-opens the menu.
  private cycleActor(delta: number): void {
    // In combat the active combatant is fixed by turn order — ←/→ at the category level must NOT jump
    // to a live-view actor (it cycles the target at the command level, which the menu handles itself).
    if (this.inEncounter) return;
    const ring = this.commandableActorIds();
    if (ring.length === 0) return;
    const current = this.selectedActorId();
    const idx = current !== null ? ring.indexOf(current) : -1;
    const from = idx >= 0 ? idx : (delta > 0 ? -1 : 0); // not in the ring → enter at an end
    const next = ring[((from + delta) % ring.length + ring.length) % ring.length]!;
    this.select(this.pickForActorId(next));
  }

  // Map an actor entity id back to its DiagramPick (the selection currency). A body id resolves
  // its precise kind (planet/moon/belt) from the catalog — the codec returns only the coarse
  // body/bodyIdx, so the precise kind is looked up here.
  private pickForActorId(id: string): DiagramPick {
    const ref = parseEntityId(id);
    if (ref.kind === 'ship') return { kind: 'ship', shipId: ref.shipId };
    return { kind: BODIES[ref.bodyIdx]!.kind, bodyIdx: ref.bodyIdx };
  }

  // A pick is selectable if it's a ship, or a facility-eligible body. Body eligibility
  // stays the registry's call (addableTypesFor with no existing facilities = "can host
  // any type at all"), not an inline kind check, so it tracks the defs as types are
  // added or their predicates diverge.
  private isSelectable(pick: DiagramPick | null): boolean {
    if (!pick) return false;
    if (pick.kind === 'ship') return true;
    if (pick.kind === 'star') return false;
    const body = BODIES[pick.bodyIdx];
    return !!body && addableTypesFor(body, []).length > 0;
  }

  // Push the selected body (with its current facilities, read fresh from the
  // game-state store) into the sidebar's system context. Called on every selection
  // change and after each add/remove so the list stays in sync.
  private pushSelectionToSidebar(): void {
    const pick = this.selectedPick;
    // A selected ship → the sidebar's read-only ship card. Resolve it from the durable
    // store (only 'ready' ships render, so a picked ship is always present + 'ready').
    if (pick && pick.kind === 'ship') {
      const ship = shipsInSystem(systemIdForCluster(this.clusterIdx)).find((s) => s.id === pick.shipId);
      this.context.setShip(
        ship
          ? {
              name: ship.name,
              classLabel: shipClassLabel(ship.classId),
              factionLabel: factionLabel(ship.factionId),
              factionColor: factionColor(ship.factionId),
              status: ship.status,
            }
          : null,
      );
      this.sidebar.refreshContent();
      return;
    }
    if (!pick || pick.kind === 'star') {
      this.context.setBody(null);
      this.sidebar.refreshContent();
      return;
    }
    const body = BODIES[pick.bodyIdx]!;
    const facilities = facilitiesOnBody(body.id);
    // The yard's one in-flight build (if any) → the sidebar's in-progress readout.
    // turnsLeft is derived from the absolute completesOnTurn, never stored.
    const inProgress = buildingShipAtYard(body.id);
    this.context.setBody({
      bodyId: body.id,
      name: body.name,
      kind: body.kind,
      facilities,
      addableTypes: addableTypesFor(body, facilities),
      economy: this.bridge.bodyEconomy(body.id),
      build: inProgress
        ? {
            shipId: inProgress.id,
            classLabel: shipClassLabel(inProgress.classId),
            // A 'building' ship always carries completesOnTurn; the ?? only satisfies
            // the optional type (it falls back to a 1-turn readout, never throws).
            turnsLeft: Math.max(1, (inProgress.completesOnTurn ?? getGameState().turn) - getGameState().turn),
          }
        : null,
    });
    this.sidebar.refreshContent();
  }

  // Re-read the selected body's economy after the sim steps (Next Turn), so the
  // sidebar's stock/flow numbers reflect the turn just processed.
  afterTurnAdvance(): void {
    this.pushSelectionToSidebar();
    this.refreshFlows();
    // A build that completed this turn (stepShipBuilds ran just before this in
    // AppController.nextTurn) joins the fleet now.
    this.refreshFleet();
  }

  // Push this cluster's cargo lanes into the diagram's ships overlay. Fired from
  // the same sites as pushSelectionToSidebar — start, Next Turn, and facility
  // edits. Draws the SPECULATIVE next-turn lanes (the cargo the economy is about
  // to dispatch), so a new provider's ships and a relieved deficit show the
  // instant an edit lands, and the stream never blanks out across an edit.
  private refreshFlows(): void {
    this.diagram.setFlows(this.bridge.predictedClusterFlows(this.clusterIdx));
  }

  // Push this system's READY ships into the fleet overlay. The fleet is system-keyed
  // (ships are peers of planets, never tied to a body), so resolve the system handle
  // from the cluster and filter the durable store to 'ready'. Fired on open and on
  // Next Turn (a completed build joins the fleet) — NOT on build/cancel/reap, which
  // only ever touch 'building' ships, which aren't in the fleet.
  private refreshFleet(): void {
    const systemId = systemIdForCluster(this.clusterIdx);
    this.diagram.syncFleet(shipsInSystem(systemId).filter((s) => s.status === 'ready'));
    // The fleet just relaid out (slots may have moved or a ship may be gone); re-place the
    // open menu against the fresh slots, or let it self-close if its ship vanished.
    this.actionMenu.refreshAnchor();
  }

  private onPointerMove(e: PointerEvent): void {
    // Touch/pen drives the card by tap (see onPointerDown), so a finger
    // drag must not move/clear the pinned card — only mouse hovers.
    if (e.pointerType !== 'mouse') return;
    this.viewport.clientToHud(e.clientX, e.clientY, this._hudPt);
    const onSidebar = this.sidebar.handlePointerMove(this._hudPt.x, this._hudPt.y);
    const onButton = this.hud.handlePointerMove(this._hudPt.x, this._hudPt.y);
    const onMenu = this.actionMenu.handlePointerMove(this._hudPt.x, this._hudPt.y);
    const pick = this.pickAt(this._hudPt.x, this._hudPt.y);
    this.diagram.setHovered(pick);
    this.hud.setHoveredBody(pick, this._hudPt.x, this._hudPt.y);
    // A ship has no hover rim or info card yet, so the pointer cursor is its hover
    // affordance — the cue that it's clickable. Bodies rely on their rim + card instead.
    this.canvas.style.cursor = (onSidebar || onButton || onMenu || pick?.kind === 'ship') ? 'pointer' : '';
  }

  // Pick the disc under a HUD-space point, skipping the picker when the
  // point is over any interactive HUD chrome (back button) so a tooltip
  // can't appear under the chrome the user is aiming at.
  private pickAt(bufX: number, bufY: number): DiagramPick | null {
    const overChrome = this.sidebar.hitTest(bufX, bufY) !== 'transparent'
      || this.hud.hitTest(bufX, bufY) !== 'transparent'
      || this.actionMenu.hitTest(bufX, bufY) !== 'transparent';
    return overChrome ? null : this.diagram.pickAt(bufX, bufY);
  }

  private onPointerLeave(): void {
    // A tap-pinned card (touch/pen) must survive the spurious
    // pointerleave a finger-lift fires; only a mouse leaving the canvas
    // clears the transient hover state so it doesn't linger on stale
    // state when the cursor comes back.
    if (this.pinnedPick) return;
    this.diagram.setHovered(null);
    this.hud.setHoveredBody(null, 0, 0);
  }

  private onKeyDown(e: KeyboardEvent): void {
    // The open action menu claims arrows / Enter / ← and a drilled-in Escape (back out one
    // level). Escape at the menu's top level is NOT claimed, so it falls through to clear
    // the selection (which closes the menu) — one Escape per level, then one to deselect.
    if (this.actionMenu.handleKey(e)) return;
    // Combat owns input while the mode is live: an Esc not claimed by a drilled combat menu flees
    // (tears the mode down); 'R' ends the controlled side's Press-Turn phase (the fleet-scoped End
    // Round, §3.8.3 — inert on the opponent's auto-driven phase); every other key is inert (no
    // live-view selection/menu mid-fight). E4's combat menu claims its drill/target/confirm keys via
    // handleKey above, before this catch-all.
    if (this.inEncounter) {
      if (e.key === 'Escape') this.exitEncounter();
      else if (e.key.toLowerCase() === 'r') this.encounter.endRound();
      return;
    }
    // Keyboard-first actor focus: a directional tap while no menu is open — nothing selected,
    // or a non-commandable pick being inspected (an opponent ship, a bare buildable body) —
    // enters the commandable-actor ring and opens the first actor's menu, so an order is
    // issuable mouse-free. When one of YOUR actors is selected its menu is open and already
    // claimed the key above.
    if (!this.actionMenu.isOpen && isDirectionalKey(e)) {
      const ring = this.commandableActorIds();
      if (ring.length > 0) {
        this.select(this.pickForActorId(ring[0]!));
        return;
      }
    }
    if (e.key !== 'Escape') return;
    // Escape clears a body selection first; a second press (nothing selected)
    // exits the system view.
    if (this.selectedPick) {
      this.select(null);
      return;
    }
    this.onExit();
  }

  // -- resize / render --------------------------------------------------

  private resize(): void {
    // ViewportSizer.apply does the load-bearing integer-multiple-of-N snap +
    // pushes the new dims into every pixel-snapped material's uViewport —
    // including the diagram's planet/moon material via makePlanetMaterial.
    this.viewport.apply(this.renderer);
    // Diagram lays out + renders in the content rect (left of the reserved sidebar
    // strip); the HUD spans the full buffer.
    this.diagram.resize(this.viewport.contentBufferW, this.viewport.bufferH);
    this.hud.resize(this.viewport.bufferW, this.viewport.bufferH);
    this.sidebar.resize(this.viewport.bufferW, this.viewport.bufferH);
    // Full-buffer camera so the menu's content-buffer anchor coords land correctly; it
    // clamps itself to the content width (left of the sidebar strip) and re-reads the
    // ship's slot center, so a resize re-anchors it for free.
    this.actionMenu.resize(this.viewport.bufferW, this.viewport.bufferH, this.viewport.contentBufferW);
    // The combat overlay anchors to the diagram's content-buffer slot centers, so it shares the
    // diagram's content dims (NOT the full buffer the menu/hud use).
    this.encounter.resize(this.viewport.contentBufferW, this.viewport.bufferH);
  }

  private tick = (): void => {
    if (!this.running) return;
    const now = performance.now();
    // The encounter mode advances its own clock (the E3 spectator auto-play) before the render — it
    // may reach a terminal and exit here (lowering inEncounter), so the overlay pass below self-gates.
    if (this.inEncounter) this.encounter.tick(now);
    // Advance the cargo-ship overlay before rendering — the system view's only
    // per-frame animation. Everything else in the diagram is static layout.
    this.diagram.update(now);
    // One full-buffer clear (the reserved sidebar strip stays clear-color), then
    // the diagram clipped to the content rect so its pixel-snapped body materials
    // line up with the content-width uViewport; the HUD spans the full buffer.
    const { cssW, cssH, contentCssW } = this.viewport;
    this.renderer.autoClear = false;
    this.renderer.clear();
    this.renderer.setViewport(0, 0, contentCssW, cssH);
    this.renderer.setScissor(0, 0, contentCssW, cssH);
    this.renderer.setScissorTest(true);
    this.renderer.render(this.diagram.scene, this.diagram.camera);
    // Combat chrome composites over the diagram in the SAME content viewport/scissor (its slot anchors
    // are content-buffer coords). Gated so the non-combat render path is byte-identical.
    if (this.inEncounter) this.encounter.render(this.renderer);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, cssW, cssH);
    this.renderer.render(this.hud.scene, this.hud.camera);
    // The anchored action menu composites over the diagram + hud (its own full-buffer ortho
    // scene), under the sidebar which it never overlaps (clamped to the content width).
    this.renderer.render(this.actionMenu.scene, this.actionMenu.camera);
    this.renderer.render(this.sidebar.scene, this.sidebar.camera);
    this.renderer.autoClear = true;
    this.rafId = requestAnimationFrame(this.tick);
  };
}

// The directional keys that drive actor focus from idle — arrows + WASD (the same set the menu's
// own navigation uses), so any nav tap on an empty system view jumps into your fleet.
const DIRECTIONAL_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd']);
function isDirectionalKey(e: KeyboardEvent): boolean {
  return DIRECTIONAL_KEYS.has(e.key.toLowerCase());
}
