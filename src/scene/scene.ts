import {
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import { Grid } from './grid';
import { Droplines } from './droplines';
import { Labels } from './labels';
import { StarPoints } from './stars';
import { setSnappedLineViewport } from './materials';
import { RenderScaleObserver, effectiveScale } from './render-scale';
import { MapHud } from '../ui/map-hud';
import { STARS, STAR_CLUSTERS, clusterIndexFor } from '../data/stars';
import { getSettings } from '../settings';

// Orbit radius bounds (camera-to-target ly). Replaces the old ortho frustum
// height; under perspective, distance directly drives apparent size of
// objects at the focus.
const ZOOM_MIN = 4;
const ZOOM_MAX = 150;
const FOV_DEG = 45;
const NEAR = 0.1;
const FAR = 1000;
const DEFAULT_VIEW = { distance: 30, yaw: 1.1, pitch: 1.2 };

// A pointer release that moved less than this many CSS pixels from its
// pressdown counts as a click (vs the start of an orbit drag). Forgiving
// enough to absorb hand jitter on a press.
const CLICK_DRAG_PX = 4;

// Two-finger classifier thresholds (CSS px). The gesture stays 'undecided'
// (no zoom, no pan applied) until one of these is exceeded:
//   - PAN: Euclidean distance the midpoint of the two pointers has
//     traveled from gesture start.
//   - ZOOM: scalar change in the distance between the two pointers
//     (|currentDist - startDist|). Doubled relative to PAN because in a
//     symmetric pinch BOTH fingers contribute to the separation change,
//     so 80 px of separation ≈ each finger moving 40 px — comparable
//     per-finger effort to a 40 px pan. When both signals cross in the
//     same frame, the larger ratio (signal/threshold) wins. Both metrics
//     are scalar magnitudes, so the heuristic is orientation-agnostic
//     (same numbers whether the fingers are stacked, side-by-side, or
//     diagonal). Sized well above touch-down jitter so contact-stabilization
//     noise can never cross either threshold on its own — the user has
//     to actually engage with the gesture before a mode locks.
const GESTURE_COMMIT_PAN_PX = 40;
const GESTURE_COMMIT_ZOOM_PX = 80;

// "Actively moving along the separation axis" threshold for the pinch-vs-pan
// classifier (CSS px). A finger whose displacement projects below this onto
// the separation axis is treated as anchored — even if the other finger is
// shooting off in the same signed direction, that's an anchor-style pinch
// (thumb-fixed, index-splays), not a pan. Only when BOTH fingers project
// above this *and* share a sign do we conclude the pair is translating
// together (asymmetric pan along u), and zero out the zoom signal.
const ACTIVE_PROJ_PX = 2;

// Focus animation: only view.target lerps; yaw/pitch/distance stay frozen so
// the camera glides over to the new orbital pivot rather than swinging.
const FOCUS_ANIM_MS = 400;

// WASD/QE keyboard fly. Pan rate scales with view.distance so the visual
// movement speed stays consistent at any zoom level (zoom in → smaller world
// step per second, but the same screen-space rate). QE orbit is in radians
// per second.
const PAN_RATE_PER_DISTANCE = 0.5;
const ORBIT_RATE_RAD = 1.5;
// Clamp per-frame dt so a stalled tab or breakpoint resume doesn't hurl the
// camera across the scene on the next frame.
const MAX_TICK_DT_MS = 100;

// Window within which a second left-click on the same cluster counts as a
// double-click (and opens the system view). Sized for a deliberate double
// rather than a fast fidget.
const DOUBLE_CLICK_MS = 350;

// Squared-distance epsilon (ly²) used to decide whether view.target is "on"
// the selected cluster's COM — drives the Focus button's enabled state.
// 0.01 ly = ~38 AU; well below any visually significant offset and far
// above FP jitter from the focus lerp's terminal copy().
const FOCUS_EPSILON_SQ = 0.01 * 0.01;

// Long-press: touch-only hook held alive as a placeholder for a future game
// action (context menu, secondary command, etc.). LONG_PRESS_MS gates the
// timer fire; LONG_PRESS_MOVE_PX cancels it when the holding finger drifts
// (looser than CLICK_DRAG_PX because users drift more during a held press
// than a quick tap). fireLongPress currently console.info's so the wiring
// is observable in DevTools and rebinding is a one-line body change.
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 8;

interface ViewState {
  target: Vector3;
  distance: number;  // orbit radius (camera-to-target ly)
  yaw: number;
  pitch: number;
  spin: boolean;
}

export class StarmapScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly camera: PerspectiveCamera;
  private readonly scene = new Scene();
  private readonly view: ViewState;
  private readonly raycaster = new Raycaster();
  private readonly grid: Grid;
  private readonly droplines: Droplines;
  private readonly labels: Labels;
  private readonly starPoints: StarPoints;
  private readonly hud: MapHud;
  private readonly renderScale = new RenderScaleObserver();

  // Drag state. Any pointer drag = orbit (yaw/pitch); pan was removed because
  // the camera always orbits a star, never an arbitrary world point.
  private dragging = false;
  private dragButton = 0;
  private lastX = 0;
  private lastY = 0;
  private downX = 0;
  private downY = 0;
  // Active pointers, keyed by pointerId. size === 1 → orbit drag;
  // size >= 2 → pinch zoom (orbit suppressed). Tracking via pointer events
  // unifies mouse + touch + pen and lets pinch detection run off the same
  // event stream as the drag, so a second finger landing mid-drag cleanly
  // hands off to pinch instead of running both gestures simultaneously
  // (the bug: on iPad Safari, the first finger's pointermove kept yawing
  // the camera while touchmove was zooming, so every pinch came with an
  // unwanted orbit jolt).
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinching = false;
  // Two-finger gesture commits to either zoom or pan on the first
  // significant movement; once committed it stays in that mode for the
  // rest of the gesture so a slight separation drift mid-pan can't yank
  // the zoom (and vice versa). 'undecided' is the sampling window.
  private pinchMode: 'undecided' | 'zoom' | 'pan' = 'undecided';
  private pinchDist = 0;
  // Midpoint of the active two-pointer pair, in CSS pixels.
  private pinchMidX = 0;
  private pinchMidY = 0;
  // Snapshot of dist + mid at gesture start. The undecided-mode
  // classifier measures sepDelta and midDelta from these anchors and
  // commits to whichever signal first overshoots its own threshold
  // (GESTURE_COMMIT_ZOOM_PX or GESTURE_COMMIT_PAN_PX); on a same-frame
  // tie, the larger ratio (signal/threshold) wins.
  private pinchStartDist = 0;
  private pinchStartMidX = 0;
  private pinchStartMidY = 0;
  // Per-finger start positions, in the same iteration order as
  // measurePinch/capturePinchMid. Used by the classifier to project each
  // finger's motion onto the separation axis: a real pinch has the two
  // projections in OPPOSITE directions; an asymmetric pan along that axis
  // has them in the SAME direction. Without this gate, finger asymmetry
  // along the line between fingers fakes a sepDelta that can outrun the
  // midpoint delta and mis-commit a pan to zoom.
  private pinchStartAx = 0;
  private pinchStartAy = 0;
  private pinchStartBx = 0;
  private pinchStartBy = 0;
  private readonly pointer = { x: 0, y: 0, has: false };
  // Currently-selected cluster, mirrored across Labels (reticle), MapHud
  // (info card + View System button), and Droplines (selected pin). Scene
  // tracks its own copy so non-routing logic — spacebar focus, future
  // keyboard actions on the selection — can read it without coupling to
  // any one of those owners' internals.
  private selectedClusterIdx = -1;

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

  // Double-click tracking. A second left-click on the same cluster within
  // DOUBLE_CLICK_MS of the first fires onViewSystem; either a click on a
  // different cluster or a timed-out gap restarts the window.
  private lastClickAt = 0;
  private lastClickClusterIdx = -1;

  // Long-press timer state. Armed in onPointerDown for touch pointers only,
  // cancelled by movement / second finger / lift / OS-cancel / scene stop.
  // longPressFired suppresses the trailing pointerup's click path so a hold
  // doesn't double-fire as both long-press AND tap-select-and-focus.
  private longPressTimer: number | null = null;
  private longPressPointerId = -1;
  private longPressFired = false;

  // Fired when the user requests the system view for a cluster — either
  // by clicking the "View System" button on the info card or by double-
  // clicking a star. AppController wires this to enterSystem().
  onViewSystem: (clusterIdx: number) => void = () => {};

  // Bound listeners stored so removeEventListener works in stop().
  private readonly _onPointerDown   = (e: PointerEvent) => this.onPointerDown(e);
  private readonly _onPointerUp     = (e: PointerEvent) => this.onPointerUp(e);
  private readonly _onPointerMove   = (e: PointerEvent) => this.onPointerMove(e);
  private readonly _onPointerCancel = (e: PointerEvent) => this.onPointerCancel(e);
  private readonly _onWheel         = (e: WheelEvent) => this.onWheel(e);
  private readonly _onContextMenu   = (e: Event) => e.preventDefault();
  private readonly _onKeyDown       = (e: KeyboardEvent) => this.onKeyDown(e);
  private readonly _onKeyUp         = (e: KeyboardEvent) => this.onKeyUp(e);
  private readonly _onBlur          = () => this.heldKeys.clear();
  private readonly _onResize        = () => this.resize();

  // Reusable per-frame scratch.
  private readonly _ndc  = new Vector2();
  private readonly _buf  = new Vector2();
  private readonly _hudPt = { x: 0, y: 0 };
  private readonly _forward = new Vector3();
  private readonly _right   = new Vector3();
  private readonly _step    = new Vector3();
  private static readonly WORLD_UP = new Vector3(0, 0, 1);

  // Held-key state for WASD pan + QE orbit. Continuous-while-held; cleared
  // on blur so a key whose keyup got swallowed (alt-tab, etc.) doesn't get
  // stuck and carry the camera off-screen.
  private readonly heldKeys = new Set<string>();
  private lastTickMs = 0;

  // Cached drawing-buffer dimensions, populated by resize(). All pixel-aware
  // shader work uses these — NOT window.innerWidth/Height — because the
  // buffer is smaller than CSS px once pixelRatio drops below 1.
  private bufferW = 0;
  private bufferH = 0;
  // Cached canvas CSS dimensions. May be slightly less than the window
  // (up to N-1 physical px lost to integer-multiple rounding in resize());
  // pointer math uses these so hovers register correctly across the canvas.
  private cssW = 0;
  private cssH = 0;

  // Renderer is owned by AppController and shared across view modes.
  // Pixel ratio + size are still driven from this scene's resize() (see
  // resize() for the integer-multiple-of-N rounding that guarantees a
  // clean nearest-neighbor upscale).
  constructor(canvas: HTMLCanvasElement, renderer: WebGLRenderer) {
    this.canvas = canvas;
    this.renderer = renderer;
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

    this.grid = new Grid();
    // Grid (rings + axes + arrow) is selection-driven — hidden until the
    // user picks a cluster. updateGridForSelection() drives visibility +
    // anchor on every selection change.
    this.grid.group.visible = false;
    this.scene.add(this.grid.group);

    this.starPoints = new StarPoints(window.innerHeight / 2);
    this.scene.add(this.starPoints.points);

    const initialSettings = getSettings();
    this.droplines = new Droplines(initialSettings.showDroplines);
    this.scene.add(this.droplines.group);

    this.labels = new Labels(initialSettings.showLabels);

    this.hud = new MapHud(this.renderScale.scale);
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
      }
    };
    this.hud.onDeselect = () => this.deselect();
    this.hud.onViewSystem = (idx) => this.onViewSystem(idx);
    this.hud.onFocus = (idx) => {
      const com = STAR_CLUSTERS[idx].com;
      this.animateFocusTo(com.x, com.y, com.z);
    };

    // Re-resize whenever DPR crosses an integer-N boundary (browser zoom,
    // monitor swap, OS scale change). resize() reads the current auto N
    // from this.renderScale and applies the user's resolution preference;
    // the HUD's Resolution radio also rebuilds its disable states off
    // the new auto value.
    this.renderScale.subscribe((scale) => {
      this.hud.setAutoScale(scale);
      this.resize();
    });
  }

  // -- public API --------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attachListeners();
    this.resize();
    this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.detachListeners();
    this.cancelLongPress();
    this.lastTickMs = 0;
  }

  // -- listeners ---------------------------------------------------------

  private attachListeners(): void {
    this.canvas.addEventListener('pointerdown',   this._onPointerDown);
    this.canvas.addEventListener('pointerup',     this._onPointerUp);
    this.canvas.addEventListener('pointermove',   this._onPointerMove);
    this.canvas.addEventListener('pointercancel', this._onPointerCancel);
    this.canvas.addEventListener('wheel',         this._onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu',   this._onContextMenu);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
    window.addEventListener('blur',    this._onBlur);
    window.addEventListener('resize',  this._onResize);
  }

  private detachListeners(): void {
    this.canvas.removeEventListener('pointerdown',   this._onPointerDown);
    this.canvas.removeEventListener('pointerup',     this._onPointerUp);
    this.canvas.removeEventListener('pointermove',   this._onPointerMove);
    this.canvas.removeEventListener('pointercancel', this._onPointerCancel);
    this.canvas.removeEventListener('wheel',         this._onWheel);
    this.canvas.removeEventListener('contextmenu',   this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    window.removeEventListener('blur',    this._onBlur);
    window.removeEventListener('resize',  this._onResize);
  }

  // Map a CSS-pixel client coord into HUD buffer coords (Y-up, origin at
  // bottom-left). Uses cached cssW/cssH (the actual canvas size after the
  // multiple-of-N rounding in resize), not window.innerWidth/Height.
  private clientToHud(clientX: number, clientY: number, out: { x: number; y: number }): void {
    out.x = clientX * (this.bufferW / this.cssW);
    out.y = (this.cssH - clientY) * (this.bufferH / this.cssH);
  }

  private onPointerDown(e: PointerEvent): void {
    // HUD click intercepts orbit so dragging-on-button doesn't move the camera.
    // HUD-claimed taps never enter the pointers map, so a follow-up second
    // finger won't trigger pinch from a half-tracked first finger.
    this.clientToHud(e.clientX, e.clientY, this._hudPt);
    if (this.hud.handleClick(this._hudPt.x, this._hudPt.y)) return;

    // Snapshot pre-add size so we can tell whether THIS pointerdown is
    // the 1→2 transition that starts a pinch, vs an extraneous third+
    // finger landing on top of an already-active pinch.
    const wasMulti = this.pointers.size >= 2;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Third (or later) finger landing mid-pinch — palm contact, accidental
    // tap, etc. Track the pointer so it gets cleaned up on lift, but do
    // NOT resnapshot or reset pinchMode; the user's locked mode and
    // gesture-start anchor must survive the brush.
    if (wasMulti) return;

    if (this.pointers.size >= 2) {
      // Second finger landed mid-drag → enter pinch and abandon the orbit
      // gesture. Without this hand-off, the first finger's pointermoves would
      // keep yawing/pitching the camera while the pinch is zooming.
      this.cancelLongPress();
      this.dragging = false;
      document.body.classList.remove('grabbing');
      this.pinching = true;
      this.pinchMode = 'undecided';
      this.pinchDist = this.measurePinch();
      this.pinchStartDist = this.pinchDist;
      this.capturePinchMid();
      this.pinchStartMidX = this.pinchMidX;
      this.pinchStartMidY = this.pinchMidY;
      this.capturePinchStart();
      return;
    }

    this.dragging = true;
    this.dragButton = e.button;
    this.lastX = e.clientX; this.lastY = e.clientY;
    this.downX = e.clientX; this.downY = e.clientY;
    document.body.classList.add('grabbing');

    // Touch-only long-press hook: hold a finger still on a star for
    // LONG_PRESS_MS and fireLongPress runs. Currently a console.info
    // placeholder; will be rebound to a real game action later. Mouse
    // and pen are excluded so a regular click doesn't accidentally
    // fire it. Cancelled by movement, second-finger entry, lift,
    // OS-cancel, or scene stop.
    if (e.pointerType === 'touch') {
      this.longPressPointerId = e.pointerId;
      this.longPressFired = false;
      const x = e.clientX, y = e.clientY;
      this.longPressTimer = window.setTimeout(() => this.fireLongPress(x, y), LONG_PRESS_MS);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const wasPinching = this.pinching;
    this.pointers.delete(e.pointerId);
    this.cancelLongPress();

    if (wasPinching) {
      // Stay in pinch mode while any pointer remains. Lifting one of two
      // fingers shouldn't snap straight back to orbit drag — the user is
      // mid-gesture and the lone finger may still be moving from the pinch.
      if (this.pointers.size === 0) {
        this.pinching = false;
        this.pinchDist = 0;
        this.pinchMode = 'undecided';
      }
      return;
    }

    // Long-press already fired its placeholder hook while the finger was
    // still down. Swallow the trailing pointerup so the same hold doesn't
    // also register as a tap-select-and-focus — preserves the original
    // contract for when fireLongPress gets rebound to a real action.
    if (this.longPressFired) {
      this.longPressFired = false;
      this.dragging = false;
      document.body.classList.remove('grabbing');
      return;
    }

    if (!this.dragging) return;
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    const isClick = moved < CLICK_DRAG_PX;
    const wasLeftClick  = this.dragButton === 0 && isClick;
    const wasRightClick = this.dragButton === 2 && isClick;
    this.dragging = false;
    document.body.classList.remove('grabbing');

    if (!isClick) return;
    const hit = this.pickStar(e.clientX, e.clientY);
    if (hit < 0) return;
    // Multi-star systems are selected as a unit: any member click resolves
    // to the cluster, and the reticle/dropline/info-card all operate on
    // the cluster rather than the clicked star. Empty-space clicks leave
    // selection unchanged. Right-click is held alive as a placeholder hook
    // (console.info) for a future game action; left-click selects AND
    // animates the orbit pivot to the cluster's COM (not the clicked
    // member's position), so a binary's two members both glide to the same
    // vantage.
    const clusterIdx = clusterIndexFor(hit);
    if (wasRightClick) {
      console.info('[scene] right-click hook on cluster', clusterIdx, STARS[STAR_CLUSTERS[clusterIdx].primary].name);
      return;
    }
    if (!wasLeftClick) return;
    this.selectAndFocusCluster(clusterIdx);
    // Double-click on the same cluster → open the system view. Reset the
    // window after firing so a triple-click doesn't fire twice. The first
    // click's focus glide is in flight when the second click lands; the
    // system-view transition disposes the starmap scene, killing the glide.
    const now = performance.now();
    if (now - this.lastClickAt < DOUBLE_CLICK_MS && this.lastClickClusterIdx === clusterIdx) {
      this.onViewSystem(clusterIdx);
      this.lastClickAt = 0;
      this.lastClickClusterIdx = -1;
    } else {
      this.lastClickAt = now;
      this.lastClickClusterIdx = clusterIdx;
    }
  }

  private onPointerCancel(e: PointerEvent): void {
    // Pointer cancelled by the OS (palm rejection, gesture stolen, etc).
    // Drop it from tracking and reset gesture state so the next gesture
    // starts clean.
    this.pointers.delete(e.pointerId);
    this.cancelLongPress();
    if (this.pointers.size < 2) this.pinchDist = 0;
    if (this.pointers.size === 0) {
      this.pinching = false;
      this.pinchMode = 'undecided';
      this.dragging = false;
      document.body.classList.remove('grabbing');
    }
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  // Placeholder long-touch hook. Currently logs to the console so the wiring
  // is observable in DevTools; rebind the body to a real game action when
  // touch long-press has something to do (context menu, secondary command,
  // etc). longPressFired is set so the trailing pointerup suppresses its
  // own click path — preserves the original contract for when this gets
  // rebound to something user-visible.
  private fireLongPress(clientX: number, clientY: number): void {
    this.longPressTimer = null;
    const hit = this.pickStar(clientX, clientY);
    if (hit < 0) return;
    const clusterIdx = clusterIndexFor(hit);
    console.info('[scene] long-press hook on cluster', clusterIdx, STARS[STAR_CLUSTERS[clusterIdx].primary].name);
    this.longPressFired = true;
  }

  // Shared select-and-focus action: binds the selection to the given cluster
  // and glides the orbit pivot onto its COM (not any one member's position),
  // so a binary's two members both glide to the same vantage. Called from
  // single-click in onPointerUp; future hooks (right-click, long-press,
  // context menu) can route through here when they need the same behavior.
  private selectAndFocusCluster(clusterIdx: number): void {
    this.selectedClusterIdx = clusterIdx;
    this.labels.setSelectedCluster(clusterIdx);
    this.hud.setSelectedCluster(clusterIdx);
    this.droplines.setSelectedCluster(clusterIdx);
    this.updateGridForSelection();
    // Focus button starts in the right state for the new selection
    // (without waiting for the next tick to repaint).
    this.updateSelectedFocusedState();
    const com = STAR_CLUSTERS[clusterIdx].com;
    this.animateFocusTo(com.x, com.y, com.z);
  }

  private onPointerMove(e: PointerEvent): void {
    // Hit-test the HUD layer first. Touch input has no hover semantics
    // (drop pointer regardless); mouse/pen leak to the world only when
    // the HUD is fully transparent at the cursor — anything 'opaque' or
    // 'interactive' must occlude scene picking, otherwise a star behind
    // a panel/button would still light up its hover label.
    this.clientToHud(e.clientX, e.clientY, this._hudPt);
    const hudHit = this.hud.hitTest(this._hudPt.x, this._hudPt.y);
    if (e.pointerType === 'touch' || hudHit !== 'transparent') {
      this.pointer.has = false;
    } else {
      this.pointer.x = e.clientX; this.pointer.y = e.clientY; this.pointer.has = true;
    }
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Cancel a pending long-press the moment the holding finger drifts
    // beyond LONG_PRESS_MOVE_PX from its press position — we'd rather
    // commit to orbit/pan than fire the hook under a moving finger.
    if (this.longPressTimer !== null && e.pointerId === this.longPressPointerId) {
      const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
      if (moved > LONG_PRESS_MOVE_PX) this.cancelLongPress();
    }

    if (this.pinching) {
      // Two-finger gesture stays 'undecided' (nothing applied) until
      // either sepDelta exceeds GESTURE_COMMIT_ZOOM_PX or midDelta
      // exceeds GESTURE_COMMIT_PAN_PX. The signal that overshoots its
      // own threshold by more locks the mode for the rest of the
      // gesture — they don't overlap, and a slight separation drift
      // mid-pan can't yank the zoom (and vice versa).
      if (this.pointers.size >= 2) {
        const d = this.measurePinch();
        const oldMidX = this.pinchMidX;
        const oldMidY = this.pinchMidY;
        this.capturePinchMid();

        if (this.pinchMode === 'undecided') {
          // Pan signal: Euclidean distance the midpoint has traveled.
          const midDelta = Math.hypot(
            this.pinchMidX - this.pinchStartMidX,
            this.pinchMidY - this.pinchStartMidY,
          );
          // Pinch signal: scalar change in finger separation. Gated by
          // the per-finger projections onto the start separation axis u
          // so that an asymmetric pan ALONG u (both fingers moving the
          // same way at different speeds) doesn't fake a separation
          // change. Three regimes:
          //   - opposite-sign projections → symmetric pinch, count it.
          //   - one finger below ACTIVE_PROJ_PX → anchor pinch (thumb
          //     fixed, index splays); the still finger's sign is just
          //     noise so count it regardless.
          //   - both above ACTIVE_PROJ_PX with matching sign → asymmetric
          //     pan along u, force sepDelta to 0.
          let sepDelta = 0;
          if (this.pinchStartDist > 0) {
            const it = this.pointers.values();
            const a = it.next().value!;
            const b = it.next().value!;
            const ux = (this.pinchStartBx - this.pinchStartAx) / this.pinchStartDist;
            const uy = (this.pinchStartBy - this.pinchStartAy) / this.pinchStartDist;
            const projA = (a.x - this.pinchStartAx) * ux + (a.y - this.pinchStartAy) * uy;
            const projB = (b.x - this.pinchStartBx) * ux + (b.y - this.pinchStartBy) * uy;
            const bothActive = Math.abs(projA) > ACTIVE_PROJ_PX && Math.abs(projB) > ACTIVE_PROJ_PX;
            const sameDirection = bothActive && projA * projB > 0;
            if (!sameDirection) sepDelta = Math.abs(d - this.pinchStartDist);
          }
          // Independent thresholds (zoom doubled because both fingers
          // contribute to separation change). Compare ratios so the
          // signal that overshoots its own threshold by more wins when
          // both cross in the same frame.
          const sepRatio = sepDelta / GESTURE_COMMIT_ZOOM_PX;
          const midRatio = midDelta / GESTURE_COMMIT_PAN_PX;
          if (Math.max(sepRatio, midRatio) >= 1) {
            this.pinchMode = sepRatio > midRatio ? 'zoom' : 'pan';
          }
        }

        if (this.pinchMode === 'zoom') {
          if (d > 0 && this.pinchDist > 0) this.setZoom(this.view.distance * (this.pinchDist / d));
          this.focusAnimating = false;
        } else if (this.pinchMode === 'pan') {
          const ddx = this.pinchMidX - oldMidX;
          const ddy = this.pinchMidY - oldMidY;
          if (ddx !== 0 || ddy !== 0) {
            // singleTouchAction = 'pan' swaps the camera-control mapping:
            // single touch becomes the panner, and the two-finger pan
            // gesture drives orbit. The disambiguator (pinch vs pan)
            // doesn't change — only what the 'pan' commit *does*.
            if (getSettings().singleTouchAction === 'pan') {
              this.applyOrbitDelta(ddx, ddy);
            } else {
              this.applyTouchPan(ddx, ddy);
            }
          }
          this.focusAnimating = false;
        }
        this.pinchDist = d;
      }
      return;
    }

    // Update HUD hover state. While actively dragging the camera we skip the
    // HUD hover update so the cursor doesn't lose its grabbing affordance.
    // Cursor follows hudHit so it only switches to pointer over an
    // interactive element — opaque chrome (panel bg, info card body)
    // keeps the default cursor.
    if (!this.dragging) {
      this.hud.handlePointerMove(this._hudPt.x, this._hudPt.y);
      this.canvas.style.cursor = hudHit === 'interactive' ? 'pointer' : '';
      return;
    }
    const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
    this.lastX = e.clientX; this.lastY = e.clientY;
    // Single-touch behavior is configurable: 'orbit' (default) yaws/pitches
    // the camera; 'pan' translates view.target along the camera's
    // screen-aligned axes, leaving orbit to the two-finger gesture. Mouse
    // and pen drags ignore the setting and always orbit — mice are
    // single-button by definition and 2-button "two-finger pan" doesn't
    // map cleanly to non-touch input.
    if (e.pointerType === 'touch' && getSettings().singleTouchAction === 'pan') {
      this.applyTouchPan(dx, dy);
    } else {
      this.applyOrbitDelta(dx, dy);
    }
  }

  private measurePinch(): number {
    const it = this.pointers.values();
    const a = it.next().value!;
    const b = it.next().value!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private capturePinchMid(): void {
    const it = this.pointers.values();
    const a = it.next().value!;
    const b = it.next().value!;
    this.pinchMidX = (a.x + b.x) * 0.5;
    this.pinchMidY = (a.y + b.y) * 0.5;
  }

  private capturePinchStart(): void {
    const it = this.pointers.values();
    const a = it.next().value!;
    const b = it.next().value!;
    this.pinchStartAx = a.x; this.pinchStartAy = a.y;
    this.pinchStartBx = b.x; this.pinchStartBy = b.y;
  }

  // Two-finger pan: midpoint translation drives view.target along the
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
    const lyPerPx = (2 * halfFovTan * this.view.distance) / this.cssH;
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
  // drag (the default) and two-finger pan-mode-when-singleTouchAction='pan'
  // — same sensitivity (0.005 rad/CSS px) so swapping the gesture
  // assignments doesn't change how fast the camera spins.
  private applyOrbitDelta(dxPx: number, dyPx: number): void {
    this.view.yaw   -= dxPx * 0.005;
    this.view.pitch -= dyPx * 0.005;
    this.view.pitch = Math.max(0.05, Math.min(Math.PI - 0.05, this.view.pitch));
  }

  // Keyboard: ESC dismisses selection; SPACE / F focus the camera on
  // the current selection (re-runs the same focus glide that single-click
  // already performs on a star); WASD pans the orbit pivot parallel to
  // the galactic plane (camera follows by the same vector, distance
  // preserved); QE orbits around the pivot. Listening on window so it
  // fires regardless of focus, since the canvas itself isn't focusable.
  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.deselect();
      return;
    }
    if (e.key === ' ' || e.key === 'f' || e.key === 'F') {
      // Skip Cmd/Ctrl/Alt+F so the browser's find shortcut still works.
      // Spacebar has no such conflict.
      if (e.key !== ' ' && (e.ctrlKey || e.metaKey || e.altKey)) return;
      if (this.selectedClusterIdx >= 0) {
        const com = STAR_CLUSTERS[this.selectedClusterIdx].com;
        this.animateFocusTo(com.x, com.y, com.z);
      }
      // preventDefault even on no-op — spacebar would otherwise scroll
      // the page (visible if the canvas is shorter than the viewport
      // after the multiple-of-N rounding in resize).
      e.preventDefault();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'q' || k === 'e' || k === 'z' || k === 'x') {
      // Skip when a browser-shortcut modifier is held (Cmd+W close tab,
      // Ctrl+S save, Alt+D address-bar focus, etc.) — let the browser have
      // those. Shift stays live so it remains available for future tuning
      // (e.g. boost) without breaking shortcuts.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      this.heldKeys.add(k);
      // User taking manual control cancels any in-flight focus glide,
      // otherwise the lerp would fight the WASD translation.
      this.focusAnimating = false;
      e.preventDefault();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.heldKeys.delete(e.key.toLowerCase());
  }

  // Per-frame WASD/QE/ZX update. Forward and right are derived from yaw alone
  // (no pitch term) so WASD pans parallel to the galactic plane regardless
  // of camera tilt — looking down at a star and pressing W glides across
  // the plane instead of plunging into it. Pitch is clamped < π so the
  // camera always has a well-defined yaw direction. Z/X translate along
  // world up (galactic plane normal) so they sink/lift the view.
  private applyHeldKeys(dt: number): void {
    if (this.heldKeys.size === 0) return;

    const sy = Math.sin(this.view.yaw);
    const cy = Math.cos(this.view.yaw);
    // Camera = target + R*(sp*cy, sp*sy, cp); the horizontal projection of
    // (target - camera) drops the cp term. Already unit length: cy² + sy² = 1.
    this._forward.set(-cy, -sy, 0);
    this._right.crossVectors(this._forward, StarmapScene.WORLD_UP).normalize();

    this._step.set(0, 0, 0);
    if (this.heldKeys.has('w')) this._step.add(this._forward);
    if (this.heldKeys.has('s')) this._step.sub(this._forward);
    if (this.heldKeys.has('d')) this._step.add(this._right);
    if (this.heldKeys.has('a')) this._step.sub(this._right);
    if (this.heldKeys.has('x')) this._step.add(StarmapScene.WORLD_UP);
    if (this.heldKeys.has('z')) this._step.sub(StarmapScene.WORLD_UP);
    if (this._step.lengthSq() > 0) {
      this._step.normalize().multiplyScalar(this.view.distance * PAN_RATE_PER_DISTANCE * dt);
      this.view.target.add(this._step);
    }

    if (this.heldKeys.has('q')) this.view.yaw += ORBIT_RATE_RAD * dt;
    if (this.heldKeys.has('e')) this.view.yaw -= ORBIT_RATE_RAD * dt;
  }

  private deselect(): void {
    this.selectedClusterIdx = -1;
    this.labels.setSelectedCluster(-1);
    this.hud.setSelectedCluster(-1);
    this.droplines.setSelectedCluster(-1);
    this.updateGridForSelection();
  }

  // Range rings + axes + galactic-centre arrow are locked to the currently
  // selected cluster, not the orbital pivot — they're a "this is the system
  // you're inspecting" landmark, not a HUD chrome that follows the camera.
  // No selection → grid hidden entirely (the catalog read as plain stars
  // until the user picks one to explore). Droplines mirror this gating in
  // Droplines.update() and drop to the selected cluster's COM.z plane.
  private updateGridForSelection(): void {
    if (this.selectedClusterIdx >= 0) {
      const com = STAR_CLUSTERS[this.selectedClusterIdx].com;
      this.grid.group.position.set(com.x, com.y, com.z);
      this.grid.group.visible = true;
    } else {
      this.grid.group.visible = false;
    }
  }

  // Push the Focus button's enabled/disabled state to the HUD. Disabled
  // when view.target sits on the selected cluster's COM (i.e. the camera
  // is already focused on it). No-op when nothing is selected — the
  // focus button is hidden in that case anyway. The HUD's setter is
  // gated, so calling this every frame only allocates on transition.
  private updateSelectedFocusedState(): void {
    if (this.selectedClusterIdx < 0) return;
    const com = STAR_CLUSTERS[this.selectedClusterIdx].com;
    const dx = this.view.target.x - com.x;
    const dy = this.view.target.y - com.y;
    const dz = this.view.target.z - com.z;
    const focused = (dx * dx + dy * dy + dz * dz) < FOCUS_EPSILON_SQ;
    this.hud.setSelectedFocused(focused);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.setZoom(this.view.distance * Math.pow(1.0015, e.deltaY));
  }

  // -- camera + zoom -----------------------------------------------------

  private setZoom(d: number): void {
    this.view.distance = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, d));
  }

  private pickStar(clientX: number, clientY: number): number {
    this._ndc.set(
      (clientX / this.cssW) * 2 - 1,
      -(clientY / this.cssH) * 2 + 1,
    );
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.starPoints.points);
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
    // The browser's image-rendering: pixelated upscale is only exactly N:1
    // when (CSS_px × DPR) is divisible by N — i.e. the target physical-pixel
    // dimension is a multiple of N. If it isn't, the browser distributes the
    // remainder by making one buffer-pixel-wide column every (~CSS_px) actual
    // columns span (N-1) physical pixels instead of N. Labels rendered on
    // top of those compressed columns get visibly mangled (one bitmap column
    // squashed into 2 physical px instead of 3). The artifact appears to
    // "follow" labels as the camera rotates because the labels move across
    // the buffer and cross those fixed compressed columns at different
    // points within the bitmap.
    //
    // Fix: round target physical pixels DOWN to a multiple of N, then derive
    // CSS and buffer from that. Up to (N-1) physical pixels of black bezel
    // can show on the right/bottom — invisible against the dark scene.
    const dpr = window.devicePixelRatio;
    // Auto N from the observer biased by the user's resolution preference
    // (low=+1 chunkier, high=-1 sharper, medium=auto). Pulled fresh per
    // resize so flipping the radio re-applies on the next tick without
    // needing extra plumbing.
    const N = effectiveScale(this.renderScale.scale, getSettings().resolutionPreference);
    const physW = Math.floor(window.innerWidth  * dpr / N) * N;
    const physH = Math.floor(window.innerHeight * dpr / N) * N;
    const cssW = physW / dpr;
    const cssH = physH / dpr;
    this.renderer.setPixelRatio(dpr / N);
    this.renderer.setSize(cssW, cssH);
    this.cssW = cssW;
    this.cssH = cssH;
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    this.renderer.getDrawingBufferSize(this._buf);
    this.bufferW = this._buf.x;
    this.bufferH = this._buf.y;
    this.starPoints.setPxScale(this.bufferH / 2);
    this.labels.setPxScale(this.bufferH / 2);
    setSnappedLineViewport(this.bufferW, this.bufferH);
    this.hud.resize(this.bufferW, this.bufferH);
    this.labels.resize(this.bufferW, this.bufferH);
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

    if (this.view.spin) this.view.yaw += 0.0015;
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
    this.updateSelectedFocusedState();

    this.starPoints.setFocus(this.view.target);

    // Hover detection — pick the star whose ray-distance is smallest, then
    // share the cluster-mapped index with both the label overlay (boxed-hover
    // variant) and the droplines (always-show-on-hover override).
    const hovered = this.pointer.has ? this.pickStar(this.pointer.x, this.pointer.y) : -1;
    const hoveredCluster = hovered >= 0 ? clusterIndexFor(hovered) : -1;
    this.labels.setHovered(hovered);
    this.droplines.setHovered(hoveredCluster);
    this.droplines.update(this.camera, this.view.target);
    this.labels.update(this.camera, this.view.target);

    this.renderer.render(this.scene, this.camera);
    // Overlay passes — disable autoClear so the second/third renders don't
    // wipe the first. Both overlays use depthTest: false to always overlay.
    this.renderer.autoClear = false;
    this.renderer.render(this.labels.scene, this.labels.camera);
    this.renderer.render(this.hud.scene, this.hud.camera);
    this.renderer.autoClear = true;
    this.rafId = requestAnimationFrame(this.tick);
  };
}
