import {
  OrthographicCamera,
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

const ZOOM_MIN = 8;
const ZOOM_MAX = 200;
const NICE_STEPS = [20, 10, 5, 2.5, 1, 0.5, 0.2, 0.1];
const DEFAULT_VIEW = { distance: 50, yaw: 0.9, pitch: 0.55 };

export interface ScaleInfo {
  step: number;
  widthPx: number;
}

export interface StarmapSceneOptions {
  onScale?: (info: ScaleInfo) => void;
}

interface ViewState {
  target: Vector3;
  distance: number;  // ortho frustum HEIGHT in ly (zoom)
  yaw: number;
  pitch: number;
  spin: boolean;
}

const KEYS = ['w', 'a', 's', 'd', 'q', 'e'] as const;
type KeyName = typeof KEYS[number];

export class StarmapScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly camera: OrthographicCamera;
  private readonly scene = new Scene();
  private readonly view: ViewState;
  private readonly raycaster = new Raycaster();
  private readonly grid: Grid;
  private readonly droplines: Droplines;
  private readonly labels: Labels;
  private readonly starPoints: StarPoints;
  private readonly opts: StarmapSceneOptions;

  // Orbit input state.
  private dragging = false;
  private panning = false;
  private lastX = 0;
  private lastY = 0;
  private pinchDist = 0;
  private readonly pointer = { x: 0, y: 0, has: false };
  private readonly keys: Record<KeyName, boolean> = { w: false, a: false, s: false, d: false, q: false, e: false };

  private rafId = 0;
  private running = false;

  // Bound listeners stored so removeEventListener works in stop().
  private readonly _onPointerDown = (e: PointerEvent) => this.onPointerDown(e);
  private readonly _onPointerUp   = () => this.onPointerUp();
  private readonly _onPointerMove = (e: PointerEvent) => this.onPointerMove(e);
  private readonly _onWheel       = (e: WheelEvent) => this.onWheel(e);
  private readonly _onContextMenu = (e: Event) => e.preventDefault();
  private readonly _onTouchMove   = (e: TouchEvent) => this.onTouchMove(e);
  private readonly _onTouchEnd    = () => { this.pinchDist = 0; };
  private readonly _onKeyDown     = (e: KeyboardEvent) => this.onKeyDown(e);
  private readonly _onKeyUp       = (e: KeyboardEvent) => this.onKeyUp(e);
  private readonly _onResize      = () => this.resize();

  // Reusable per-frame scratch.
  private readonly _tmp1 = new Vector3();
  private readonly _ndc  = new Vector2();

  constructor(canvas: HTMLCanvasElement, opts: StarmapSceneOptions = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.view = {
      target: new Vector3(0, 0, 0),
      ...DEFAULT_VIEW,
      spin: false,
    };

    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false });
    // Pin render buffer to 1 CSS pixel per drawn pixel. On hi-DPI displays
    // the default 2x/3x ratio makes gl.LINES render at 1 *physical* pixel
    // (= 0.5 or 0.33 CSS px), causing sub-pixel shimmer. Forcing 1:1 gives
    // true 1-CSS-pixel lines at the cost of slightly chunkier stars/grid —
    // which actually suits the pixel-art aesthetic.
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000008, 1);

    // Orthographic keeps drop-lines truly parallel (critical for the
    // "pin to plane" geometry) and matches the reference illustration's feel.
    this.camera = new OrthographicCamera(-1, 1, 1, -1, -500, 500);

    this.raycaster.params.Points = { threshold: 0.6 };

    this.grid = new Grid();
    this.scene.add(this.grid.group);

    this.starPoints = new StarPoints(window.innerHeight / 2);
    this.scene.add(this.starPoints.points);

    this.droplines = new Droplines();
    this.scene.add(this.droplines.group);

    this.labels = new Labels(this.scene);
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

  setShowLabels(show: boolean): void {
    this.labels.setShowLabels(show);
  }

  setShowDroplines(show: boolean): void {
    this.droplines.group.visible = show;
  }

  setSpin(spin: boolean): void {
    this.view.spin = spin;
  }

  reset(): void {
    this.view.target.set(0, 0, 0);
    this.view.distance = DEFAULT_VIEW.distance;
    this.view.yaw      = DEFAULT_VIEW.yaw;
    this.view.pitch    = DEFAULT_VIEW.pitch;
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
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
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
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    window.removeEventListener('resize',  this._onResize);
  }

  private onPointerDown(e: PointerEvent): void {
    this.dragging = true;
    this.panning = e.shiftKey || e.button === 2;
    this.lastX = e.clientX; this.lastY = e.clientY;
    document.body.classList.add('grabbing');
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerUp(): void {
    this.dragging = false; this.panning = false;
    document.body.classList.remove('grabbing');
  }

  private onPointerMove(e: PointerEvent): void {
    this.pointer.x = e.clientX; this.pointer.y = e.clientY; this.pointer.has = true;
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
    this.lastX = e.clientX; this.lastY = e.clientY;
    if (this.panning) {
      const s = this.view.distance * 0.0015;
      const right = new Vector3(), up = new Vector3();
      this.camera.matrixWorld.extractBasis(right, up, this._tmp1);
      this.view.target.addScaledVector(right, -dx * s);
      this.view.target.addScaledVector(up,     dy * s);
    } else {
      this.view.yaw   -= dx * 0.005;
      this.view.pitch -= dy * 0.005;
      this.view.pitch = Math.max(0.05, Math.min(Math.PI - 0.05, this.view.pitch));
    }
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

  private onKeyDown(e: KeyboardEvent): void {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase() as KeyName;
    if (k in this.keys) { this.keys[k] = true; e.preventDefault(); }
  }

  private onKeyUp(e: KeyboardEvent): void {
    const k = e.key.toLowerCase() as KeyName;
    if (k in this.keys) this.keys[k] = false;
  }

  // -- camera + zoom -----------------------------------------------------

  private setZoom(d: number): void {
    this.view.distance = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, d));
  }

  // Camera POSITION orbits the target on a sphere of fixed radius; the ortho
  // frustum bounds handle zoom independently of camera position.
  private updateCamera(): void {
    const R = 200;
    const sp = Math.sin(this.view.pitch), cp = Math.cos(this.view.pitch);
    const sy = Math.sin(this.view.yaw),   cy = Math.cos(this.view.yaw);
    this.camera.position.set(
      this.view.target.x + R * sp * cy,
      this.view.target.y + R * sp * sy,
      this.view.target.z + R * cp,
    );
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(this.view.target);
    // Force matrixWorldInverse refresh now so label projections and sprite
    // billboarding this frame see the same transform the renderer will.
    this.camera.updateMatrixWorld(true);

    const aspect = window.innerWidth / window.innerHeight;
    const halfH = this.view.distance * 0.5;
    const halfW = halfH * aspect;
    this.camera.left = -halfW; this.camera.right = halfW;
    this.camera.top = halfH;   this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }

  private resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    const halfH = this.view.distance * 0.5;
    const halfW = halfH * aspect;
    this.camera.left = -halfW; this.camera.right = halfW;
    this.camera.top = halfH;   this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
    this.starPoints.setPxScale(h / 2);
    setSnappedLineViewport(w, h);
  }

  // Walk the nice-step list from largest down; pick the first that fits
  // under ~150 px on screen. Guarantees a readable bar at any zoom.
  private emitScale(): void {
    if (!this.opts.onScale) return;
    const pxPerLy = window.innerHeight / this.view.distance;
    let chosen = NICE_STEPS[NICE_STEPS.length - 1];
    for (const step of NICE_STEPS) {
      if (step * pxPerLy <= 150) { chosen = step; break; }
    }
    this.opts.onScale({ step: chosen, widthPx: Math.round(chosen * pxPerLy) });
  }

  // -- main loop ---------------------------------------------------------

  private tick = (): void => {
    if (!this.running) return;

    if (this.view.spin) this.view.yaw += 0.0015;

    // WASD pans target along camera screen axes (zoom-scaled). Q/E rotate yaw.
    if (this.keys.w || this.keys.a || this.keys.s || this.keys.d) {
      const right = new Vector3(), up = new Vector3();
      this.camera.matrixWorld.extractBasis(right, up, this._tmp1);
      const speed = this.view.distance * 0.012;
      if (this.keys.w) this.view.target.addScaledVector(up,     speed);
      if (this.keys.s) this.view.target.addScaledVector(up,    -speed);
      if (this.keys.d) this.view.target.addScaledVector(right,  speed);
      if (this.keys.a) this.view.target.addScaledVector(right, -speed);
    }
    if (this.keys.q) this.view.yaw += 0.02;
    if (this.keys.e) this.view.yaw -= 0.02;

    this.updateCamera();
    this.emitScale();

    this.grid.update(this.camera.position.x, this.camera.position.y, this.view.target.x, this.view.target.y);
    this.droplines.update(this.camera, this.view.target);

    // Hover detection — pick the star whose ray-distance is smallest.
    let hovered = -1;
    if (this.pointer.has) {
      this._ndc.set(
        (this.pointer.x / window.innerWidth) * 2 - 1,
        -(this.pointer.y / window.innerHeight) * 2 + 1,
      );
      this.raycaster.setFromCamera(this._ndc, this.camera);
      const hits = this.raycaster.intersectObject(this.starPoints.points);
      let bestD = Infinity;
      for (const h of hits) {
        if (h.distanceToRay !== undefined && h.distanceToRay < bestD) {
          bestD = h.distanceToRay;
          hovered = h.index ?? -1;
        }
      }
    }
    this.labels.setHovered(hovered);
    this.labels.update(this.camera, this.view.distance, window.innerWidth, window.innerHeight);

    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this.tick);
  };
}
