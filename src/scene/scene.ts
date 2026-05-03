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
import { setSnappedLineViewport, setDashPatternScale } from './materials';
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
const DEFAULT_VIEW = { distance: 50, yaw: 0.9, pitch: 0.55 };

// Each render-buffer ("env") pixel is upscaled by the browser into this many
// physical screen pixels via image-rendering: pixelated. Larger = chunkier
// pixel-art look + fewer GPU pixels (perf bonus, 1/N² fragments).
const ENV_PX_PER_SCREEN_PX = 3;

// Right-click without dragging more than this many CSS pixels is treated as
// a focus gesture. Forgiving enough to absorb hand jitter on a press.
const CLICK_DRAG_PX = 4;

// Focus animation: only view.target lerps; yaw/pitch/distance stay frozen so
// the camera glides over to the new orbital pivot rather than swinging.
const FOCUS_ANIM_MS = 400;

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
  private pinchDist = 0;
  private readonly pointer = { x: 0, y: 0, has: false };

  // Focus animation: view.target lerps from focusFrom → focusTo over
  // FOCUS_ANIM_MS. The camera sphere slides with it; nothing else animates.
  private readonly focusFrom = new Vector3();
  private readonly focusTo = new Vector3();
  private focusAnimStart = 0;
  private focusAnimating = false;

  private rafId = 0;
  private running = false;

  // Bound listeners stored so removeEventListener works in stop().
  private readonly _onPointerDown = (e: PointerEvent) => this.onPointerDown(e);
  private readonly _onPointerUp   = (e: PointerEvent) => this.onPointerUp(e);
  private readonly _onPointerMove = (e: PointerEvent) => this.onPointerMove(e);
  private readonly _onWheel       = (e: WheelEvent) => this.onWheel(e);
  private readonly _onContextMenu = (e: Event) => e.preventDefault();
  private readonly _onTouchMove   = (e: TouchEvent) => this.onTouchMove(e);
  private readonly _onTouchEnd    = () => { this.pinchDist = 0; };
  private readonly _onResize      = () => this.resize();

  // Reusable per-frame scratch.
  private readonly _ndc  = new Vector2();
  private readonly _buf  = new Vector2();
  private readonly _hudPt = { x: 0, y: 0 };

  // Cached drawing-buffer dimensions, populated by resize(). All pixel-aware
  // shader work uses these — NOT window.innerWidth/Height — because the
  // buffer is smaller than CSS px once pixelRatio drops below 1.
  private bufferW = 0;
  private bufferH = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const sun = STARS.find(s => s.name === 'Sun')!;
    this.view = {
      target: new Vector3(sun.x, sun.y, sun.z),
      ...DEFAULT_VIEW,
      spin: false,
    };

    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false });
    // Render buffer = (CSS px) × (devicePixelRatio / N). The browser then
    // nearest-neighbor upscales the canvas back to its CSS box, so 1 render
    // pixel becomes N×N physical pixels. Picking the ratio this way means
    // the on-screen pixel size is independent of the user's actual DPR.
    this.renderer.setPixelRatio(window.devicePixelRatio / ENV_PX_PER_SCREEN_PX);
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
      else if (id === 'drops') this.droplines.group.visible = on;
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
  }

  // -- listeners ---------------------------------------------------------

  private attachListeners(): void {
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointerup',   this._onPointerUp);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('wheel',       this._onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    this.canvas.addEventListener('touchmove',   this._onTouchMove, { passive: false });
    this.canvas.addEventListener('touchend',    this._onTouchEnd);
    window.addEventListener('resize',  this._onResize);
  }

  private detachListeners(): void {
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointerup',   this._onPointerUp);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('wheel',       this._onWheel);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    this.canvas.removeEventListener('touchmove',   this._onTouchMove);
    this.canvas.removeEventListener('touchend',    this._onTouchEnd);
    window.removeEventListener('resize',  this._onResize);
  }

  // Map a CSS-pixel client coord into HUD buffer coords (Y-up, origin at
  // bottom-left).
  private clientToHud(clientX: number, clientY: number, out: { x: number; y: number }): void {
    out.x = clientX * (this.bufferW / window.innerWidth);
    out.y = (window.innerHeight - clientY) * (this.bufferH / window.innerHeight);
  }

  private onPointerDown(e: PointerEvent): void {
    // HUD click intercepts orbit so dragging-on-button doesn't move the camera.
    this.clientToHud(e.clientX, e.clientY, this._hudPt);
    if (this.hud.handleClick(this._hudPt.x, this._hudPt.y)) return;

    this.dragging = true;
    this.dragButton = e.button;
    this.lastX = e.clientX; this.lastY = e.clientY;
    this.downX = e.clientX; this.downY = e.clientY;
    document.body.classList.add('grabbing');
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.dragging) return;
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    const wasRightClick = this.dragButton === 2 && moved < CLICK_DRAG_PX;
    this.dragging = false;
    document.body.classList.remove('grabbing');

    if (wasRightClick) {
      const hit = this.pickStar(e.clientX, e.clientY);
      if (hit >= 0) {
        const s = STARS[hit];
        this.animateFocusTo(s.x, s.y, s.z);
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    this.pointer.x = e.clientX; this.pointer.y = e.clientY; this.pointer.has = true;
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

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.setZoom(this.view.distance * Math.pow(1.0015, e.deltaY));
  }

  private onTouchMove(e: TouchEvent): void {
    if (e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (this.pinchDist > 0) this.setZoom(this.view.distance * (this.pinchDist / d));
      this.pinchDist = d;
      e.preventDefault();
    }
  }

  // -- camera + zoom -----------------------------------------------------

  private setZoom(d: number): void {
    this.view.distance = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, d));
  }

  private pickStar(clientX: number, clientY: number): number {
    this._ndc.set(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
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
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.getDrawingBufferSize(this._buf);
    this.bufferW = this._buf.x;
    this.bufferH = this._buf.y;
    this.starPoints.setPxScale(this.bufferH / 2);
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

    if (this.view.spin) this.view.yaw += 0.0015;

    if (this.focusAnimating) {
      const t = Math.min(1, (performance.now() - this.focusAnimStart) / FOCUS_ANIM_MS);
      // Ease-in-out cubic: smooth at both ends, no overshoot.
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.view.target.lerpVectors(this.focusFrom, this.focusTo, e);
      if (t >= 1) {
        this.view.target.copy(this.focusTo);
        this.focusAnimating = false;
      }
    }

    this.updateCamera();
    this.emitScale();

    // Dropline dash gap scales with orbit radius so the count of dashes per
    // line stays roughly constant across zoom levels. Floored at 1.0 so the
    // pattern never collapses to solid when zoomed far out.
    setDashPatternScale(Math.max(1, DEFAULT_VIEW.distance / this.view.distance));

    this.grid.update(this.camera.position.x, this.camera.position.y, this.view.target.x, this.view.target.y);
    this.droplines.update(this.camera);

    // Hover detection — pick the star whose ray-distance is smallest.
    const hovered = this.pointer.has ? this.pickStar(this.pointer.x, this.pointer.y) : -1;
    this.labels.setHovered(hovered);
    this.labels.update(this.camera);

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
