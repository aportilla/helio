// TestScene — flat 2D planet-test-grid screen. Peer of SystemScene and
// StarmapScene; AppController swaps which one's tick() loop is driving the
// shared canvas.
//
// The whole scene is rendered through PlanetGridDiagram (its own ortho scene
// at 1 unit = 1 buffer pixel). The grid is static — no picking, no hover, no
// drag — so the only interaction is the back button (and Escape). TestHud
// sits on top.

import { type WebGLRenderer } from 'three';
import { PlanetGridDiagram } from './planet-grid-diagram';
import { TestHud } from './test-hud';
import { ViewportSizer } from '../viewport-sizer';
import type { Screen } from '../screen';

export class TestScene implements Screen {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;

  private readonly diagram: PlanetGridDiagram;
  private readonly hud: TestHud;
  private readonly viewport = new ViewportSizer();

  private rafId = 0;
  private running = false;

  private readonly _onPointerDown = (e: PointerEvent) => this.onPointerDown(e);
  private readonly _onPointerMove = (e: PointerEvent) => this.onPointerMove(e);
  private readonly _onKeyDown     = (e: KeyboardEvent) => this.onKeyDown(e);
  private readonly _onResize      = () => this.resize();

  private readonly _hudPt = { x: 0, y: 0 };

  // Fired when the user requests to exit the test view (ESC or back
  // button click).
  onExit: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, renderer: WebGLRenderer) {
    this.canvas = canvas;
    this.renderer = renderer;

    this.diagram = new PlanetGridDiagram();
    this.hud = new TestHud();
    this.hud.onBack = () => this.onExit();

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
    this.viewport.dispose();
  }

  // -- listeners --------------------------------------------------------

  private attachListeners(): void {
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('resize',  this._onResize);
  }

  private detachListeners(): void {
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('resize',  this._onResize);
  }

  private onPointerDown(e: PointerEvent): void {
    // Route to the HUD (the back button). The grid is static — if the HUD
    // doesn't consume the click, there's nothing else to hit.
    this.viewport.clientToHud(e.clientX, e.clientY, this._hudPt);
    this.hud.handleClick(this._hudPt.x, this._hudPt.y);
  }

  private onPointerMove(e: PointerEvent): void {
    // Only mouse hovers drive the back-button cursor swap; touch/pen has no
    // hover and there's no body card to follow.
    if (e.pointerType !== 'mouse') return;
    this.viewport.clientToHud(e.clientX, e.clientY, this._hudPt);
    const onButton = this.hud.handlePointerMove(this._hudPt.x, this._hudPt.y);
    this.canvas.style.cursor = onButton ? 'pointer' : '';
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.onExit();
  }

  // -- resize / render --------------------------------------------------

  private resize(): void {
    // ViewportSizer.apply does the load-bearing integer-multiple-of-N snap +
    // pushes the new dims into every pixel-snapped material's uViewport —
    // including the grid's planet/moon material via makePlanetMaterial.
    this.viewport.apply(this.renderer);
    this.diagram.resize(this.viewport.bufferW, this.viewport.bufferH);
    this.hud.resize(this.viewport.bufferW, this.viewport.bufferH);
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
