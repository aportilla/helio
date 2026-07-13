import {
  type Intersection,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import { ClusterBrackets } from './cluster-brackets';
import { Grid } from './grid';
import { RangeRing } from './range-ring';
import { RouteLine } from './route-line';
import { TransitLines, type TransitView } from './transit-lines';
import { Droplines } from './droplines';
import { FocusMarker } from './focus-marker';
import { InputController, type InputHandlers } from './input-controller';
import { Labels } from './labels';
import { StarPoints } from './stars';
import {
  resolveCandidateCluster, dimAmountForOrbit,
} from './selection-policy';
import { ViewportSizer } from './viewport-sizer';
import { MapHud } from '../ui/map-hud';
import { Sidebar } from '../ui/sidebar/sidebar';
import { GalaxyContext } from '../ui/sidebar/galaxy-context';
import { DepartureBanner } from '../ui/departure-banner';
import { sizes } from '../ui/theme';
import { STARS, STAR_CLUSTERS, clusterIndexFor, clusterIndexForSystemId, nearestClusterIdxTo, systemIdForCluster } from '../data/stars';
import { MILLI_PER_LY } from '../data/cluster-geometry';
import { CONTROLLED_FACTION_ID, factionColor } from '../factions/registry';
import { getGameState, orderShipWarp } from '../game-state';
import { buildDepartureRequest, type DepartureRequest } from './departure';
import { getSettings } from '../settings';
import type { Screen } from './screen';

// Orbit radius bounds (camera-to-target ly). Under perspective, distance
// directly drives apparent size of objects at the focus.
const ZOOM_MIN = 4;
const ZOOM_MAX = 150;
const FOV_DEG = 45;
const NEAR = 0.1;
const FAR = 1000;
const DEFAULT_VIEW = { distance: 30, yaw: 1.1, pitch: 1.2 };

// Focus animation: only view.target lerps; yaw/pitch/distance stay frozen so
// the camera glides over to the new orbital pivot rather than swinging.
const FOCUS_ANIM_MS = 400;

// WASD/QE keyboard fly. Pan rate scales with view.distance so the visual
// movement speed stays consistent at any zoom level (zoom in → smaller world
// step per second, but the same screen-space rate). QE orbit is in radians
// per second.
const PAN_RATE_PER_DISTANCE = 0.5;
const ORBIT_RATE_RAD = 1.5;
// Pointer-drag orbit sensitivity: radians of yaw/pitch per CSS pixel of drag.
// Shared by single-finger drag and two-finger pan-mode orbit so swapping the
// gesture assignment doesn't change how fast the camera spins.
const ORBIT_SENSITIVITY_RAD_PER_PX = 0.005;
// Autospin yaw step per tick — the session-only "Auto-rotate" fidget.
const AUTOSPIN_RAD_PER_TICK = 0.0015;
// Clamp per-frame dt so a stalled tab or breakpoint resume doesn't hurl the
// camera across the scene on the next frame.
const MAX_TICK_DT_MS = 100;

interface ViewState {
  target: Vector3;
  distance: number;  // orbit radius (camera-to-target ly)
  yaw: number;
  pitch: number;
  spin: boolean;
}

export class StarmapScene implements Screen {
  private readonly renderer: WebGLRenderer;
  private readonly camera: PerspectiveCamera;
  private readonly scene = new Scene();
  private readonly view: ViewState;
  private readonly raycaster = new Raycaster();
  private readonly grid: Grid;
  private readonly droplines: Droplines;
  private readonly focusMarker: FocusMarker;
  private readonly labels: Labels;
  // Yellow corner-bracket indicators around clusters. Two instances render
  // simultaneously into the labels overlay scene: arms-style for the active
  // selection, dots-style for the candidate (hovered cluster, or nearest
  // to view.target when the user has panned off the selected cluster —
  // spacebar switches selection to the candidate).
  private readonly selectionBrackets: ClusterBrackets;
  private readonly candidateBrackets: ClusterBrackets;
  private readonly starPoints: StarPoints;
  private readonly hud: MapHud;
  // Persistent right sidebar, owned by AppController and shared with the system
  // view. The scene renders + resizes + input-routes it but does not own its
  // lifecycle. Consulted before the HUD so it intercepts clicks in its strip.
  private readonly sidebar: Sidebar;
  // The galaxy view's contextual region inside the sidebar (the game-views menu when
  // idle / the selected system's ship list). Set as the sidebar's context on start();
  // fed the selection via setCluster.
  private readonly galaxyContext = new GalaxyContext();
  // The data-driven range ring drawn around a ship's origin while picking a warp destination — a sibling
  // of the (suppressed) selection grid, so the pick shows exactly one ring.
  private readonly rangeRing = new RangeRing();
  // The galaxy-view overlay for ships in warp — a dotted origin→destination line + a faction-coloured
  // progress head per transit. Rebuilt on galaxy resume + each turn.
  private readonly transitLines = new TransitLines();
  // The thick GOLD "proposed route" line drawn from origin to the locked destination during a warp pick.
  // Shown/updated as the pick locks a destination, cleared on unlock/teardown.
  private readonly routeLine = new RouteLine();
  // The floating on-map overlay shown while the departure pick is armed: "Select a destination" until a
  // system is locked, then its distance + ETA, with CONFIRM / CANCEL pills. A HUD layer that floats over
  // the stars (no layout reserve) — the sidebar keeps showing the fleet list with the departing ship lit.
  private readonly departureBanner = new DepartureBanner();
  private readonly input: InputController;

  // The live warp DEPARTURE pick, or null in the normal galaxy view. Set by beginShipDeparture() when the
  // player clicks a ready ship in the sidebar fleet list, read by the input handlers + freezesTurn to
  // reroute while it's live. The single source for "am I picking a warp destination right now". The pick
  // is entirely a galaxy modality now — confirm/cancel restore the selection in place (no view swap).
  private departure: DepartureRequest | null = null;
  // The locked destination cluster in the pick, or -1 while browsing. Rides the selection brackets.
  private departureLockClusterIdx = -1;
  // The reachable-destination cluster set (+ origin) for the picking ship — gates the click-to-lock and the
  // in-range shader lens. Empty in the normal view.
  private reachableClusterSet = new Set<number>();

  // Hover-pointer state, written by the input controller via the
  // onPointerHoverChanged handler and read each tick. Drives the per-tick
  // raycast that feeds the candidate computation (hover beats focus-
  // proximity for which cluster gets the yellow label + dot brackets) and
  // the droplines hover-override. Touch input and mouse-over-HUD set
  // has=false so chrome occlusion doesn't leak through to scene picking.
  private readonly pointer = { x: 0, y: 0, has: false };
  // Currently-selected cluster, mirrored across Labels (yellow text +
  // fade-bypass), selectionBrackets (corner-arms reticle), MapHud (info
  // card + View System button), and Droplines (selected pin). Scene tracks
  // its own copy so non-routing logic — spacebar focus, future keyboard
  // actions on the selection — can read it without coupling to any one of
  // those owners' internals.
  private selectedClusterIdx = -1;
  // Candidate cluster — hovered cluster (priority), else nearest cluster
  // COM to view.target gated to "panned far enough off the selection that
  // another cluster is now closer". Written each tick, read by
  // onFocusCandidate (spacebar) to switch selection to it. -1 when no
  // candidate is currently shown. F ignores this — it always re-focuses
  // the current selection.
  private candidateClusterIdx = -1;

  // Focus animation: view.target lerps from focusFrom → focusTo over
  // FOCUS_ANIM_MS. view.distance also lerps from distanceFrom → distanceTo
  // so re-focusing onto a star already nearer than the orbit radius pulls
  // in instead of pushing the camera out to that radius. Yaw/pitch stay
  // frozen so the look direction is preserved through the glide.
  private readonly focusFrom = new Vector3();
  private readonly focusTo = new Vector3();
  private distanceFrom = 0;
  private distanceTo = 0;
  private focusAnimStart = 0;
  private focusAnimating = false;

  private rafId = 0;
  private running = false;
  // One-shot timer that auto-selects Sol shortly after start() so the grid's
  // staged expand choreography fires on first paint as a startup beat.
  // Cleared in stop() and skipped if the user has already selected by then.
  private autoSelectTimer: number | null = null;

  // Fired when the user requests the system view for a cluster — either
  // by clicking the "View System" button in the sidebar footer or by double-
  // clicking a star. AppController wires this to enterSystem().
  onViewSystem: (clusterIdx: number) => void = () => {};

  // Routes the galaxy HUD's test-view trigger up to AppController, peer of
  // onViewSystem. Takes no args — the test grid is self-contained.
  onViewTest: () => void = () => {};

  // Routes the settings panel's "Reset game state" action up to AppController (which owns the game + sim
  // saves) — the scene stays a view: it fires intent, the app layer wipes + reloads. No-op until wired.
  onResetGame: () => void = () => {};

  private readonly _onResize = () => this.resize();

  // Reusable per-frame scratch.
  private readonly _ndc  = new Vector2();
  private readonly _forward = new Vector3();
  private readonly _right   = new Vector3();
  private readonly _step    = new Vector3();
  // Used to hand a Vector3-shaped COM to subsystems (Grid.setSelection)
  // whose APIs expect a Vector3 — STAR_CLUSTERS[i].com is a plain {x,y,z}.
  private readonly _comScratch = new Vector3();
  // Reused raycast result target — pickStar runs every tick the pointer is
  // over the canvas, so the hits array is cleared and refilled in place
  // rather than letting intersectObject allocate a fresh array per call.
  private readonly _hits: Intersection[] = [];
  private static readonly WORLD_UP = new Vector3(0, 0, 1);

  private lastTickMs = 0;

  // Owns the integer-multiple-of-N buffer snap + the cached css/buffer dims.
  // All pixel-aware shader work reads viewport.bufferW/H (NOT
  // window.innerWidth/Height — the buffer is smaller than CSS px once
  // pixelRatio drops below 1); pointer math reads viewport.cssW/H (up to N-1
  // physical px less than the window after the rounding) so hovers register
  // across the whole canvas.
  private readonly viewport = new ViewportSizer(sizes.sidebarW);

  // Renderer is owned by AppController and shared across view modes.
  // Pixel ratio + size are still driven from this scene's resize() (see
  // resize() for the integer-multiple-of-N rounding that guarantees a
  // clean nearest-neighbor upscale).
  constructor(canvas: HTMLCanvasElement, renderer: WebGLRenderer, sidebar: Sidebar) {
    this.renderer = renderer;
    this.sidebar = sidebar;
    const sun = STARS.find(s => s.id === 'sol')!;
    this.view = {
      target: new Vector3(sun.x, sun.y, sun.z),
      ...DEFAULT_VIEW,
      spin: false,
    };

    // PerspectiveCamera. Drop-lines now converge toward a vanishing point —
    // an intentional break with the old ortho "parallel pin" geometry, in
    // exchange for honest 3D depth cueing.
    this.camera = new PerspectiveCamera(FOV_DEG, 1, NEAR, FAR);

    this.raycaster.params.Points = { threshold: 0.6 };

    // Grid (rings + axes + arrow) is selection-driven and owns its own
    // sequential expand/collapse animation; scene only feeds it the active
    // cluster's COM via setSelection(). It starts with no active frame, so
    // nothing is drawn until the first selection lands.
    this.grid = new Grid();
    this.scene.add(this.grid.group);
    // The warp range ring shares the 3D scene (world-space, like the grid); hidden until the pick arms.
    this.scene.add(this.rangeRing.group);
    // Transit lines share the 3D scene too (world-space origin→destination legs), floated over the field.
    this.scene.add(this.transitLines.group);
    // The proposed-route gold line shares the scene as well (only visible mid-pick, depthTest off).
    this.scene.add(this.routeLine.group);

    this.starPoints = new StarPoints(window.innerHeight / 2);
    this.scene.add(this.starPoints.points);

    const initialSettings = getSettings();
    this.droplines = new Droplines(initialSettings.showDroplines);
    this.scene.add(this.droplines.group);

    this.focusMarker = new FocusMarker();
    this.scene.add(this.focusMarker.group);

    this.labels = new Labels(initialSettings.showLabels);

    // Brackets render in the labels overlay scene (1 unit = 1 buffer pixel
    // ortho pass) so they share the labels' projection setup.
    this.selectionBrackets = new ClusterBrackets('arms');
    this.candidateBrackets = new ClusterBrackets('dots');
    this.labels.scene.add(this.selectionBrackets.mesh);
    this.labels.scene.add(this.candidateBrackets.mesh);

    this.hud = new MapHud(this.viewport.scale);
    this.hud.onToggle = (id, on) => {
      if (id === 'labels') this.labels.setShowLabels(on);
      else if (id === 'drops') this.droplines.setMasterVisible(on);
      else if (id === 'spin') this.view.spin = on;
    };
    // Resolution preference (and any future settings that affect render
    // pipeline state) reach the scene via this callback. Resize re-reads
    // getSettings() and re-applies the buffer size.
    this.hud.onSettingsChanged = () => this.resize();
    this.hud.onAction = (id) => {
      if (id === 'reset') {
        // Snap reset: animating target while distance/yaw/pitch jump would
        // jolt the camera. Keep reset feeling like a hard cut.
        this.view.target.set(sun.x, sun.y, sun.z);
        this.view.distance = DEFAULT_VIEW.distance;
        this.view.yaw = DEFAULT_VIEW.yaw;
        this.view.pitch = DEFAULT_VIEW.pitch;
        this.focusAnimating = false;
        // Reset returns to the default (non-spinning) view, so clear the
        // autospin fidget and sync the panel checkbox to match.
        this.view.spin = false;
        this.hud.setToggleState('spin', false);
      } else if (id === 'resetGameState') {
        this.onResetGame();
      }
    };
    this.hud.onViewTest = () => this.onViewTest();

    // The galaxy sidebar's footer nav actions: View System / Deselect when a system is
    // selected, zoom in/out when idle (a manual zoom cancels any in-flight focus glide,
    // like the wheel path). Clicking a ready ship row opens its warp destination pick —
    // the galaxy-only entry point for star-to-star navigation (no system-view path).
    this.galaxyContext.onViewSystem = (idx) => this.onViewSystem(idx);
    this.galaxyContext.onDeselect = () => this.deselect();
    this.galaxyContext.onZoomIn = () => { this.focusAnimating = false; this.setZoom(this.view.distance * 0.8); };
    this.galaxyContext.onZoomOut = () => { this.focusAnimating = false; this.setZoom(this.view.distance / 0.8); };
    this.galaxyContext.onSelectShip = (shipId) => this.beginShipDeparture(shipId);

    // The on-map departure banner's pills — the click twins of Enter (confirm) / Esc (cancel).
    this.departureBanner.onConfirm = () => this.departureConfirm();
    this.departureBanner.onCancel = () => this.departureCancel();

    this.input = new InputController(canvas, this.buildInputHandlers());

    // Re-resize whenever DPR crosses an integer-N boundary (browser zoom,
    // monitor swap, OS scale change). resize() reads the current auto N
    // from the viewport sizer and applies the user's resolution preference;
    // the HUD's Resolution radio also rebuilds its disable states off
    // the new auto value.
    this.viewport.subscribe((scale) => {
      this.hud.setAutoScale(scale);
      this.resize();
    });
  }

  // -- public API --------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('resize', this._onResize);
    this.input.start();
    this.resize();
    // Show the galaxy context on the persistent sidebar (turn header stays); the
    // current selection survives a system-view round-trip on the singleton scene.
    this.galaxyContext.setCluster(this.selectedClusterIdx);
    this.sidebar.setContext(this.galaxyContext);
    // The sidebar's settings glyph opens this view's settings panel.
    this.sidebar.onSettings = () => this.hud.toggleSettings();
    // Show any ships currently in warp (e.g. re-entering the galaxy after ordering one).
    this.refreshTransitLines();
    this.tick();
    if (this.autoSelectTimer === null && this.selectedClusterIdx < 0) {
      this.autoSelectTimer = window.setTimeout(() => {
        this.autoSelectTimer = null;
        if (!this.running || this.selectedClusterIdx >= 0) return;
        const sunIdx = STARS.findIndex(s => s.id === 'sol');
        if (sunIdx < 0) return;
        const solCluster = clusterIndexFor(sunIdx);
        if (solCluster < 0) return;
        this.selectAndFocusCluster(solCluster);
      }, 1000);
    }
  }

  stop(): void {
    if (!this.running) return;
    // A warp pick armed when the scene pauses (View System / planet-test / app teardown) would be
    // ORPHANED — stop() drops the input handlers, so nothing could confirm/cancel it, and freezesTurn
    // would strand Next Turn on. Cancel it cleanly first (writes nothing; restores the normal galaxy
    // selection) so no pause path can leave a stale, turn-frozen mode behind. Self-guards on no pick.
    this.departureCancel();
    this.running = false;
    if (this.autoSelectTimer !== null) {
      clearTimeout(this.autoSelectTimer);
      this.autoSelectTimer = null;
    }
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this._onResize);
    this.input.stop();
    this.lastTickMs = 0;
  }

  // Tear down for good — mirrors SystemScene/TestScene.dispose(). stop() only
  // pauses the loop and drops listeners (so the galaxy view can resume after a
  // system-view round-trip); dispose() additionally releases the owned GPU /
  // HUD resources and, via viewport.dispose(), the RenderScaleObserver's
  // window + matchMedia listeners that stop() leaves live. The starmap is a
  // forever-singleton today, so this is latent — but AppController.stop() (the
  // app-teardown path, distinct from the enterSystem/enterTest pause path)
  // wires it so the contract is correct before a screen ever swaps the starmap
  // out. Idempotent: stop() guards on `running`, and the disposes are safe once.
  dispose(): void {
    this.stop();
    this.hud.dispose();
    this.selectionBrackets.dispose();
    this.candidateBrackets.dispose();
    this.rangeRing.dispose();
    this.transitLines.dispose();
    this.routeLine.dispose();
    this.departureBanner.dispose();
    this.viewport.dispose();
  }

  // -- input wiring -----------------------------------------------------

  // Bridge from InputController gesture intents to scene-side state. The
  // controller is gesture-only (decides what's happening); scene applies
  // the deltas to view-state and runs selection/animation logic.
  private buildInputHandlers(): InputHandlers {
    return {
      clientToHud: (x, y, out) => this.viewport.clientToHud(x, y, out),
      pickStar: (x, y) => this.pickStar(x, y),
      starToCluster: (idx) => clusterIndexFor(idx),
      // Sidebar first (it owns the reserved strip), then the floating departure banner (only live
      // during a pick), then the HUD — each must intercept before the scene pick behind it.
      hudHandleClick: (x, y) => this.sidebar.handleClick(x, y) || this.departureBanner.handleClick(x, y) || this.hud.handleClick(x, y),
      hudHitTest: (x, y) => {
        const s = this.sidebar.hitTest(x, y);
        if (s !== 'transparent') return s;
        const b = this.departureBanner.hitTest(x, y);
        return b !== 'transparent' ? b : this.hud.hitTest(x, y);
      },
      hudHandlePointerMove: (x, y) => { this.sidebar.handlePointerMove(x, y); this.departureBanner.handlePointerMove(x, y); this.hud.handlePointerMove(x, y); },
      hudHandleWheel: (x, y, d, m) => this.sidebar.handleWheel(x, y, d, m),
      applyOrbitDelta: (dx, dy) => this.applyOrbitDelta(dx, dy),
      applyTouchPan: (dx, dy) => this.applyTouchPan(dx, dy),
      zoomBy: (factor) => this.setZoom(this.view.distance * factor),
      onClickStar: (clusterIdx, button) => {
        // In the warp pick, BOTH mouse buttons lock/confirm a reachable destination — right-click is the
        // accelerator INTO the same lock state (never an instant irrevocable fire), left-click the primary.
        if (this.departure) {
          if (button === 0 || button === 2) this.departureLockOrConfirm(clusterIdx);
          return;
        }
        if (button === 2) {
          // Right-click hook. Logs in dev so the wiring is observable in
          // DevTools (silent in prod); becomes a real game action when
          // right-click gets a binding.
          if (import.meta.env.DEV) console.info('[scene] right-click hook on cluster', clusterIdx, STARS[STAR_CLUSTERS[clusterIdx]!.primary]!.name);
          return;
        }
        if (button === 0) this.selectAndFocusCluster(clusterIdx);
      },
      // In the warp pick a double-click reads as lock+confirm on the target, NOT enter-system.
      onDoubleClickStar: (clusterIdx) => {
        if (this.departure) { this.departureLockOrConfirm(clusterIdx); return; }
        this.onViewSystem(clusterIdx);
      },
      onLongPressStar: (clusterIdx) => {
        // Long-press hook. Same shape as the right-click hook above —
        // logs in dev only; becomes a real action when touch long-press
        // gets a binding.
        if (import.meta.env.DEV) console.info('[scene] long-press hook on cluster', clusterIdx, STARS[STAR_CLUSTERS[clusterIdx]!.primary]!.name);
      },
      onPointerHoverChanged: (x, y, has) => {
        if (has) {
          this.pointer.x = x;
          this.pointer.y = y;
          this.pointer.has = true;
        } else {
          this.pointer.has = false;
        }
      },
      onEscape: () => {
        // Selection drill-down — Esc pops ONE level each press: the ship-selection (warp destination pick)
        // backs out to the system selection, then a second Esc deselects the system. (A pre-locked
        // destination is part of the pick, not its own level, so it backs out in one press, not two.)
        if (this.departure) { this.departureCancel(); return; }
        this.deselect();
      },
      onFocusCandidate: () => {
        // In the warp pick, Space re-locks the hovered in-range cluster (the candidate-advance idiom, rebound).
        if (this.departure) {
          const star = this.pointer.has ? this.pickStar(this.pointer.x, this.pointer.y) : -1;
          if (star >= 0) {
            const c = clusterIndexFor(star);
            if (this.reachableClusterSet.has(c) && c !== this.departure.originClusterIdx) this.departureLock(c);
          }
          return;
        }
        // Spacebar: candidate beats selection. Pressing space while panned
        // off the current selection (so a candidate is visible) switches
        // selection to the candidate and glides the pivot to it. Falls
        // through to "re-focus current selection" when no candidate is
        // visible.
        if (this.candidateClusterIdx >= 0) {
          this.selectAndFocusCluster(this.candidateClusterIdx);
          return;
        }
        if (this.selectedClusterIdx < 0) return;
        const com = STAR_CLUSTERS[this.selectedClusterIdx]!.com;
        this.animateFocusTo(com.x, com.y, com.z);
      },
      onFocusSelection: () => {
        // In the warp pick, F re-centres the origin (home) — the pick's twin of "back to selection".
        if (this.departure) {
          const com = STAR_CLUSTERS[this.departure.originClusterIdx]!.com;
          this.animateFocusTo(com.x, com.y, com.z);
          return;
        }
        // F: always re-focus the current selection. Ignores any candidate
        // so F is a dedicated "back to selection" key, separate from
        // spacebar's "advance to candidate" (F key only — no sidebar button).
        if (this.selectedClusterIdx < 0) return;
        const com = STAR_CLUSTERS[this.selectedClusterIdx]!.com;
        this.animateFocusTo(com.x, com.y, com.z);
      },
      onEnter: () => {
        // In the warp pick, Enter confirms the locked destination (its keyboard twin of the second click).
        if (this.departure) { this.departureConfirm(); return; }
        // Enter: keyboard equivalent of the View System pill button + the
        // double-click gesture. Routes through the same onViewSystem
        // callback so the AppController scene swap stays one path.
        if (this.selectedClusterIdx < 0) return;
        this.onViewSystem(this.selectedClusterIdx);
      },
      cancelFocusAnimation: () => { this.focusAnimating = false; },
    };
  }

  // Shared select-and-focus action: binds the selection to the given cluster
  // and glides the orbit pivot onto its COM (not any one member's position),
  // so a binary's two members both glide to the same vantage. Called from
  // the InputController's onClickStar handler and any future hook (context
  // menu, keyboard select) that wants the same behavior.
  private selectAndFocusCluster(clusterIdx: number): void {
    this.selectedClusterIdx = clusterIdx;
    this.labels.setSelectedCluster(clusterIdx);
    this.starPoints.setSelectedCluster(clusterIdx);
    this.selectionBrackets.setCluster(clusterIdx);
    this.galaxyContext.setCluster(clusterIdx);
    this.sidebar.refreshContent();
    const com = STAR_CLUSTERS[clusterIdx]!.com;
    // Grid runs its own sequential expand/collapse off this call.
    // Droplines snap to the new plane immediately for now; staggering them
    // to match the ring choreography is a follow-up once the rings settle.
    this.grid.setSelection(this._comScratch.set(com.x, com.y, com.z));
    this.droplines.setSelectedCluster(clusterIdx);
    this.droplines.setFade(1);
    this.focusMarker.setSelectedCluster(clusterIdx);
    this.animateFocusTo(com.x, com.y, com.z);
  }

  // Repaint the sidebar after a turn and restep the transit overlay. Called by
  // AppController on Next Turn.
  afterTurnAdvance(): void {
    this.sidebar.refreshContent();
    // Ships in warp advanced a step this turn — restep the transit-line progress heads.
    this.refreshTransitLines();
  }

  // Rebuild the galaxy transit overlay from the durable store: one dotted origin→destination leg per
  // 'transiting' ship, its progress head at (turn − departedOnTurn)/(arrivesOnTurn − departedOnTurn) so the
  // fraction is exact (never recomputed from live stats). Called on galaxy resume + each turn.
  private refreshTransitLines(): void {
    const turn = getGameState().turn;
    const views: TransitView[] = [];
    for (const s of getGameState().ships) {
      if (s.status !== 'transiting' || s.destinationSystemId === undefined
        || s.arrivesOnTurn === undefined || s.departedOnTurn === undefined) continue;
      const oi = clusterIndexForSystemId(s.systemId);
      const di = clusterIndexForSystemId(s.destinationSystemId);
      if (oi < 0 || di < 0) continue;
      const span = s.arrivesOnTurn - s.departedOnTurn;
      const frac = span > 0 ? (turn - s.departedOnTurn) / span : 1;
      views.push({ o: STAR_CLUSTERS[oi]!.com, d: STAR_CLUSTERS[di]!.com, frac, color: factionColor(s.factionId) });
    }
    this.transitLines.setTransits(views);
  }

  // Touch-pan: midpoint translation drives view.target along the
  // camera's screen-aligned right/up axes (NOT the galactic-plane basis
  // WASD uses). Camera has zero roll, so screen-right stays in the plane
  // and is independent of pitch; screen-up tilts with pitch, so a
  // vertical drag while pitched lifts the target along the camera's
  // actual up vector instead of plunging it forward across the plane.
  // Direction is "world tracks the fingers": drag right → world shifts
  // right under the finger; drag down → world shifts down. Pixel delta
  // is converted to world units via the focus-plane scale, so a finger
  // moving N CSS px shifts the world by exactly N px at the focus
  // distance — the point under the finger stays under the finger.
  private applyTouchPan(dxPx: number, dyPx: number): void {
    const halfFovTan = Math.tan((FOV_DEG * Math.PI / 180) * 0.5);
    const lyPerPx = (2 * halfFovTan * this.view.distance) / this.viewport.cssH;
    const sy = Math.sin(this.view.yaw);
    const cy = Math.cos(this.view.yaw);
    const sp = Math.sin(this.view.pitch);
    const cp = Math.cos(this.view.pitch);
    this._right.set(-sy, cy, 0);
    this._step.set(-cp * cy, -cp * sy, sp);  // screen_up in world
    this.view.target.addScaledVector(this._right, -dxPx * lyPerPx);
    this.view.target.addScaledVector(this._step, dyPx * lyPerPx);
  }

  // Yaw/pitch the camera by a screen-pixel delta. Shared by single-finger
  // drag (the default) and two-finger pan-mode-when-singleTouchAction='pan',
  // both at ORBIT_SENSITIVITY_RAD_PER_PX.
  private applyOrbitDelta(dxPx: number, dyPx: number): void {
    this.view.yaw   -= dxPx * ORBIT_SENSITIVITY_RAD_PER_PX;
    this.view.pitch -= dyPx * ORBIT_SENSITIVITY_RAD_PER_PX;
    this.view.pitch = Math.max(0.05, Math.min(Math.PI - 0.05, this.view.pitch));
  }

  // Per-frame WASD/QE/ZX update. Held-key set is owned by the input
  // controller; this method reads it each tick and integrates camera-pan
  // physics. Forward and right are derived from yaw alone (no pitch term)
  // so WASD pans parallel to the galactic plane regardless of camera tilt
  // — looking down at a star and pressing W glides across the plane
  // instead of plunging into it. Pitch is clamped < π so the camera always
  // has a well-defined yaw direction. Z/X translate along world up
  // (galactic plane normal) so they sink/lift the view.
  private applyHeldKeys(dt: number): void {
    const keys = this.input.getHeldKeys();
    if (keys.size === 0) return;

    const sy = Math.sin(this.view.yaw);
    const cy = Math.cos(this.view.yaw);
    // Camera = target + R*(sp*cy, sp*sy, cp); the horizontal projection of
    // (target - camera) drops the cp term. Already unit length: cy² + sy² = 1.
    this._forward.set(-cy, -sy, 0);
    this._right.crossVectors(this._forward, StarmapScene.WORLD_UP).normalize();

    this._step.set(0, 0, 0);
    if (keys.has('w')) this._step.add(this._forward);
    if (keys.has('s')) this._step.sub(this._forward);
    if (keys.has('d')) this._step.add(this._right);
    if (keys.has('a')) this._step.sub(this._right);
    if (keys.has('x')) this._step.add(StarmapScene.WORLD_UP);
    if (keys.has('z')) this._step.sub(StarmapScene.WORLD_UP);
    if (this._step.lengthSq() > 0) {
      this._step.normalize().multiplyScalar(this.view.distance * PAN_RATE_PER_DISTANCE * dt);
      this.view.target.add(this._step);
    }

    if (keys.has('q')) this.view.yaw += ORBIT_RATE_RAD * dt;
    if (keys.has('e')) this.view.yaw -= ORBIT_RATE_RAD * dt;
  }

  private deselect(): void {
    this.selectedClusterIdx = -1;
    this.labels.setSelectedCluster(-1);
    this.starPoints.setSelectedCluster(-1);
    this.selectionBrackets.setCluster(-1);
    this.galaxyContext.setCluster(-1);
    this.sidebar.refreshContent();
    this.grid.setSelection(null);
    this.droplines.setSelectedCluster(-1);
    this.droplines.setFade(0);
    this.focusMarker.setSelectedCluster(-1);
  }

  // -- warp departure mode (galaxy destination pick) --------------------

  // While a warp destination is being picked the outer galaxy turn is frozen (a modality, like combat).
  // This is the programmatic gate (AppController.nextTurn reads it); Sidebar.setNextTurnEnabled is the
  // user-click gate, raised in enterDepartureMode. False whenever the pick isn't armed.
  get freezesTurn(): boolean {
    return this.departure !== null;
  }

  // Open a warp destination pick for a ready ship the player clicked in the sidebar fleet list — the
  // galaxy-only entry point for star-to-star navigation. Validates the ship is a commandable, in-cluster
  // player ship, bakes its reachable set into a DepartureRequest, and enters the pick in place (no view
  // swap — we're already on the map). Clicking a DIFFERENT ready ship while a pick is armed switches the
  // pick to it; clicking the ship already being picked is a no-op.
  beginShipDeparture(shipId: string): void {
    if (this.departure?.shipId === shipId) return;
    const ship = getGameState().ships.find(
      (s) => s.id === shipId && s.status === 'ready' && s.factionId === CONTROLLED_FACTION_ID,
    );
    if (!ship) return;
    const originClusterIdx = clusterIndexForSystemId(ship.systemId);
    if (originClusterIdx < 0) return;
    // Switching ships mid-pick: tear the current pick's visuals down first (its origin/range may differ),
    // then re-enter fresh for the new ship. Stays in the mode — no galaxy resume between the two.
    if (this.departure) this.teardownDeparture();
    this.departure = buildDepartureRequest(ship, originClusterIdx);
    this.enterDepartureMode();
  }

  // DEV visual-test seam (the ?demo-route screenshot harness, tree-shaken from prod): select the first
  // cluster holding a ready player ship, open its pick, and lock the nearest destination — so a screenshot
  // reproducibly shows the gold banner + gold route line. Reached only from main.ts's ?demo-route branch.
  devDemoRoute(): void {
    const ship = getGameState().ships.find((s) => s.status === 'ready' && s.factionId === CONTROLLED_FACTION_ID);
    if (!ship) return;
    const c = clusterIndexForSystemId(ship.systemId);
    if (c >= 0) this.selectAndFocusCluster(c);
    // Lock the FARTHEST reachable (reachable is distance-sorted; last = farthest, and never the origin at
    // distance 0) so the demo route is a long, unmistakable gold line.
    this.beginShipDeparture(ship.id);
    const reachable = this.departure?.reachable ?? [];
    const dest = reachable[reachable.length - 1];
    if (dest && dest.clusterIdx !== this.departure!.originClusterIdx) this.departureLock(dest.clusterIdx);
  }

  // Enter the pick: light the departing ship in the sidebar fleet list, freeze the turn, suppress the
  // selection grid + labels, raise the range ring + in-range lens, glide the camera home, and float the
  // on-map departure banner in its "Select a destination" state (NO pre-locked destination — the player
  // picks one). Teardown lives in teardownDeparture, which every exit path routes through.
  private enterDepartureMode(): void {
    const req = this.departure;
    if (!req) return;
    // Reachable set (+ origin so home stays lit) drives the click-to-lock gate and the shader lens.
    this.reachableClusterSet = new Set(req.reachable.map((d) => d.clusterIdx));
    this.reachableClusterSet.add(req.originClusterIdx);
    this.starPoints.setInRangeClusters(this.reachableClusterSet);
    this.starPoints.setInRangeMode(true);
    this.starPoints.setSelectedCluster(-1);
    this.starPoints.setCandidateCluster(-1);

    // The single range ring at the origin, radius = the drive's reach in world light-years. Suppress the
    // standard selection grid + labels + droplines + focus marker: one ring means one thing.
    const com = STAR_CLUSTERS[req.originClusterIdx]!.com;
    this.rangeRing.setRing(com.x, com.y, com.z, req.rangeMilliLy / MILLI_PER_LY);
    this.grid.setSelection(null);
    this.labels.setSelectedCluster(-1);
    this.labels.setCandidateCluster(-1);
    this.candidateBrackets.setCluster(-1);
    this.droplines.setSelectedCluster(-1);
    this.droplines.setFade(0);
    this.focusMarker.setSelectedCluster(-1);
    // Glide home via the focus-glide PRIMITIVE (not selectAndFocusCluster, which would raise exactly the
    // selection chrome the mode suppresses).
    this.animateFocusTo(com.x, com.y, com.z);

    // Sidebar stays on the galaxy fleet list — light the departing ship, freeze Next Turn, and make the
    // settings glyph inert (its popover's actions would bypass the mode teardown). Close the popover too
    // if it's already open: a neutered glyph can't reopen it, but its live rows would otherwise persist.
    this.galaxyContext.setSelectedShip(req.shipId);
    this.hud.closeSettings();
    this.sidebar.onSettings = () => {};
    this.sidebar.setNextTurnEnabled(false);
    this.sidebar.refreshContent();

    // No destination is pre-locked — float the banner's "Select a destination" prompt until the player picks.
    this.departureLockClusterIdx = -1;
    this.departureBanner.show();
  }

  // A click / right-click on a cluster during the pick: out of range (or the origin) ⇒ inert; the
  // already-locked cluster ⇒ confirm (the second-click commit); otherwise ⇒ lock it.
  private departureLockOrConfirm(clusterIdx: number): void {
    if (!this.reachableClusterSet.has(clusterIdx) || clusterIdx === this.departure?.originClusterIdx) return;
    if (clusterIdx === this.departureLockClusterIdx) { this.departureConfirm(); return; }
    this.departureLock(clusterIdx);
  }

  // Lock a reachable destination: arm the selection brackets on it and push its distance / ETA into the
  // on-map banner (which grows its CONFIRM pill). No camera glide — the lock parks; the player flies the
  // camera themselves.
  private departureLock(clusterIdx: number): void {
    const dest = this.departure?.reachable.find((d) => d.clusterIdx === clusterIdx);
    if (!dest || this.departure === null) return;
    this.departureLockClusterIdx = clusterIdx;
    this.selectionBrackets.setCluster(clusterIdx);
    // Highlight the proposed route: a thick gold line from the origin cluster to the locked destination.
    this.routeLine.setRoute(STAR_CLUSTERS[this.departure.originClusterIdx]!.com, STAR_CLUSTERS[clusterIdx]!.com);
    this.departureBanner.setLock({
      distanceLy: dest.distanceMilli / MILLI_PER_LY,
      etaTurns: dest.etaTurns,
    });
  }

  // Confirm the locked destination: order the warp straight into the durable store (orderShipWarp re-checks
  // readiness + range and no-ops on any violation), tear the mode down, and restore the galaxy selection in
  // place. The ship is now 'transiting' — it drops out of the sidebar fleet list and rides the transit
  // overlay. No view swap: warp is a galaxy modality now.
  private departureConfirm(): void {
    const req = this.departure;
    if (!req || this.departureLockClusterIdx < 0) return;
    orderShipWarp(req.shipId, systemIdForCluster(this.departureLockClusterIdx));
    this.teardownDeparture();
    this.resumeGalaxyAfterDeparture();
  }

  // Cancel the pick (writes nothing): tear down + restore the galaxy selection in place.
  private departureCancel(): void {
    if (!this.departure) return;
    this.teardownDeparture();
    this.resumeGalaxyAfterDeparture();
  }

  // Restore the galaxy view when a pick ends (confirm or cancel): re-enable the settings glyph (made inert
  // during the pick), re-raise the selection chrome for the still-selected origin cluster (a near-noop
  // camera-wise — the pick already glided there), and rebuild the transit overlay so a just-ordered warp
  // shows immediately. The sidebar never swapped context, so there's nothing to re-install there.
  private resumeGalaxyAfterDeparture(): void {
    this.sidebar.onSettings = () => this.hud.toggleSettings();
    if (this.selectedClusterIdx >= 0) this.selectAndFocusCluster(this.selectedClusterIdx);
    this.refreshTransitLines();
  }

  // The SINGLE teardown every exit path (confirm / cancel / ship-switch) routes through — clears the
  // mode's visuals + state, drops the on-map banner + the sidebar ship highlight, and lowers the turn
  // freeze. The selection chrome is re-raised by the caller's resumeGalaxyAfterDeparture (this only tears
  // the mode down; a ship-switch re-enters straight after without resuming).
  private teardownDeparture(): void {
    this.departure = null;
    this.departureLockClusterIdx = -1;
    this.reachableClusterSet = new Set();
    this.selectionBrackets.setCluster(-1);
    this.rangeRing.clear();
    this.routeLine.clear();
    this.starPoints.setInRangeMode(false);
    this.starPoints.setInRangeClusters(null);
    this.departureBanner.hide();
    this.galaxyContext.setSelectedShip(null);
    this.sidebar.setNextTurnEnabled(true);
  }

  // -- camera + zoom -----------------------------------------------------

  private setZoom(d: number): void {
    this.view.distance = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, d));
  }

  private pickStar(clientX: number, clientY: number): number {
    this._ndc.set(
      // X over the content width — the 3D viewport is inset left of the sidebar,
      // so a cursor at content's right edge is NDC x = 1.
      (clientX / this.viewport.contentCssW) * 2 - 1,
      -(clientY / this.viewport.cssH) * 2 + 1,
    );
    this.raycaster.setFromCamera(this._ndc, this.camera);
    this._hits.length = 0;
    const hits = this.raycaster.intersectObject(this.starPoints.points, false, this._hits);
    let bestD = Infinity;
    let bestIdx = -1;
    for (const h of hits) {
      if (h.distanceToRay !== undefined && h.distanceToRay < bestD) {
        bestD = h.distanceToRay;
        bestIdx = h.index ?? -1;
      }
    }
    return bestIdx;
  }

  private animateFocusTo(x: number, y: number, z: number): void {
    this.focusFrom.copy(this.view.target);
    this.focusTo.set(x, y, z);
    // Pull the orbit radius in if the new star is already closer to the
    // camera than the current radius — otherwise the lerp would translate
    // the camera away from the new target. Never push out (keep current
    // radius if the new star is farther) and clamp to ZOOM_MIN so a tight
    // focus doesn't crash through the star.
    const dx = this.camera.position.x - x;
    const dy = this.camera.position.y - y;
    const dz = this.camera.position.z - z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.distanceFrom = this.view.distance;
    this.distanceTo = Math.max(ZOOM_MIN, Math.min(this.view.distance, d));
    this.focusAnimStart = performance.now();
    this.focusAnimating = true;
  }

  // Camera orbits target on a sphere of radius = view.distance. Under
  // perspective, that distance directly drives apparent size — no separate
  // frustum bookkeeping like the old ortho path needed.
  private updateCamera(): void {
    const sp = Math.sin(this.view.pitch), cp = Math.cos(this.view.pitch);
    const sy = Math.sin(this.view.yaw),   cy = Math.cos(this.view.yaw);
    const R = this.view.distance;
    this.camera.position.set(
      this.view.target.x + R * sp * cy,
      this.view.target.y + R * sp * sy,
      this.view.target.z + R * cp,
    );
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(this.view.target);
    // Force matrixWorldInverse refresh now so label projections this frame
    // see the same transform the renderer will.
    this.camera.updateMatrixWorld(true);
  }

  private resize(): void {
    // ViewportSizer.apply does the load-bearing integer-multiple-of-N buffer
    // snap (+ setPixelRatio / setSize / snapped-material viewport); the
    // subsystem resizes below run off the updated css/buffer dims.
    this.viewport.apply(this.renderer);
    const { cssH, bufferW, bufferH, contentCssW, contentBufferW } = this.viewport;
    // Aspect from the content width so the narrower (sidebar-inset) viewport
    // doesn't distort the framing; NDC (0,0) then lands at the centre of the
    // visible area, so a focused cluster sits there with no target offset.
    this.camera.aspect = contentCssW / cssH;
    this.camera.updateProjectionMatrix();
    this.starPoints.setPxScale(bufferH / 2);
    this.selectionBrackets.setPxScale(bufferH / 2);
    this.candidateBrackets.setPxScale(bufferH / 2);
    // HUD spans the full buffer; the overlay projectors place anchors in the
    // content rect so labels/brackets track their stars left of the sidebar.
    this.hud.resize(bufferW, bufferH);
    this.labels.resize(bufferW, bufferH, contentBufferW);
    this.selectionBrackets.resize(contentBufferW, bufferH);
    this.candidateBrackets.resize(contentBufferW, bufferH);
    this.sidebar.resize(bufferW, bufferH);
    // The banner floats centered in the CONTENT rect (left of the sidebar), so it needs both dims.
    this.departureBanner.resize(bufferW, bufferH, contentBufferW);
  }

  // -- main loop ---------------------------------------------------------

  private tick = (): void => {
    if (!this.running) return;

    const now = performance.now();
    // Frame delta in seconds, clamped so a stalled tab resume doesn't
    // teleport the camera. First frame after start: dt = 0.
    const dt = this.lastTickMs > 0
      ? Math.min(now - this.lastTickMs, MAX_TICK_DT_MS) / 1000
      : 0;
    this.lastTickMs = now;

    if (this.view.spin) this.view.yaw += AUTOSPIN_RAD_PER_TICK;
    this.applyHeldKeys(dt);

    if (this.focusAnimating) {
      const t = Math.min(1, (performance.now() - this.focusAnimStart) / FOCUS_ANIM_MS);
      // Ease-in-out cubic: smooth at both ends, no overshoot.
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.view.target.lerpVectors(this.focusFrom, this.focusTo, e);
      this.view.distance = this.distanceFrom + (this.distanceTo - this.distanceFrom) * e;
      if (t >= 1) {
        this.view.target.copy(this.focusTo);
        this.view.distance = this.distanceTo;
        this.focusAnimating = false;
      }
    }

    this.updateCamera();
    // Grid runs its own per-frame animation off this driver call.
    // Droplines fade is binary (set in selectAndFocusCluster / deselect),
    // so no per-tick scaling is needed here.
    this.grid.update(now, this.camera.position);
    // The warp range ring (only visible during the departure pick) zoom-fades off the camera distance.
    this.rangeRing.update(this.camera.position);

    this.starPoints.setFocus(this.view.target);
    this.starPoints.setPivot(this.view.target);
    this.starPoints.setDimAmount(dimAmountForOrbit(this.view.distance));

    // Nearest cluster to the orbit pivot — computed once per tick and shared
    // by the focus marker (anchor when nothing selected) and the candidate-
    // bracket gating below. Centralizing avoids two scans per frame for the
    // same query.
    const nearestClusterIdx = nearestClusterIdxTo(
      this.view.target.x, this.view.target.y, this.view.target.z,
    );

    // Hover detection — pick the star whose ray-distance is smallest, then
    // share the cluster-mapped index with the droplines (always-show-on-
    // hover override) and the candidate computation below.
    const hovered = this.pointer.has ? this.pickStar(this.pointer.x, this.pointer.y) : -1;
    const hoveredCluster = hovered >= 0 ? clusterIndexFor(hovered) : -1;
    this.droplines.setHovered(hoveredCluster);
    this.droplines.update(this.camera, this.view.target);
    this.focusMarker.update(this.view.target, this.camera, this.focusAnimating, nearestClusterIdx);

    // Candidate cluster — the hover-beats-proximity rule lives in
    // resolveCandidateCluster (see selection-policy.ts for the full rationale).
    // Snap visibility, no fade ramp — candidate is a discrete state. The
    // unified index is pushed to brackets, labels (yellow promotion +
    // fade-bypass), and stashed for the spacebar handler. SUPPRESSED during the
    // warp pick: the in-range lens + the locked-destination brackets own the
    // highlight there, so the ordinary candidate has no meaning.
    if (this.departure) {
      this.candidateClusterIdx = -1;
    } else {
      const candidate = resolveCandidateCluster(
        hoveredCluster, nearestClusterIdx,
        nearestClusterIdx >= 0 ? STAR_CLUSTERS[nearestClusterIdx]!.com : null,
        this.selectedClusterIdx, this.view.target, this.focusAnimating,
      );
      this.candidateClusterIdx = candidate;
      this.candidateBrackets.setCluster(candidate);
      this.labels.setCandidateCluster(candidate);
      this.starPoints.setCandidateCluster(candidate);
    }

    this.labels.update(this.camera, this.view.target);
    this.selectionBrackets.update(this.camera, this.view.target);
    this.candidateBrackets.update(this.camera, this.view.target);

    // One full-buffer clear; the reserved sidebar strip on the right stays
    // clear-color until the sidebar paints into it. autoClear stays off so the
    // overlays don't wipe the 3D — both use depthTest: false.
    const { cssW, cssH, contentCssW } = this.viewport;
    this.renderer.autoClear = false;
    this.renderer.clear();
    // 3D content pass: viewport + scissor to the content rect so stars can't
    // splat under the sidebar.
    this.renderer.setViewport(0, 0, contentCssW, cssH);
    this.renderer.setScissor(0, 0, contentCssW, cssH);
    this.renderer.setScissorTest(true);
    this.renderer.render(this.scene, this.camera);
    // Labels + brackets also belong to the content rect: full-buffer ortho
    // VIEWPORT (so 1 unit = 1 buffer px) but the SCISSOR stays on the content
    // rect — a label whose star sits at the right edge clips at the sidebar
    // boundary instead of spilling into the strip, and a just-off-screen star's
    // label (projectWorldToBuffer only depth-culls, not x) doesn't appear there.
    this.renderer.setViewport(0, 0, cssW, cssH);
    this.renderer.render(this.labels.scene, this.labels.camera);
    // HUD, then the floating departure banner (only visible during a pick — it renders over the
    // stars, depthTest off), then the persistent sidebar, all at full buffer. The sidebar draws
    // last so it owns the reserved strip on the right.
    this.renderer.setScissorTest(false);
    this.renderer.render(this.hud.scene, this.hud.camera);
    this.renderer.render(this.departureBanner.scene, this.departureBanner.camera);
    this.renderer.render(this.sidebar.scene, this.sidebar.camera);
    this.renderer.autoClear = true;
    this.rafId = requestAnimationFrame(this.tick);
  };
}
