import {
  ColorManagement,
  LinearSRGBColorSpace,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

// Opt out of Three.js color management. Without this, hex values in shader
// uniforms (new Color(0x1e6fc4)) and hex strings in canvas fillStyle
// ('#1e6fc4') end up rendering at *different* on-screen colors because the
// two paths get different sRGB↔linear conversions. The whole project's
// palette is hand-picked sRGB values intended to render literally, so we
// turn off both color-management transforms (input and output) and let the
// renderer just write raw sRGB to the framebuffer.
ColorManagement.enabled = false;
import { Grid } from './grid';
import { Droplines } from './droplines';
import { Labels } from './labels';
import { StarPoints } from './stars';
import { setSnappedLineViewport } from './materials';
import { Hud } from './hud';
import { STARS } from '../data/stars';

// Orbit radius bounds (camera-to-target ly). Replaces the old ortho frustum
// height; under perspective, distance directly drives apparent size of
// objects at the focus.
const ZOOM_MIN = 4;
const ZOOM_MAX = 150;
const FOV_DEG = 45;
const NEAR = 0.1;
const FAR = 1000;
const NICE_STEPS = [20, 10, 5, 2.5, 1, 0.5, 0.2, 0.1];
const DEFAULT_VIEW = { distance: 50, yaw: 1.1, pitch: 1.2 };

// Each render-buffer ("env") pixel is upscaled by the browser into this many
// physical screen pixels via image-rendering: pixelated. Larger = chunkier
// pixel-art look + fewer GPU pixels (perf bonus, 1/N² fragments).
const ENV_PX_PER_SCREEN_PX = 3;

// A pointer release that moved less than this many CSS pixels from its
// pressdown counts as a click (vs the start of an orbit drag). Forgiving
// enough to absorb hand jitter on a press.
const CLICK_DRAG_PX = 4;

// Two-finger gesture classifier threshold (CSS px). On the first move that
// crosses this in either separation OR midpoint translation, the gesture
// commits to zoom or pan and locks in for the rest of the gesture. Bigger
// = harder to commit (more sampling, less twitchy); smaller = snappier
// commit but more chance of misclassification on noise.
const GESTURE_COMMIT_PX = 6;

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
  private readonly hud: Hud;

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
  // Snapshot of dist + mid at gesture start, used by the undecided-mode
  // classifier: whichever delta crosses GESTURE_COMMIT_PX first wins.
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
  // Selection state lives in Labels (reticle) and Hud (info card) — Scene
  // routes click events to both but doesn't hold a copy itself.

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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const sun = STARS.find(s => s.name === 'Sun')!;
    this.view = {
      target: new Vector3(sun.x, sun.y, sun.z),
      ...DEFAULT_VIEW,
      spin: false,
    };

    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false });
    // Pixel ratio is set in resize() so a DPR change (e.g. browser zoom) gets
    // re-applied. Render buffer = (CSS px) × (DPR / N); the browser then
    // nearest-neighbor upscales the canvas back to its CSS box, so 1 buffer
    // pixel becomes N×N physical pixels — but only when CSS × DPR is divisible
    // by N. resize() rounds the target physical-pixel count down to a multiple
    // of N to guarantee an exact N:1 upscale. See resize() for the why.
    this.renderer.setClearColor(0x000008, 1);
    // Match the disabled ColorManagement at the top of this file.
    this.renderer.outputColorSpace = LinearSRGBColorSpace;

    // PerspectiveCamera. Drop-lines now converge toward a vanishing point —
    // an intentional break with the old ortho "parallel pin" geometry, in
    // exchange for honest 3D depth cueing.
    this.camera = new PerspectiveCamera(FOV_DEG, 1, NEAR, FAR);

    this.raycaster.params.Points = { threshold: 0.6 };

    this.grid = new Grid();
    this.scene.add(this.grid.group);

    this.starPoints = new StarPoints(window.innerHeight / 2);
    this.scene.add(this.starPoints.points);

    this.droplines = new Droplines();
    this.scene.add(this.droplines.group);

    this.labels = new Labels();

    this.hud = new Hud();
    this.hud.onToggle = (id, on) => {
      if (id === 'labels') this.labels.setShowLabels(on);
      else if (id === 'drops') this.droplines.setMasterVisible(on);
      else if (id === 'spin') this.view.spin = on;
    };
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

    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size >= 2) {
      // Second finger landed mid-drag → enter pinch and abandon the orbit
      // gesture. Without this hand-off, the first finger's pointermoves would
      // keep yawing/pitching the camera while the pinch is zooming.
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
  }

  private onPointerUp(e: PointerEvent): void {
    const wasPinching = this.pinching;
    this.pointers.delete(e.pointerId);

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
    // Left-click: select AND focus. Right-click: select only. Empty-space
    // clicks leave selection unchanged (no accidental deselect on a near-miss).
    this.labels.setSelected(hit);
    this.hud.setSelectedStar(hit);
    this.droplines.setSelected(hit);
    if (wasLeftClick) {
      const s = STARS[hit];
      this.animateFocusTo(s.x, s.y, s.z);
    }
    void wasRightClick;
  }

  private onPointerCancel(e: PointerEvent): void {
    // Pointer cancelled by the OS (palm rejection, gesture stolen, etc).
    // Drop it from tracking and reset gesture state so the next gesture
    // starts clean.
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;
    if (this.pointers.size === 0) {
      this.pinching = false;
      this.pinchMode = 'undecided';
      this.dragging = false;
      document.body.classList.remove('grabbing');
    }
  }

  private onPointerMove(e: PointerEvent): void {
    // Touch input has no hover semantics — a finger crossing a star mid-drag
    // or mid-pinch shouldn't surface the tooltip. Mouse/pen still get hover.
    if (e.pointerType === 'touch') {
      this.pointer.has = false;
    } else {
      this.pointer.x = e.clientX; this.pointer.y = e.clientY; this.pointer.has = true;
    }
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (this.pinching) {
      // Two-finger gesture commits to zoom or pan on first significant
      // move and stays locked for the rest of the gesture — they don't
      // overlap. Whichever delta crosses GESTURE_COMMIT_PX first wins:
      // separation → zoom; midpoint translation → pan.
      if (this.pointers.size >= 2) {
        const d = this.measurePinch();
        const oldMidX = this.pinchMidX;
        const oldMidY = this.pinchMidY;
        this.capturePinchMid();

        if (this.pinchMode === 'undecided') {
          // Project each finger's from-start displacement onto the start
          // separation axis u. Three regimes:
          //   - opposite signs → symmetric pinch (count sepDelta).
          //   - one finger below ACTIVE_PROJ_PX → anchor pinch, e.g. thumb
          //     fixed while index splays; count sepDelta even if signs
          //     happen to match (the still finger's sign is just noise).
          //   - both above ACTIVE_PROJ_PX with matching sign → asymmetric
          //     pan along u; force sepDelta to 0 so it can't outrun
          //     midDelta and steal the commit.
          const it = this.pointers.values();
          const a = it.next().value!;
          const b = it.next().value!;
          let sepDelta = 0;
          if (this.pinchStartDist > 0) {
            const ux = (this.pinchStartBx - this.pinchStartAx) / this.pinchStartDist;
            const uy = (this.pinchStartBy - this.pinchStartAy) / this.pinchStartDist;
            const projA = (a.x - this.pinchStartAx) * ux + (a.y - this.pinchStartAy) * uy;
            const projB = (b.x - this.pinchStartBx) * ux + (b.y - this.pinchStartBy) * uy;
            const bothActive = Math.abs(projA) > ACTIVE_PROJ_PX && Math.abs(projB) > ACTIVE_PROJ_PX;
            const sameDirection = bothActive && projA * projB > 0;
            if (!sameDirection) sepDelta = Math.abs(projB - projA);
          }
          const midDelta = Math.hypot(
            this.pinchMidX - this.pinchStartMidX,
            this.pinchMidY - this.pinchStartMidY,
          );
          if (Math.max(sepDelta, midDelta) >= GESTURE_COMMIT_PX) {
            this.pinchMode = sepDelta > midDelta ? 'zoom' : 'pan';
          }
        }

        if (this.pinchMode === 'zoom') {
          if (d > 0 && this.pinchDist > 0) this.setZoom(this.view.distance * (this.pinchDist / d));
          this.focusAnimating = false;
        } else if (this.pinchMode === 'pan') {
          const ddx = this.pinchMidX - oldMidX;
          const ddy = this.pinchMidY - oldMidY;
          if (ddx !== 0 || ddy !== 0) this.applyTouchPan(ddx, ddy);
          this.focusAnimating = false;
        }
        this.pinchDist = d;
      }
      return;
    }

    // Update HUD hover state. While actively dragging the camera we skip the
    // HUD hover update so the cursor doesn't lose its grabbing affordance.
    if (!this.dragging) {
      this.clientToHud(e.clientX, e.clientY, this._hudPt);
      const onButton = this.hud.handlePointerMove(this._hudPt.x, this._hudPt.y);
      this.canvas.style.cursor = onButton ? 'pointer' : '';
      return;
    }
    const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
    this.lastX = e.clientX; this.lastY = e.clientY;
    this.view.yaw   -= dx * 0.005;
    this.view.pitch -= dy * 0.005;
    this.view.pitch = Math.max(0.05, Math.min(Math.PI - 0.05, this.view.pitch));
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

  // Two-finger pan: midpoint translation drives view.target along the same
  // plane-parallel forward/right basis as WASD (yaw-derived, pitch ignored).
  // Direction is "world tracks the fingers": drag fingers right → world
  // shifts right under the fingers (target moves left); drag fingers down
  // (dy>0) → world shifts down (target moves backward). Pixel delta is
  // converted to world units via the focus-plane scale, so a finger moving
  // N CSS px shifts the world by exactly N px at the focus distance — the
  // point under the finger stays under the finger.
  private applyTouchPan(dxPx: number, dyPx: number): void {
    const halfFovTan = Math.tan((FOV_DEG * Math.PI / 180) * 0.5);
    const lyPerPx = (2 * halfFovTan * this.view.distance) / this.cssH;
    const sy = Math.sin(this.view.yaw);
    const cy = Math.cos(this.view.yaw);
    this._forward.set(-cy, -sy, 0);
    this._right.crossVectors(this._forward, StarmapScene.WORLD_UP).normalize();
    this._step.copy(this._right).multiplyScalar(-dxPx * lyPerPx);
    this._step.addScaledVector(this._forward, dyPx * lyPerPx);
    this.view.target.add(this._step);
  }

  // Keyboard: ESC dismisses selection; WASD pans the orbit pivot parallel
  // to the galactic plane (camera follows by the same vector, distance
  // preserved); QE orbits around the pivot. Listening on window so it
  // fires regardless of focus, since the canvas itself isn't focusable.
  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.deselect();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'q' || k === 'e') {
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

  // Per-frame WASD/QE update. Forward and right are derived from yaw alone
  // (no pitch term) so WASD pans parallel to the galactic plane regardless
  // of camera tilt — looking down at a star and pressing W glides across
  // the plane instead of plunging into it. Pitch is clamped < π so the
  // camera always has a well-defined yaw direction.
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
    if (this._step.lengthSq() > 0) {
      this._step.normalize().multiplyScalar(this.view.distance * PAN_RATE_PER_DISTANCE * dt);
      this.view.target.add(this._step);
    }

    if (this.heldKeys.has('q')) this.view.yaw += ORBIT_RATE_RAD * dt;
    if (this.heldKeys.has('e')) this.view.yaw -= ORBIT_RATE_RAD * dt;
  }

  private deselect(): void {
    this.labels.setSelected(-1);
    this.hud.setSelectedStar(-1);
    this.droplines.setSelected(-1);
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
    const physW = Math.floor(window.innerWidth  * dpr / ENV_PX_PER_SCREEN_PX) * ENV_PX_PER_SCREEN_PX;
    const physH = Math.floor(window.innerHeight * dpr / ENV_PX_PER_SCREEN_PX) * ENV_PX_PER_SCREEN_PX;
    const cssW = physW / dpr;
    const cssH = physH / dpr;
    this.renderer.setPixelRatio(dpr / ENV_PX_PER_SCREEN_PX);
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

  // Scale bar measures size at the focused-star plane (camera-to-target
  // distance). Px-per-ly there = bufferH / (2 · tan(fov/2) · distance).
  private emitScale(): void {
    const halfFovTan = Math.tan((FOV_DEG * Math.PI / 180) * 0.5);
    const pxPerLy = this.bufferH / (2 * halfFovTan * this.view.distance);
    let chosen = NICE_STEPS[NICE_STEPS.length - 1];
    for (const step of NICE_STEPS) {
      if (step * pxPerLy <= 150) { chosen = step; break; }
    }
    this.hud.setScale(chosen, Math.round(chosen * pxPerLy));
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
    this.emitScale();

    this.grid.update(this.camera.position.x, this.camera.position.y, this.view.target.x, this.view.target.y);
    this.droplines.update(this.camera);
    this.starPoints.setFocus(this.view.target);

    // Hover detection — pick the star whose ray-distance is smallest.
    const hovered = this.pointer.has ? this.pickStar(this.pointer.x, this.pointer.y) : -1;
    this.labels.setHovered(hovered);
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
