// Top-level scene controller. Owns the shared WebGLRenderer and the
// view-mode scenes. main.ts instantiates one of these and hands it the
// canvas; the controller decides which scene's render loop is currently
// driving the canvas.
//
// Three peer scenes share the same canvas + renderer:
//   - StarmapScene (galaxy view, the default)
//   - SystemScene  (close-up of a single cluster, lazily constructed
//                   per enterSystem and disposed on exit)
//   - TestScene    (planet-render test grid, lazily constructed per
//                   enterTest and disposed on exit)
// Only one is running its tick() loop at a time. Galaxy view state
// (camera, selection, settings) lives on its instance and is preserved
// across the round-trip — restoring is just StarmapScene.start().

import { ColorManagement, LinearSRGBColorSpace, ShaderMaterial, WebGLRenderer } from 'three';
import { StarmapScene } from './scene';
import { SystemScene } from './system-scene';
import { TestScene } from './test-view/test-scene';
import { warmPlanetShaders } from './warm-shaders';
import { Sidebar } from '../ui/sidebar/sidebar';
import { EconomyBridge } from '../facilities/economy-bridge';
import { advanceTurn, getGameState, stepShipBuilds } from '../game-state';
import type { Screen } from './screen';

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
  // Persistent across the galaxy↔system switch: constructed once here, handed to
  // whichever scene is active to render + route input. Disposed only at app
  // teardown (stop()), never on a view swap.
  private readonly sidebar = new Sidebar();
  // The live economy sim, owned here so it persists across the galaxy↔system
  // switch. Built once (restored from the sim save or cold-started); stepped on
  // Next Turn, reconciled by the system view after a facility edit.
  private readonly bridge = new EconomyBridge();
  private readonly starmap: StarmapScene;
  // The galaxy scene is the persistent ROOT (paused, never disposed, on a swap).
  // At most one lazily-built OVERLAY (system / test) sits on top and is disposed
  // on exit. This single slot is the seam a future screen stack / modal layer
  // grows from; `current` abstracts "whichever screen is live".
  private overlay?: Screen;
  // Retained planet-material variants (disc / halo / moon 'all'), kept alive so
  // their compiled GL programs survive every SystemScene round-trip. See
  // warm-shaders.ts. Undefined until the deferred idle warm runs.
  private warmedShaders?: ShaderMaterial[];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false });
    this.renderer.setClearColor(0x000008, 1);
    // Match the disabled ColorManagement above — raw sRGB in, raw sRGB out.
    this.renderer.outputColorSpace = LinearSRGBColorSpace;

    // Next Turn lives on the persistent sidebar: step the economy, bump the saved
    // turn scalar, re-push it so the header repaints (no notify primitive — the
    // repo's mutate-then-re-pull convention), and refresh the system view's
    // economy read-out if it's up. setTurn here seeds the header from the save.
    this.sidebar.onNextTurn = () => this.nextTurn();
    this.sidebar.setTurn(getGameState().turn);

    this.starmap = new StarmapScene(canvas, this.renderer, this.sidebar, this.bridge);
    this.starmap.onViewSystem = (idx) => this.enterSystem(idx);
    this.starmap.onViewTest = () => this.enterTest();
  }

  start(): void {
    this.starmap.start();
    this.scheduleShaderWarm();
  }

  stop(): void {
    // App teardown — fully dispose the root starmap (releases its viewport's
    // window/matchMedia listeners), unlike enterOverlay below which only stop()s
    // it so a later start() resumes the same instance.
    this.starmap.dispose();
    this.overlay?.dispose();
    this.overlay = undefined;
    this.sidebar.dispose();
    if (this.warmedShaders) {
      for (const m of this.warmedShaders) m.dispose();
      this.warmedShaders = undefined;
    }
  }

  // Whichever screen is currently driving the canvas: the active overlay, else
  // the galaxy root.
  private get current(): Screen {
    return this.overlay ?? this.starmap;
  }

  // Step the economy one turn, bump the saved turn scalar, and refresh the live
  // screen's turn-driven read-out. The turn loop's single home: future turn
  // phases (AI, research, events) attach here, not in a sidebar closure.
  private nextTurn(): void {
    this.bridge.step();
    const turn = advanceTurn();
    this.sidebar.setTurn(turn);
    // The ship-build turn phase: flip every 'building' ship that reached its
    // completesOnTurn to 'ready'. AFTER the turn bump (it compares the new scalar)
    // and BEFORE afterTurnAdvance (so the live system view's refreshFleet observes
    // this turn's completions).
    stepShipBuilds(turn);
    this.current.afterTurnAdvance?.();
  }

  // Compile the planet-shader variants during galaxy-view idle, off both the
  // startup path and the later "View System" click (see warm-shaders.ts).
  // Deferred to an idle callback so it never delays first paint; best-effort,
  // so any failure leaves the system view paying the original compile rather
  // than breaking the app.
  private scheduleShaderWarm(): void {
    if (this.warmedShaders) return;
    const warm = (): void => {
      if (this.warmedShaders) return;
      try {
        this.warmedShaders = warmPlanetShaders(this.renderer);
      } catch (e) {
        if (import.meta.env.DEV) console.warn('[warm] planet-shader warm failed (non-fatal):', e);
      }
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 2000 });
    else setTimeout(warm, 500);
  }

  // Swap the galaxy root out for a lazily-built overlay (system / test): pause the
  // root, construct + start the overlay. Generic over which overlay — a new full
  // screen is a new enterX() that calls this with its factory; the factory gets the
  // exit callback to wire into its onExit.
  private enterOverlay(make: (exit: () => void) => Screen): void {
    if (this.overlay) return;
    this.starmap.stop();
    this.overlay = make(() => this.exitOverlay());
    this.overlay.start();
  }

  // Dispose the active overlay and resume the galaxy root exactly where it paused.
  private exitOverlay(): void {
    if (!this.overlay) return;
    this.overlay.dispose();
    this.overlay = undefined;
    this.starmap.start();
  }

  enterSystem(clusterIdx: number): void {
    this.enterOverlay((exit) => {
      const system = new SystemScene(this.canvas, this.renderer, clusterIdx, this.sidebar, this.bridge);
      system.onExit = exit;
      return system;
    });
  }

  enterTest(): void {
    this.enterOverlay((exit) => {
      const test = new TestScene(this.canvas, this.renderer);
      test.onExit = exit;
      return test;
    });
  }
}
