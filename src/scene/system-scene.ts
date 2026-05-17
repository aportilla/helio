// SystemScene — flat 2D diagram of one star cluster. Peer of StarmapScene;
// AppController swaps which one's tick() loop is driving the shared canvas.
//
// The whole scene is rendered through SystemDiagram (its own ortho scene at
// 1 unit = 1 buffer pixel). No 3D camera, no orbit, no zoom — this view is
// a static screen diagram, not a navigable space. SystemHud sits on top.

import { Vector2, type WebGLRenderer } from 'three';
import { getSettings } from '../settings';
import { SystemHud } from '../ui/system-hud';
import { setSnappedLineViewport } from './materials';
import { RenderScaleObserver, effectiveScale } from './render-scale';
import { SystemDiagram } from './system-diagram';

export class SystemScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;

  private readonly diagram: SystemDiagram;
  private readonly hud: SystemHud;
  private readonly renderScale = new RenderScaleObserver();

  private bufferW = 0;
  private bufferH = 0;
  private cssW = 0;
  private cssH = 0;

  private rafId = 0;
  private running = false;

  private readonly _onPointerDown  = (e: PointerEvent) => this.onPointerDown(e);
  private readonly _onPointerMove  = (e: PointerEvent) => this.onPointerMove(e);
  private readonly _onPointerLeave = ()                => this.onPointerLeave();
  private readonly _onKeyDown      = (e: KeyboardEvent) => this.onKeyDown(e);
  private readonly _onResize       = () => this.resize();

  private readonly _hudPt = { x: 0, y: 0 };

  // Fired when the user requests to exit the system view (ESC or back
  // button click).
  onExit: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, renderer: WebGLRenderer, clusterIdx: number) {
    this.canvas = canvas;
    this.renderer = renderer;

    this.diagram = new SystemDiagram(clusterIdx);
    this.hud = new SystemHud(clusterIdx);
    this.hud.onBack = () => this.onExit();

    // DPR boundary crossings (zoom, monitor swap) re-trigger resize so the
    // pixel-ratio + buffer dims pick up the new integer N.
    this.renderScale.subscribe(() => {
      if (this.running) this.resize();
    });
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
    this.diagram.dispose();
    this.hud.dispose();
    this.renderScale.dispose();
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

  // Map a CSS-pixel client coord into HUD buffer coords (Y-up, origin at
  // bottom-left). Same scheme StarmapScene uses.
  private clientToHud(clientX: number, clientY: number, out: { x: number; y: number }): void {
    out.x = clientX * (this.bufferW / this.cssW);
    out.y = (this.cssH - clientY) * (this.bufferH / this.cssH);
  }

  private onPointerDown(e: PointerEvent): void {
    // Only role of pointer-down here is routing clicks to the HUD (the
    // back button). The diagram is static — no drag/orbit fallback.
    this.clientToHud(e.clientX, e.clientY, this._hudPt);
    this.hud.handleClick(this._hudPt.x, this._hudPt.y);
  }

  private onPointerMove(e: PointerEvent): void {
    this.clientToHud(e.clientX, e.clientY, this._hudPt);
    const onButton = this.hud.handlePointerMove(this._hudPt.x, this._hudPt.y);
    this.canvas.style.cursor = onButton ? 'pointer' : '';
    // Body hover info card — skip the picker when the cursor is over
    // any interactive HUD chrome (back button) so a tooltip can't
    // appear under the chrome the user is aiming at.
    const overChrome = this.hud.hitTest(this._hudPt.x, this._hudPt.y) !== 'transparent';
    const pick = overChrome ? null : this.diagram.pickAt(this._hudPt.x, this._hudPt.y);
    this.diagram.setHovered(pick);
    this.hud.setHoveredBody(pick, this._hudPt.x, this._hudPt.y);
  }

  private onPointerLeave(): void {
    // Cursor left the canvas — clear the outline and hide the tooltip
    // so they don't linger on stale state when the cursor comes back.
    this.diagram.setHovered(null);
    this.hud.setHoveredBody(null, 0, 0);
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
    const N = effectiveScale(this.renderScale.scale, getSettings().resolutionPreference);
    const physW = Math.floor(window.innerWidth  * dpr / N) * N;
    const physH = Math.floor(window.innerHeight * dpr / N) * N;
    const cssW = physW / dpr;
    const cssH = physH / dpr;
    this.renderer.setPixelRatio(dpr / N);
    this.renderer.setSize(cssW, cssH);
    this.cssW = cssW;
    this.cssH = cssH;

    const buf = new Vector2();
    this.renderer.getDrawingBufferSize(buf);
    this.bufferW = buf.x;
    this.bufferH = buf.y;

    // Push the new buffer dims into every pixel-snapped material's uViewport
    // — including the diagram's planet/moon material registered via
    // makePlanetMaterial.
    setSnappedLineViewport(this.bufferW, this.bufferH);
    this.diagram.resize(this.bufferW, this.bufferH);
    this.hud.resize(this.bufferW, this.bufferH);
  }

  private tick = (): void => {
    if (!this.running) return;
    this.renderer.render(this.diagram.scene, this.diagram.camera);
    this.renderer.autoClear = false;
    this.renderer.render(this.hud.scene, this.hud.camera);
    this.renderer.autoClear = true;
    this.rafId = requestAnimationFrame(this.tick);
  };
}
