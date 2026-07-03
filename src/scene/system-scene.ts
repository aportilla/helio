// SystemScene — flat 2D diagram of one star cluster. Peer of StarmapScene;
// AppController swaps which one's tick() loop is driving the shared canvas.
//
// The whole scene is rendered through SystemDiagram (its own ortho scene at
// 1 unit = 1 buffer pixel). No 3D camera, no orbit, no zoom — this view is
// a static screen diagram, not a navigable space. SystemHud sits on top.

import { type WebGLRenderer } from 'three';
import { BODIES, clusterDisplayName, clusterDistanceMilliLy, clusterIndexForSystemId, clustersWithinRangeMilliLy, systemIdForCluster } from '../data/stars';
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
  transitsFor,
} from '../game-state';
import type { ArrivalEvent, Ship } from '../game-state';
import { CONTROLLED_FACTION_ID, factionColor, factionLabel } from '../factions/registry';
import { DEMO_SHIP_LOADOUT, shipBuildTurns, shipEnergyMax, shipWarpRangeMilliLy, warpTravelTurns } from '../ships/components/registry';
import { shipToActor } from '../actions/ships-to-actors';
import { bodyToActor } from '../actions/bodies-to-actors';
import { grantKeyOf } from '../actions/derive';
import { encodeBodyEntityId, encodeSystemEntityId, parseEntityId } from '../actions/entity-id';
import type { Actor, TargetAllegiance, TargetCandidate } from '../actions/types';
import { SystemActionMenu } from './actions/system-action-menu';
import type { DepartureRequest } from './departure';
import { EFFECT_HANDLERS } from './actions/effect-handlers';
import { EncounterController } from './encounter-controller';
import { ShipGaugesOverlay, type ShipGauge } from './ship-gauges';
import { TargetingVisuals } from './targeting-visuals';
import { ENCOUNTER_BAR_HEIGHT } from '../ui/encounter-hud';
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

  // Per-sprite HP + energy gauges — a PERSISTENT part of the ship rendering (shown at rest, not just in
  // combat). SystemScene owns + renders it in the content scissor: at rest it paints each ready ship's
  // full charge (loadout-derived), and during an encounter the controller feeds it the live combatant
  // values through the paintGauges sink below — one renderer, two data sources.
  private readonly shipGauges = new ShipGaugesOverlay();
  // The encounter MODE (E3/E4): a transient combat reducer + the menu-driven round + its combat chrome
  // (bar / tracers), run in place over this same diagram (no second scene). Anchors its chrome to the
  // live fleet slots via slotCenterForEntity, drives the round through the shared action menu, titles
  // combatants by name, and FEEDS the persistent shipGauges overlay the live combatant values.
  private readonly encounter = new EncounterController(
    (id) => this.slotCenterForEntity(id),
    this.actionMenu,
    (id) => this.combatantName(id),
    (gauges) => this.shipGauges.paint(gauges, (id) => this.slotCenterForEntity(id)),
  );
  // In-field targeting FX keyed to the action menu's focus depth (engine glow / weapon-primed glow /
  // target line + reticle). Anchors through the same slot seam as the menu + combat chrome, and
  // composites in the content scissor right after the diagram. Driven by actionMenu.focusState().
  private readonly targeting = new TargetingVisuals(
    (id) => this.slotCenterForEntity(id),
    (id, componentId) => this.moduleAnchorFor(id, componentId),
  );
  // A warp-OUT to trigger on this scene's first frames — set only when AppController re-enters the origin
  // system right after a confirmed departure (the departed ship's id). The ship is an outbound GAP berth by
  // now, so FleetLayer flies its real muster sprite off that berth. Fired + cleared once in start().
  private warpOutHint?: { shipId: string };
  // DEV-only ?demo-warp=loop interval handle, cleared on stop(). Undefined in normal play + prod.
  private warpDemoTimer?: ReturnType<typeof setInterval>;
  // True while combat is live. Backs the readonly Screen.freezesTurn (a getter is the only legal
  // backing) AND gates the overlay render + input branch, so the non-combat path is byte-identical
  // when it's down.
  private inEncounter = false;
  // True while the encounter bar is showing a PRE-COMBAT preview — raised when the action menu drills
  // past its root ('category') level, dropped when it backs out / closes, and never while a real
  // encounter owns the bar. Gates the same overlay tick + render branch as `inEncounter`.
  private previewingBar = false;

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

  // Fired when the player arms WARP DRIVE — carries a fully-formed DepartureRequest (ship + origin + reach +
  // reachable destinations). AppController drives the system→galaxy destination pick from here.
  onBeginDeparture: (req: DepartureRequest) => void = () => {};

  constructor(
    canvas: HTMLCanvasElement,
    renderer: WebGLRenderer,
    clusterIdx: number,
    sidebar: Sidebar,
    bridge: EconomyBridge,
    // Optional: a warp-OUT to trigger on mount (AppController hands it in when re-entering the origin after a
    // confirmed departure). Trailing + optional so the galaxy/test enter paths + the DEV demo are unchanged.
    warpOutHint?: { shipId: string },
  ) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.sidebar = sidebar;
    this.bridge = bridge;
    this.clusterIdx = clusterIdx;
    this.warpOutHint = warpOutHint;

    this.diagram = new SystemDiagram(clusterIdx);
    // ALWAYS reserve the bottom encounter-bar band in the fleet muster layout — even outside combat,
    // where the bar isn't drawn. Reserving it permanently (not on encounter entry) is what keeps the
    // ship formation from reflowing when combat begins/ends: the slots are computed once, bar-aware.
    this.diagram.setFleetBottomReserve(ENCOUNTER_BAR_HEIGHT);
    // A finished warp re-reads the roster (an out-ship becomes a clean gap, an in-ship a settled sprite) and
    // repaints gauges (a landed ship regains its bar).
    this.diagram.onFleetWarpComplete = () => this.refreshFleet();
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
      // No loadout builder yet → a built ship gets the shared default kit; build time is the Σ of its
      // modules' buildTurns (shipBuildTurns), the per-ship successor to the old per-class cost.
      startShipBuild(bodyId, DEMO_SHIP_LOADOUT, getGameState().turn + shipBuildTurns(DEMO_SHIP_LOADOUT));
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
    // immediate verb with no handler (repair/recon) falls through to a DEV log. 'encounter'
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
    // The reducer reaching a terminal tells the mode to tear down + unfreeze the turn (there is no flee).
    this.encounter.onExit = () => this.exitEncounter();
    // Movement: arming WARP DRIVE hands off to the galaxy destination pick instead of drilling. Build the
    // full DepartureRequest here (this scene alone knows the ship's origin + drive) and pass it up; the
    // reachable set + per-destination distance/ETA are precomputed so the mode reads no game state.
    this.actionMenu.onBeginDestinationPick = (actorId, actionId) => {
      const ship = this.readyShips().find((s) => s.id === actorId);
      if (!ship) return;
      const originClusterIdx = clusterIndexForSystemId(ship.systemId);
      if (originClusterIdx < 0) return;
      const rangeMilliLy = shipWarpRangeMilliLy(ship.components);
      const reachable = clustersWithinRangeMilliLy(originClusterIdx, rangeMilliLy)
        .map((clusterIdx) => {
          const distanceMilli = clusterDistanceMilliLy(originClusterIdx, clusterIdx);
          return { clusterIdx, systemId: systemIdForCluster(clusterIdx), distanceMilli, etaTurns: warpTravelTurns(distanceMilli, ship.components) };
        })
        .sort((a, b) => a.distanceMilli - b.distanceMilli); // nearest first — the pre-lock takes [0]
      this.onBeginDeparture({ shipId: ship.id, shipName: ship.name, actionId, originClusterIdx, rangeMilliLy, reachable });
    };
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
    this.refreshTransits();
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
    // If AppController re-entered this system right after a confirmed departure, fly the departed ship's
    // sprite off its (now-vacated) berth. Registered BEFORE the first tick so it renders in-flight from
    // frame one (no gap flash). Fires once (the hint is cleared inside).
    this.emitPendingWarpOut();
    this.tick();
    // DEV visual-test affordance: ?demo-encounter boots straight into a combat overlay. Bare = a
    // spectator (auto-runs the whole fight); =play = playable (your menu opens + waits for input, the
    // opponent auto-acts).
    const demo = new URLSearchParams(location.search);
    if (import.meta.env.DEV && demo.has('demo-encounter')) {
      this.devDemoEncounter(demo.get('demo-encounter') !== 'play');
    }
    if (import.meta.env.DEV && demo.has('demo-warp')) {
      this.devDemoWarp(demo.get('demo-warp'));
    }
  }

  // DEV-only: exercise the warp fly-off/in reproducibly (?demo-warp[=in|out|loop]). Tree-shaken from prod.
  //   bare  — seed a friendly ready ship + open its menu on the WARP DRIVE root row (the departure chrome).
  //   =out  — fly that ship's real sprite off its slot (the warp-OUT motion), no galaxy round-trip.
  //   =in   — fly it in from off-screen onto its slot (the warp-IN motion).
  //   =loop — alternate out/in on an interval so a warp is always mid-flight for a screenshot.
  private devDemoWarp(mode: string | null): void {
    const systemId = systemIdForCluster(this.clusterIdx);
    // Seed a few friendly ships so the gap-left-behind (no back-fill) reads: one warps, the others hold.
    while (this.readyShips().filter((s) => s.factionId === CONTROLLED_FACTION_ID).length < 3) addFriendlyShip(systemId);
    this.refreshFleet();
    const mine = this.readyShips().find((s) => s.factionId === CONTROLLED_FACTION_ID);
    if (!mine) return;
    // Fire a warp on the demo ship and drop its at-rest gauge for the flight (it's a ready ship here, so
    // unlike a real transit its gauge would otherwise linger at the vacated berth).
    const warp = (kind: 'out' | 'in'): void => {
      if (kind === 'out') this.diagram.startFleetWarpOut(mine.id, performance.now());
      else this.diagram.startFleetWarpIn(mine.id, performance.now());
      this.repaintShipGauges();
    };
    if (mode === 'out') { warp('out'); return; }
    if (mode === 'in') { warp('in'); return; }
    if (mode === 'loop') {
      // Alternate out/in a touch over the warp duration, so a warp is (almost) always mid-flight for a
      // screenshot (fire once immediately so there's no initial dead frame).
      let out = true;
      const step = (): void => { warp(out ? 'out' : 'in'); out = !out; };
      step();
      this.warpDemoTimer = setInterval(step, 520);
      return;
    }
    this.select({ kind: 'ship', shipId: mine.id });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.warpDemoTimer !== undefined) clearInterval(this.warpDemoTimer);
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
    this.shipGauges.dispose();
    this.encounter.dispose();
    this.targeting.dispose();
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
    // No leaving the system view mid-fight: an encounter runs to its terminal (no flee), so the back
    // button greys out alongside Next Turn until the mode tears down.
    this.hud.setBackEnabled(false);
    // The fleet formation already clears the bottom encounter-bar band — it's reserved permanently at
    // setup (see the constructor), so entering combat reflows nothing.
    this.encounter.enter(spec);
  }

  // Tear the mode down: lower the freeze flags and clear the overlay. The encounter ran within one
  // galaxy turn, so selection + primed cargo are exactly as they were — nothing to restore.
  private exitEncounter(): void {
    if (!this.inEncounter) return;
    this.inEncounter = false;
    this.encounter.exit();
    // The fleet's bottom reserve is permanent (set at construction), so there's nothing to restore —
    // leaving combat reflows nothing either.
    this.sidebar.setNextTurnEnabled(true);
    this.hud.setBackEnabled(true);
    // Combat left the gauges holding the final combatant values; restore the at-rest (full charge)
    // readout so they persist as part of the ship rendering instead of freezing on the last frame.
    this.repaintShipGauges();
  }

  // Raise/drop the pre-combat encounter-bar PREVIEW from the action menu's drill depth: it appears the
  // moment the player commits to picking an action (drills PAST the root 'category' level) and retracts if
  // they back all the way out / close the menu without entering combat. Suppressed while a real encounter
  // owns the bar. Polled each tick (cheap), so it catches every drill/back path — key, click, or close.
  private updatePreview(): void {
    const level = this.actionMenu.currentLevel();
    const want = !this.inEncounter && level !== null && level !== 'category';
    if (want === this.previewingBar) return;
    this.previewingBar = want;
    if (want) this.encounter.showPreview(shipsToCombatants(this.readyShips()).flatMap((s) => s.combatants));
    else this.encounter.hidePreview();
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
    // In combat, a click that missed chrome re-anchors onto a clicked FRIENDLY combatant — the free actor
    // choice (§3.8). An enemy click was already claimed by the menu's target lock (handleClick above); a
    // click on anything else is absorbed (combat owns the field — no diagram selection).
    if (this.inEncounter) {
      // The encounter bar absorbs clicks on its band, and its End Turn button fires the fleet-scoped End
      // Round — both handled before targeting so neither falls through to combatant targeting / the free
      // actor choice.
      if (this.encounter.handleBarPointerDown(this._hudPt.x, this._hudPt.y)) return;
      const pick = this.pickAt(this._hudPt.x, this._hudPt.y);
      if (pick?.kind === 'ship') this.encounter.selectActorByEntityId(pick.shipId);
      return;
    }

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
    // A system-space command (WARP DRIVE) targets the GALAXY, not this system — so it gets a SEPARATE
    // reachable-cluster snapshot; every in-system verb gets the untouched local set (zero pollution of
    // the in-system candidate model). Minted once per open, like the local set, so canFire's per-frame
    // greying never re-scans the catalog.
    const warpDestinations = this.warpDestinationsFor(actor.actor.id);
    this.actionMenu.openFor({
      actor: actor.actor,
      title: actor.title,
      resolveTargets: (command) => (command.grant.targetSpace === 'system' ? warpDestinations : candidates),
      slotCenterFor: (id) => this.slotCenterForEntity(id),
      // The focus ring size drives the ◄ ► actor-switch arrows: only worth showing when there's
      // more than one of your ships/bodies to cycle through.
      actorCount: this.commandableActorIds().length,
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
    // Only RENDERED ships are candidates: readyShips() returns every ready ship in the system, but the
    // fleet layer draws (and pick-anchors) at most MAX_FLEET_SPRITES. An unrendered overflow ship has no
    // slotCenterFor anchor — as a target it would be keyboard-lockable with no reticle, so filter it out.
    const rendered = new Set(this.diagram.renderedFleetShipIds());
    for (const s of this.readyShips()) {
      if (!rendered.has(s.id)) continue;
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

  // The reachable-cluster snapshot for a ship's WARP DRIVE — every system within the ship's drive range,
  // as neutral 'system' candidates (id in the sys: namespace, the ORIGIN excluded). This one set both
  // greys the WARP DRIVE row (zero reachable ⇒ canFire false) and, once the departure mode lands, lights
  // the galaxy range ring, so the menu and the pick can never disagree. Empty for a non-ship actor or a
  // driveless ship (range 0), which greys the row — exactly the in-encounter grey, too (no origin there).
  private warpDestinationsFor(actorId: string): readonly TargetCandidate[] {
    const ship = this.readyShips().find((s) => s.id === actorId);
    if (!ship) return [];
    const range = shipWarpRangeMilliLy(ship.components);
    if (range <= 0) return [];
    const originIdx = clusterIndexForSystemId(ship.systemId);
    if (originIdx < 0) return [];
    return clustersWithinRangeMilliLy(originIdx, range).map((idx) => ({
      id: encodeSystemEntityId(systemIdForCluster(idx)),
      kind: 'system' as const,
      allegiance: 'neutral' as const,
      tags: [],
    }));
  }

  // The live on-screen center of any entity id (content-buffer px) — the action menu's anchor
  // + target-bracket seam, dispatched by id namespace (body ⇒ disc center, ship ⇒ fleet slot).
  private slotCenterForEntity(id: string): { cx: number; cy: number; r: number } | null {
    const ref = parseEntityId(id);
    if (ref.kind === 'body') return this.diagram.bodyCenter(ref.bodyIdx);
    if (ref.kind === 'ship') return this.diagram.fleetSlotCenter(ref.shipId);
    return null; // a 'system' (warp destination) lives in galaxy space — no in-scene slot to anchor
  }

  // The on-screen center of an actor's MODULE (content-buffer px) — the firing weapon's rect, for the
  // targeting-visuals weapon glow. Ships only; a body weapon has no module rect (null ⇒ the glow falls
  // back to the hull front).
  private moduleAnchorFor(id: string, componentId: string): { cx: number; cy: number; r: number } | null {
    const ref = parseEntityId(id);
    return ref.kind === 'ship' ? this.diagram.fleetModuleCenter(ref.shipId, componentId) : null;
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
    // Filter to RENDERED ships (the MAX_FLEET_SPRITES-sliced subset): an unrendered overflow ship has no
    // slot anchor, so opening its menu via the ring would self-close. Twin of the target-candidate filter.
    const rendered = new Set(this.diagram.renderedFleetShipIds());
    const ships = this.readyShips().filter((s) => s.factionId === CONTROLLED_FACTION_ID && rendered.has(s.id)).map((s) => s.id);
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
    // In combat the ←/→ category-level cycle re-anchors onto another of YOUR combatants — the free
    // in-phase actor choice (§3.8), handled by the encounter controller. (At the target level ←/→
    // cycle the locked TARGET itself, never reaching here.)
    if (this.inEncounter) { this.encounter.cycleActor(delta); return; }
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
    if (ref.kind === 'body') return { kind: BODIES[ref.bodyIdx]!.kind, bodyIdx: ref.bodyIdx };
    // A 'system' id names a warp destination, which is a TARGET, never an actor — so it never reaches
    // the actor-pick path. Loud on the contract violation rather than minting a bogus pick.
    throw new Error(`[system-scene] pickForActorId received a non-actor entity id: ${id}`);
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
            name: inProgress.name,
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
  afterTurnAdvance(arrivals: readonly ArrivalEvent[] = []): void {
    // Ships that left or arrived this turn (stepShipTransits ran just before this in AppController.nextTurn)
    // update the TRANSITS block; an arrival also re-musters the fleet below.
    this.refreshTransits();
    this.pushSelectionToSidebar();
    this.refreshFlows();
    // A build that completed this turn (stepShipBuilds ran just before this in
    // AppController.nextTurn) joins the fleet now. This also lays out every arrived ship at its (previously
    // reserved) berth, so the warp-in flies into a settled spot.
    this.refreshFleet();
    // Ships that arrived in THIS system this turn fly into the berth refreshFleet just laid out for them —
    // its slot was already reserved while the ship was inbound, so nothing reflows. ArrivalEvent.systemId is
    // the DESTINATION, so the filter drops an arrival into any other cluster (silent).
    const now = performance.now();
    const here = systemIdForCluster(this.clusterIdx);
    for (const a of arrivals) if (a.systemId === here) this.diagram.startFleetWarpIn(a.shipId, now);
    // Suppress the just-arrived ships' at-rest gauges while they fly in (the bar would float at the empty berth).
    this.repaintShipGauges();
  }

  // Rebuild the sidebar's TRANSITS block from the durable store: outbound ships (leaving this system) as
  // "<ship> → <dest> · T-n", inbound ships (arriving here) as "◄ <ship> · T-n". The T-n countdown is
  // DERIVED from arrivesOnTurn − turn (never a stored decrement — the same replay-safety as a build's
  // turns-left). Pushed on open and each turn; the block is omitted when there are no transits.
  private refreshTransits(): void {
    const systemId = systemIdForCluster(this.clusterIdx);
    const turn = getGameState().turn;
    const { outbound, inbound } = transitsFor(systemId);
    const lines: string[] = [];
    // ASCII arrows only — the bitmap font carries no →/◄ glyph (the menu's ► pointer is a drawn sprite).
    for (const s of outbound) {
      const destIdx = s.destinationSystemId !== undefined ? clusterIndexForSystemId(s.destinationSystemId) : -1;
      const destName = destIdx >= 0 ? clusterDisplayName(destIdx) : (s.destinationSystemId ?? '?');
      lines.push(`${s.name} -> ${destName} · T-${Math.max(0, (s.arrivesOnTurn ?? turn) - turn)}`);
    }
    for (const s of inbound) {
      lines.push(`<- ${s.name} · T-${Math.max(0, (s.arrivesOnTurn ?? turn) - turn)}`);
    }
    this.context.setTransits(lines);
  }

  // Push this cluster's cargo lanes into the diagram's ships overlay. Fired from
  // the same sites as pushSelectionToSidebar — start, Next Turn, and facility
  // edits. Draws the SPECULATIVE next-turn lanes (the cargo the economy is about
  // to dispatch), so a new provider's ships and a relieved deficit show the
  // instant an edit lands, and the stream never blanks out across an edit.
  private refreshFlows(): void {
    this.diagram.setFlows(this.bridge.predictedClusterFlows(this.clusterIdx));
  }

  // Push this system's formation ROSTER into the fleet overlay. The fleet is system-keyed (ships are peers
  // of planets, never tied to a body). Berths = READY ships (drawn) + INBOUND ships (arriving here — a
  // reserved gap they warp into) + OUTBOUND ships (departed from here, still in transit — a vacated gap): a
  // warp in/out re-categorizes a ship without changing the roster, so the other berths never move (no
  // reflow); a stable id order pins each berth's position. Fired on open and on Next Turn.
  private refreshFleet(): void {
    const systemId = systemIdForCluster(this.clusterIdx);
    const ready = shipsInSystem(systemId).filter((s) => s.status === 'ready');
    const { inbound, outbound } = transitsFor(systemId);
    const berths = [...ready, ...inbound, ...outbound]
      .map((s) => ({ shipId: s.id, factionId: s.factionId, components: s.components, render: s.status === 'ready' }))
      .sort((a, b) => (a.shipId < b.shipId ? -1 : a.shipId > b.shipId ? 1 : 0));
    this.diagram.syncFleet(berths);
    // The fleet just relaid out (slots may have moved or a ship may be gone); re-place the
    // open menu against the fresh slots, or let it self-close if its ship vanished.
    this.actionMenu.refreshAnchor();
    // The gauge set tracks the fleet — a new/removed ship adds/drops a bar (a no-op mid-encounter,
    // where the controller owns the gauge data; refreshFleet only runs at rest / on Next Turn anyway).
    this.repaintShipGauges();
  }

  // Repaint the at-rest per-ship gauges: every settled ready ship's FULL hull + charge (loadout-derived),
  // anchored to its live slot. A ship mid-warp is skipped — its sprite is in flight, so a bar at its berth
  // would float over empty space. A no-op during an encounter — there the controller feeds the SAME overlay
  // the live combatant values (depleted hull, raised shields, the active-turn marker) through its sink.
  private repaintShipGauges(): void {
    if (this.inEncounter) return;
    this.shipGauges.paint(
      this.readyShips().filter((s) => !this.diagram.isFleetShipWarping(s.id)).map(restShipGauge),
      (id) => this.slotCenterForEntity(id),
    );
  }

  // Trigger the warp-OUT for a ship that just left this system (AppController re-entered origin after the
  // player confirmed its warp). By now the ship is an outbound GAP berth, so FleetLayer flies its real
  // muster sprite off that berth. Fires once (the hint is cleared here so a resize / re-entry never re-fires).
  private emitPendingWarpOut(): void {
    const hint = this.warpOutHint;
    if (!hint) return;
    this.warpOutHint = undefined;
    this.diagram.startFleetWarpOut(hint.shipId, performance.now());
  }

  private onPointerMove(e: PointerEvent): void {
    // Touch/pen drives the card by tap (see onPointerDown), so a finger
    // drag must not move/clear the pinned card — only mouse hovers.
    if (e.pointerType !== 'mouse') return;
    this.viewport.clientToHud(e.clientX, e.clientY, this._hudPt);
    const onSidebar = this.sidebar.handlePointerMove(this._hudPt.x, this._hudPt.y);
    const onButton = this.hud.handlePointerMove(this._hudPt.x, this._hudPt.y);
    const onMenu = this.actionMenu.handlePointerMove(this._hudPt.x, this._hudPt.y);
    // In combat, the encounter bar's End Turn button highlights on hover (and takes the pointer cursor).
    const onEndTurn = this.inEncounter && this.encounter.handleBarPointerMove(this._hudPt.x, this._hudPt.y);
    const pick = this.pickAt(this._hudPt.x, this._hudPt.y);
    this.diagram.setHovered(pick);
    this.hud.setHoveredBody(pick, this._hudPt.x, this._hudPt.y);
    // A ship has no hover rim or info card yet, so the pointer cursor is its hover
    // affordance — the cue that it's clickable. Bodies rely on their rim + card instead.
    this.canvas.style.cursor = (onSidebar || onButton || onMenu || onEndTurn || pick?.kind === 'ship') ? 'pointer' : '';
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
    // Combat owns input while the mode is live (the combat menu claimed its drill / target / confirm keys
    // via handleKey above, before this catch-all):
    if (this.inEncounter) {
      // 'R' ends the controlled side's Press-Turn phase (the fleet-scoped End Round, §3.8.3). There is no
      // flee: an encounter runs to its terminal (side-elimination or mutual disengage), so Escape does NOT
      // bail out — at the menu's top level it is simply inert (a drilled-in Escape was already consumed by
      // the menu's back-out above). Every other key is inert mid-fight.
      if (e.key.toLowerCase() === 'r') this.encounter.endRound();
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
    // The persistent ship gauges anchor to the diagram's content-buffer slot centers (NOT the full
    // buffer the menu/hud use), so they share the diagram's content dims.
    this.shipGauges.resize(this.viewport.contentBufferW, this.viewport.bufferH);
    this.hud.resize(this.viewport.bufferW, this.viewport.bufferH);
    this.sidebar.resize(this.viewport.bufferW, this.viewport.bufferH);
    // Full-buffer camera so the menu's content-buffer anchor coords land correctly; it
    // clamps itself to the content width (left of the sidebar strip) and re-reads the
    // ship's slot center, so a resize re-anchors it for free.
    this.actionMenu.resize(this.viewport.bufferW, this.viewport.bufferH, this.viewport.contentBufferW);
    // The encounter chrome shares the diagram's content dims (NOT the full buffer the menu/hud use):
    // its tracers anchor to the diagram's content-buffer slot centers, and the bottom bar spans the
    // content width.
    this.encounter.resize(this.viewport.contentBufferW, this.viewport.bufferH);
    // Same content-buffer space as the diagram/combat chrome — the targeting FX anchor to slot centers.
    this.targeting.resize(this.viewport.contentBufferW, this.viewport.bufferH);
    // Re-anchor the at-rest gauges to the re-laid-out slots (a no-op mid-encounter, where the controller
    // owns the gauge data — it repaints them through encounter.resize above).
    this.repaintShipGauges();
  }

  private tick = (): void => {
    if (!this.running) return;
    const now = performance.now();
    // Raise/drop the pre-combat bar preview from the action-menu drill depth (no-op while in combat).
    this.updatePreview();
    // The encounter mode advances its own clock (the E3 spectator auto-play) before the render — it
    // may reach a terminal and exit here (lowering inEncounter), so the overlay pass below self-gates.
    // The bar's pre-combat preview shares this tick + render branch (it only shimmers the frontier pip).
    if (this.inEncounter || this.previewingBar) this.encounter.tick(now);
    // Advance the cargo-ship overlay before rendering — the system view's only
    // per-frame animation. Everything else in the diagram is static layout.
    this.diagram.update(now);
    // Bounce the action menu's selection pointer (a no-op while the menu is closed).
    this.actionMenu.tick(now);
    // Targeting FX follow the menu's focus depth: engine glow on the focused actor, then a weapon-
    // primed glow + aim line + reticle once a weapon is armed at the target level. Null focus (menu
    // closed) hides them — Esc walking the menu back reverts the states for free.
    this.targeting.setFocus(this.actionMenu.focusState());
    this.targeting.tick(now);
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
    // The per-sprite HP / energy gauges sit just over the diagram (at-rest charge, or live combatant
    // values during an encounter), under the combat tracers + targeting FX that later passes paint.
    this.shipGauges.render(this.renderer);
    // Combat chrome composites over the diagram in the SAME content viewport/scissor (its slot anchors
    // are content-buffer coords). Gated so the non-combat render path is byte-identical.
    if (this.inEncounter || this.previewingBar) this.encounter.render(this.renderer);
    // Targeting FX paint over the diagram + combat chrome, still inside the content scissor so the
    // aim line can't bleed onto the sidebar strip. Self-gates to a cleared/hidden quad when no actor
    // is focused, so the idle path stays cheap.
    this.targeting.render(this.renderer);
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

// One ready ship → its AT-REST gauge: a full hull bar (hull === max, no shields raised) and a full
// energy charge (energy === energyMax = Σ the loadout's batteries). The bar widths are fixed, so this
// reads as a "ship at rest, fully charged" baseline for every ship; an encounter then feeds the SAME
// overlay the live combatant values. The hull band takes the owning faction's color (player vs rival).
function restShipGauge(ship: Ship): ShipGauge {
  const energyMax = shipEnergyMax(ship.components);
  return {
    id: ship.id,
    hull: 1,
    shields: 0,
    max: 1,
    energy: energyMax,
    energyMax,
    hullColor: factionColor(ship.factionId),
    active: false,
    down: false,
  };
}

// The directional keys that drive actor focus from idle — arrows + WASD (the same set the menu's
// own navigation uses), so any nav tap on an empty system view jumps into your fleet.
const DIRECTIONAL_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd']);
function isDirectionalKey(e: KeyboardEvent): boolean {
  return DIRECTIONAL_KEYS.has(e.key.toLowerCase());
}
