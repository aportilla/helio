// Top-level scene controller. Owns the shared WebGLRenderer and the
// view-mode scenes. Lit's <starmap-app> instantiates one of these and
// hands it the canvas; the controller decides which scene's render loop
// is currently driving the canvas.
//
// Two peer scenes share the same canvas + renderer:
//   - StarmapScene (galaxy view, the default)
//   - SystemScene  (close-up of a single cluster, lazily constructed
//                   per enterSystem and disposed on exit)
// Only one is running its tick() loop at a time. Galaxy view state
// (camera, selection, settings) lives on its instance and is preserved
// across the round-trip — restoring is just StarmapScene.start().

import { ColorManagement, LinearSRGBColorSpace, WebGLRenderer } from 'three';
import { StarmapScene } from './scene';
import { SystemScene } from './system-scene';

// Opt out of Three.js color management. Without this, hex values in shader
// uniforms (new Color(0x1e6fc4)) and hex strings in canvas fillStyle
// ('#1e6fc4') end up rendering at *different* on-screen colors because the
// two paths get different sRGB↔linear conversions. The whole project's
// palette is hand-picked sRGB values intended to render literally, so we
// turn off both color-management transforms (input and output) and let the
// renderer just write raw sRGB to the framebuffer.
ColorManagement.enabled = false;

export class AppController {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly starmap: StarmapScene;
  private system?: SystemScene;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false });
    this.renderer.setClearColor(0x000008, 1);
    // Match the disabled ColorManagement above — raw sRGB in, raw sRGB out.
    this.renderer.outputColorSpace = LinearSRGBColorSpace;

    this.starmap = new StarmapScene(canvas, this.renderer);
    this.starmap.onViewSystem = (idx) => this.enterSystem(idx);
  }

  start(): void {
    this.starmap.start();
  }

  stop(): void {
    this.starmap.stop();
    this.system?.dispose();
    this.system = undefined;
  }

  enterSystem(clusterIdx: number): void {
    if (this.system) return;
    this.starmap.stop();
    this.system = new SystemScene(this.canvas, this.renderer, clusterIdx);
    this.system.onExit = () => this.exitSystem();
    this.system.start();
  }

  exitSystem(): void {
    if (!this.system) return;
    this.system.dispose();
    this.system = undefined;
    this.starmap.start();
  }
}
