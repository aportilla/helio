import {
  ColorManagement,
  LinearSRGBColorSpace,
  OrthographicCamera,
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

const ZOOM_MIN = 8;
const ZOOM_MAX = 200;
const NICE_STEPS = [20, 10, 5, 2.5, 1, 0.5, 0.2, 0.1];
const DEFAULT_VIEW = { distance: 50, yaw: 0.9, pitch: 0.55 };

// Each render-buffer ("env") pixel is upscaled by the browser into this many
// physical screen pixels via image-rendering: pixelated. Larger = chunkier
// pixel-art look + fewer GPU pixels (perf bonus, 1/N² fragments).
const ENV_PX_PER_SCREEN_PX = 3;

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
  private readonly hud: Hud;

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
  private readonly _buf  = new Vector2();
  private readonly _hudPt = { x: 0, y: 0 };

  // Cached drawing-buffer dimensions, populated by resize(). All pixel-aware
  // shader work (snap shader, star size, label sizing) uses these — NOT
  // window.innerWidth/Height — because the buffer is smaller than CSS px once
  // pixelRatio drops below 1.
  private bufferW = 0;
  private bufferH = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.view = {
      target: new Vector3(0, 0, 0),
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
    // LinearSRGBColorSpace = "no conversion at output" — fragment values are
    // written to the framebuffer as-is, and the canvas then displays them as
    // sRGB bytes, so a shader writing (30/255, 111/255, 196/255) renders as
    // the literal #1e6fc4. (NoColorSpace is not a valid outputColorSpace.)
    this.renderer.outputColorSpace = LinearSRGBColorSpace;

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

    this.hud = new Hud();
    this.hud.onToggle = (id, on) => {
      if (id === 'labels') this.labels.setShowLabels(on);
      else if (id === 'drops') this.droplines.group.visible = on;
      else if (id === 'spin') this.view.spin = on;
    };
    this.hud.onAction = (id) => {
      if (id === 'reset') {
        this.view.target.set(0, 0, 0);
        this.view.distance = DEFAULT_VIEW.distance;
        this.view.yaw = DEFAULT_VIEW.yaw;
        this.view.pitch = DEFAULT_VIEW.pitch;
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

  // Map a CSS-pixel client coord into HUD buffer coords (Y-up, origin at
  // bottom-left). bufferW/H are in render-buffer pixels; the canvas's CSS
  // box still spans the full viewport, so we scale by the pixelRatio implied
  // by buffer / viewport.
  private clientToHud(clientX: number, clientY: number, out: { x: number; y: number }): void {
    out.x = clientX * (this.bufferW / window.innerWidth);
    out.y = (window.innerHeight - clientY) * (this.bufferH / window.innerHeight);
  }

  private onPointerDown(e: PointerEvent): void {
    // HUD click intercepts pan/orbit so dragging-on-button doesn't move the camera.
    this.clientToHud(e.clientX, e.clientY, this._hudPt);
    if (this.hud.handleClick(this._hudPt.x, this._hudPt.y)) return;

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
    // Update HUD hover state. While actively dragging the camera we skip the
    // HUD hover update so the cursor doesn't lose its grabbing affordance.
    if (!this.dragging) {
      this.clientToHud(e.clientX, e.clientY, this._hudPt);
      const onButton = this.hud.handlePointerMove(this._hudPt.x, this._hudPt.y);
      this.canvas.style.cursor = onButton ? 'pointer' : '';
    }
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
    this.renderer.getDrawingBufferSize(this._buf);
    this.bufferW = this._buf.x;
    this.bufferH = this._buf.y;
    this.starPoints.setPxScale(this.bufferH / 2);
    setSnappedLineViewport(this.bufferW, this.bufferH);
    this.hud.resize(this.bufferW, this.bufferH);
  }

  // Walk the nice-step list from largest down; pick the first that fits
  // under ~150 buffer pixels on screen. Guarantees a readable bar at any zoom.
  private emitScale(): void {
    const pxPerLy = this.bufferH / this.view.distance;
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
    this.labels.update(this.camera, this.view.distance, this.bufferW, this.bufferH);

    this.renderer.render(this.scene, this.camera);
    // HUD pass — disable autoClear so the second render doesn't wipe the
    // first. HUD geometry uses depthTest: false so it always overlays.
    this.renderer.autoClear = false;
    this.renderer.render(this.hud.scene, this.hud.camera);
    this.renderer.autoClear = true;
    this.rafId = requestAnimationFrame(this.tick);
  };
}
