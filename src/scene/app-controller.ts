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
import { EconomyBridge, clearSimSave } from '../facilities/economy-bridge';
import { advanceTurn, clearGameSave, getGameState, stepShipBuilds, stepShipTransits } from '../game-state';
import { OverlayStack } from './overlay-stack';
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
  // The galaxy scene is the persistent ROOT (paused, never disposed, on a swap);
  // lazily-built OVERLAYS (system / test, and a modal-over-system to come) layer
  // on top and are disposed on exit. The stack is the depth-N generalization of
  // the former single slot; `current` abstracts "whichever screen is live". Today
  // only depth-1 is reachable (enterOverlay guards re-entry), preserving the exact
  // galaxy↔system/test round-trip.
  private readonly overlays = new OverlayStack<Screen>();
  // Retained planet-material variants (disc / halo / moon 'all'), kept alive so
  // their compiled GL programs survive every SystemScene round-trip. See
  // warm-shaders.ts. Undefined until the deferred idle warm runs.
  private warmedShaders?: ShaderMaterial[];

  // Ships that finished a warp this turn, grouped by DESTINATION system, awaiting their warp-in animation.
  // A system view consumes its own on first display + on a turn advance while it's up; nextTurn rebuilds it
  // each turn (a prior turn's un-viewed arrival is stale — the animation is scoped to the turn a ship lands).
  // Held HERE (not on a scene) so the animation survives view swaps: warp a ship, roam other systems, then
  // open its destination and still see it fly in. In-memory only — ephemeral UX, never persisted.
  private pendingArrivals = new Map<string, string[]>();

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

    this.starmap = new StarmapScene(canvas, this.renderer, this.sidebar);
    this.starmap.onViewSystem = (idx) => this.enterSystem(idx);
    this.starmap.onViewTest = () => this.enterTest();
    this.starmap.onResetGame = () => this.resetGame();
  }

  // Wipe the persisted GAME (game + sim saves; user settings are kept) and reload. A reload is the simplest
  // robust reset: boot re-reads the now-absent keys and every loader cold-starts (parseGameState → DEFAULTS,
  // the EconomyBridge → a fresh World) — no in-memory teardown to coordinate across the scene / sidebar /
  // bridge. Triggered by the settings panel's "Reset game state" action (StarmapScene.onResetGame).
  private resetGame(): void {
    clearGameSave();
    clearSimSave();
    window.location.reload();
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
    for (const overlay of this.overlays.clear()) overlay.dispose();
    this.sidebar.dispose();
    if (this.warmedShaders) {
      for (const m of this.warmedShaders) m.dispose();
      this.warmedShaders = undefined;
    }
  }

  // Whichever screen is currently driving the canvas: the active overlay, else
  // the galaxy root.
  private get current(): Screen {
    return this.overlays.current(this.starmap);
  }

  // Step the economy one turn, bump the saved turn scalar, and refresh the live
  // screen's turn-driven read-out. The turn loop's single home: future turn
  // phases (AI, research, events) attach here, not in a sidebar closure.
  private nextTurn(): void {
    // Belt-and-suspenders to the sidebar's setNextTurnEnabled gate: a screen that
    // suspends the outer game (the encounter mode, combat plan §8.2) freezes the turn
    // even against a programmatic caller, since bridge.step()/advanceTurn() below
    // are unconditional. The system screen raises freezesTurn while in an encounter; the
    // galaxy/test screens leave it unset.
    if (this.current.freezesTurn) return;
    this.bridge.step();
    const turn = advanceTurn();
    this.sidebar.setTurn(turn);
    // The ship-build turn phase: flip every 'building' ship that reached its
    // completesOnTurn to 'ready'. AFTER the turn bump (it compares the new scalar)
    // and BEFORE afterTurnAdvance (so the live system view's refreshFleet observes
    // this turn's completions).
    stepShipBuilds(turn);
    // The transit turn phase: flip every 'transiting' ship that reached its arrivesOnTurn to 'ready' at
    // its destination. Sits between builds and afterTurnAdvance so arrivals surface in the same repaint;
    // the freeze guard above means no transit resolves mid-encounter. The returned arrivals are the seam
    // the notification band + warp-in FX consume.
    const arrivals = stepShipTransits(turn);
    if (import.meta.env.DEV && arrivals.length > 0) {
      console.debug('[game-state] arrivals this turn:', arrivals);
    }
    // Stage this turn's arrivals as PENDING per destination system (replacing any un-viewed set from a prior
    // turn). A system view consumes its pending arrivals on first display + on the turn advance below, so a
    // ship animates in the FIRST time you open its destination this turn — even if you were elsewhere now.
    this.pendingArrivals = new Map();
    for (const a of arrivals) {
      const ids = this.pendingArrivals.get(a.systemId) ?? [];
      ids.push(a.shipId);
      this.pendingArrivals.set(a.systemId, ids);
    }
    // Refresh the live screen's turn-driven read-outs; a system view showing a destination that gained an
    // arrival also consumes + plays its pending warp-ins here (the "arrived while watching it" case).
    this.current.afterTurnAdvance?.();
  }

  // Pull (and clear) the shipIds freshly arrived in a system this turn — the arrival-animation seam a system
  // view calls on first display + on a turn advance while it's up, so each fresh arrival flies in exactly
  // once (clearing prevents a replay on leave-and-re-enter). Empty for a system with no pending arrival.
  private consumeArrivals(systemId: string): readonly string[] {
    const ids = this.pendingArrivals.get(systemId);
    if (!ids) return [];
    this.pendingArrivals.delete(systemId);
    return ids;
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
    if (this.overlays.hasOverlay) return;
    this.starmap.stop();
    const overlay = make(() => this.exitOverlay());
    this.overlays.push(overlay);
    overlay.start();
  }

  // Dispose the active overlay and resume the screen beneath it (another overlay,
  // or the galaxy root) exactly where it paused.
  private exitOverlay(): void {
    const overlay = this.overlays.pop();
    if (!overlay) return;
    overlay.dispose();
    this.current.start();
  }

  // Enter (or re-enter) a system view. Star-to-star navigation lives in the galaxy view, so the system
  // overlay is a pure inspect/act-in-system screen and takes no part in the warp flow.
  enterSystem(clusterIdx: number): void {
    this.enterOverlay((exit) => {
      const system = new SystemScene(this.canvas, this.renderer, clusterIdx, this.sidebar, this.bridge);
      system.onExit = exit;
      // Arrival-animation seam: on start() the fresh scene pulls its system's pending warp-ins, so a ship
      // that landed here this turn flies in the first time you open the system — even if you were elsewhere.
      system.pullArrivals = (systemId) => this.consumeArrivals(systemId);
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

  // DEV: forward to the live galaxy scene to open a warp pick with a destination locked (the ?demo-route
  // screenshot harness in main.ts). No-op unless the galaxy is the current scene.
  devDemoRoute(): void {
    this.starmap.devDemoRoute();
  }

  // DEV: forward to the live galaxy scene to dispatch a warp and leave a ship mid-transit (the ?demo-transit
  // screenshot harness in main.ts). No-op unless the galaxy is the current scene.
  devDemoTransit(): void {
    this.starmap.devDemoTransit();
  }

  // DEV: forward to the live galaxy scene to select a cluster + rebuild the fleet overlays, so a stationed
  // ship-marker grid is screenshot-able (the ?demo-fleet harness in main.ts). No-op unless the galaxy is up.
  devDemoFleet(clusterIdx: number): void {
    this.starmap.devDemoFleet(clusterIdx);
  }
}
