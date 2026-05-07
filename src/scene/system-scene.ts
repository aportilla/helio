// SystemScene — close-up tactical view of one star system. Peer of
// StarmapScene; AppController swaps which one's tick() loop is driving
// the shared canvas.
//
// Today the 3D scene is empty — Step 4 will add the cluster's stars as
// 2D disks. The HUD chrome (header bar, back button, info card) is
// already in place via SystemHud.

import {
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { STAR_CLUSTERS } from '../data/stars';
import { SystemHud } from '../ui/system-hud';

// Same upscale factor the galaxy view uses; the integer-multiple-of-N
// resize logic below is identical.
const ENV_PX_PER_SCREEN_PX = 3;
const FOV_DEG = 45;
const NEAR = 0.01;
const FAR = 100;

// Skeleton-stage default orbit. Step 4 will retune ZOOM_MIN/MAX for the
// scaled-up cluster geometry; today they bound a value that doesn't
// influence anything visible.
const DEFAULT_DISTANCE = 1.0;
const DEFAULT_YAW = 0.5;
const DEFAULT_PITCH = 1.2;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 10;

export class SystemScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;

  private readonly camera: PerspectiveCamera;
  private readonly scene = new Scene();
  private readonly hud: SystemHud;

  private bufferW = 0;
  private bufferH = 0;
  private cssW = 0;
  private cssH = 0;

  private readonly view = {
    target: new Vector3(),
    distance: DEFAULT_DISTANCE,
    yaw: DEFAULT_YAW,
    pitch: DEFAULT_PITCH,
  };

  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  private rafId = 0;
  private running = false;

  private readonly _onPointerDown = (e: PointerEvent) => this.onPointerDown(e);
  private readonly _onPointerUp   = (e: PointerEvent) => this.onPointerUp(e);
  private readonly _onPointerMove = (e: PointerEvent) => this.onPointerMove(e);
  private readonly _onWheel       = (e: WheelEvent) => this.onWheel(e);
  private readonly _onContextMenu = (e: Event) => e.preventDefault();
  private readonly _onKeyDown     = (e: KeyboardEvent) => this.onKeyDown(e);
  private readonly _onResize      = () => this.resize();

  private readonly _hudPt = { x: 0, y: 0 };

  // Fired when the user requests to exit the system view (ESC or back
  // button click).
  onExit: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, renderer: WebGLRenderer, clusterIdx: number) {
    this.canvas = canvas;
    this.renderer = renderer;

    this.camera = new PerspectiveCamera(FOV_DEG, 1, NEAR, FAR);
    this.view.target.copy(STAR_CLUSTERS[clusterIdx].com);

    this.hud = new SystemHud(clusterIdx);
    this.hud.onBack = () => this.onExit();
  }

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

  // Idempotent — safe to call after stop().
  dispose(): void {
    this.stop();
    this.hud.dispose();
  }

  // -- listeners --------------------------------------------------------

  private attachListeners(): void {
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointerup',   this._onPointerUp);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('wheel',       this._onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('resize',  this._onResize);
  }

  private detachListeners(): void {
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointerup',   this._onPointerUp);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('wheel',       this._onWheel);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('resize',  this._onResize);
  }

  // Map a CSS-pixel client coord into HUD buffer coords (Y-up, origin at
  // bottom-left). Same scheme StarmapScene uses.
  private clientToHud(clientX: number, clientY: number, out: { x: number; y: number }): void {
    out.x = clientX * (this.bufferW / this.cssW);
    out.y = (this.cssH - clientY) * (this.bufferH / this.cssH);
  }

  private onPointerDown(e: PointerEvent): void {
    // HUD claims the click first so the back button doesn't also start a
    // camera orbit drag underneath it.
    this.clientToHud(e.clientX, e.clientY, this._hudPt);
    if (this.hud.handleClick(this._hudPt.x, this._hudPt.y)) return;

    this.canvas.setPointerCapture(e.pointerId);
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  }

  private onPointerUp(_e: PointerEvent): void {
    this.dragging = false;
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.dragging) {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.view.yaw   -= dx * 0.005;
      this.view.pitch -= dy * 0.005;
      this.view.pitch = Math.max(0.05, Math.min(Math.PI - 0.05, this.view.pitch));
      return;
    }
    this.clientToHud(e.clientX, e.clientY, this._hudPt);
    const onButton = this.hud.handlePointerMove(this._hudPt.x, this._hudPt.y);
    this.canvas.style.cursor = onButton ? 'pointer' : '';
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const next = this.view.distance * Math.pow(1.0015, e.deltaY);
    this.view.distance = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.onExit();
  }

  // -- resize / render --------------------------------------------------

  // Identical integer-multiple-of-N rounding used by StarmapScene; see
  // scene.ts:resize for the load-bearing rationale (browser nearest-
  // neighbor upscale only divides cleanly when CSS×DPR is a multiple of N).
  private resize(): void {
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

    const buf = new Vector2();
    this.renderer.getDrawingBufferSize(buf);
    this.bufferW = buf.x;
    this.bufferH = buf.y;

    this.hud.resize(this.bufferW, this.bufferH);
  }

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
  }

  private tick = (): void => {
    if (!this.running) return;
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = false;
    this.renderer.render(this.hud.scene, this.hud.camera);
    this.renderer.autoClear = true;
    this.rafId = requestAnimationFrame(this.tick);
  };
}
