// SystemScene — flat 2D diagram of one star cluster. Peer of StarmapScene;
// AppController swaps which one's tick() loop is driving the shared canvas.
//
// The whole scene is rendered through SystemDiagram (its own ortho scene at
// 1 unit = 1 buffer pixel). No 3D camera, no orbit, no zoom — this view is
// a static screen diagram, not a navigable space. SystemHud sits on top.

import { type WebGLRenderer } from 'three';
import { BODIES, clusterDisplayName } from '../data/stars';
import { addableTypesFor } from '../facilities';
import type { EconomyBridge } from '../facilities/economy-bridge';
import { addFacility, facilitiesOnBody, removeFacility } from '../game-state';
import { SystemHud } from '../ui/system-hud';
import { Sidebar } from '../ui/sidebar/sidebar';
import { SystemContext } from '../ui/sidebar/system-context';
import { sizes } from '../ui/theme';
import { SystemDiagram, type DiagramPick } from './system-diagram';
import { picksEqual } from './system-diagram/types';
import { ViewportSizer } from './viewport-sizer';
import type { Screen } from './screen';

export class SystemScene implements Screen {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;

  private readonly diagram: SystemDiagram;
  private readonly hud: SystemHud;
  // Persistent sidebar, owned by AppController (shared with the galaxy view).
  // Rendered + input-routed here, but not owned. Consulted before the HUD.
  private readonly sidebar: Sidebar;
  // The live economy, owned by AppController. We reconcile it after a facility
  // edit and read each selected body's standing from it for the sidebar.
  private readonly bridge: EconomyBridge;
  // The system view's contextual region inside the sidebar (selected body's
  // facilities). Set as the sidebar's active context on start, cleared on dispose.
  private readonly context: SystemContext;
  private readonly viewport = new ViewportSizer(sizes.sidebarW);

  private rafId = 0;
  private running = false;

  private readonly _onPointerDown  = (e: PointerEvent) => this.onPointerDown(e);
  private readonly _onPointerMove  = (e: PointerEvent) => this.onPointerMove(e);
  private readonly _onPointerLeave = ()                => this.onPointerLeave();
  private readonly _onKeyDown      = (e: KeyboardEvent) => this.onKeyDown(e);
  private readonly _onResize       = () => this.resize();

  private readonly _hudPt = { x: 0, y: 0 };

  // Touch/pen has no hover, so a tap pins the body card instead. While a
  // pick is pinned the card persists — notably it survives the spurious
  // pointerleave a finger-lift fires — until the next tap re-pins or
  // clears it. Null on mouse, where the card is purely hover-driven.
  private pinnedPick: DiagramPick | null = null;

  // The body the player has selected for facility construction. Distinct from
  // hover (which follows the cursor) and from pinnedPick (the touch tooltip):
  // it persists across pointer moves and drives the sidebar's facilities context.
  // Ephemeral by design — a fresh SystemScene starts with nothing selected;
  // the facilities themselves persist in the game-state store, not here.
  private selectedPick: DiagramPick | null = null;

  // Fired when the user requests to exit the system view (ESC or back
  // button click).
  onExit: () => void = () => {};

  constructor(
    canvas: HTMLCanvasElement,
    renderer: WebGLRenderer,
    clusterIdx: number,
    sidebar: Sidebar,
    bridge: EconomyBridge,
  ) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.sidebar = sidebar;
    this.bridge = bridge;

    this.diagram = new SystemDiagram(clusterIdx);
    this.hud = new SystemHud();
    this.hud.onBack = () => this.onExit();

    // Facilities live in the persistent sidebar's contextual region. The context
    // owns the add/remove callbacks; we mutate game-state then re-push the updated
    // body so the list stays in sync.
    this.context = new SystemContext(clusterDisplayName(clusterIdx));
    this.context.onAddFacility = (bodyId, type) => {
      addFacility(bodyId, type);
      this.bridge.syncFacilities();
      this.pushSelectionToSidebar();
    };
    this.context.onRemoveFacility = (facilityId) => {
      removeFacility(facilityId);
      this.bridge.syncFacilities();
      this.pushSelectionToSidebar();
    };

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
    // Make the sidebar show this system's context (persistent turn header stays).
    this.sidebar.setContext(this.context);
    // System-view settings are deferred (the panel's toggles are galaxy-specific);
    // the header glyph is a no-op here for now.
    this.sidebar.onSettings = () => {};
    this.pushSelectionToSidebar();
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
    // Detach this scene's context so the (shared, AppController-owned) sidebar
    // doesn't paint a disposed context once the galaxy view resumes.
    this.sidebar.setContext(null);
    this.diagram.dispose();
    this.hud.dispose();
    this.viewport.dispose();
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

  private onPointerDown(e: PointerEvent): void {
    // Route to the sidebar, then the HUD (back button), before the diagram. The
    // diagram is static — no drag/orbit fallback — so a pointerdown that misses
    // chrome is a clean click on the diagram.
    this.viewport.clientToHud(e.clientX, e.clientY, this._hudPt);
    if (this.sidebar.handleClick(this._hudPt.x, this._hudPt.y)) return;
    if (this.hud.handleClick(this._hudPt.x, this._hudPt.y)) return;

    // A click on the diagram (or empty space): pick under it (null over chrome).
    const hit = this.pickAt(this._hudPt.x, this._hudPt.y);

    // Persistent facility selection (mouse + touch): select an eligible body,
    // or clear when the pick isn't one (star / ring / empty space).
    this.select(hit);

    // Touch/pen has no hover, so a tap also stands in for it: pin the body
    // card. A tap on empty space (or chrome) pins null, which dismisses it;
    // re-tapping the pinned body toggles it back off. Mouse keeps its
    // hover-driven card and never pins.
    if (e.pointerType !== 'mouse') {
      const pinned = picksEqual(hit, this.pinnedPick) ? null : hit;
      this.pinnedPick = pinned;
      this.diagram.setHovered(pinned);
      this.hud.setHoveredBody(pinned, this._hudPt.x, this._hudPt.y);
    }
  }

  // Update the persistent selection. Only bodies that can host at least one
  // facility can be selected — a star, a ring, or empty space clears it, so the
  // sidebar's facilities context only ever shows Add pills for a buildable body. Eligibility is the
  // registry's call (addableTypesFor), not an inline kind check, so it stays in
  // lockstep with the defs as types are added or their predicates diverge.
  private select(pick: DiagramPick | null): void {
    const body = pick && pick.kind !== 'star' ? BODIES[pick.bodyIdx] : undefined;
    const eligible = !!body && addableTypesFor(body, []).length > 0;
    const next = eligible ? pick : null;
    if (picksEqual(next, this.selectedPick)) return;
    this.selectedPick = next;
    this.diagram.setSelected(next);
    this.pushSelectionToSidebar();
  }

  // Push the selected body (with its current facilities, read fresh from the
  // game-state store) into the sidebar's system context. Called on every selection
  // change and after each add/remove so the list stays in sync.
  private pushSelectionToSidebar(): void {
    const pick = this.selectedPick;
    if (!pick || pick.kind === 'star') {
      this.context.setBody(null);
      this.sidebar.refreshContent();
      return;
    }
    const body = BODIES[pick.bodyIdx]!;
    const facilities = facilitiesOnBody(body.id);
    this.context.setBody({
      bodyId: body.id,
      name: body.name,
      kind: body.kind,
      facilities,
      addableTypes: addableTypesFor(body, facilities),
      economy: this.bridge.bodyEconomy(body.id),
    });
    this.sidebar.refreshContent();
  }

  // Re-read the selected body's economy after the sim steps (Next Turn), so the
  // sidebar's stock/flow numbers reflect the turn just processed.
  afterTurnAdvance(): void {
    this.pushSelectionToSidebar();
  }

  private onPointerMove(e: PointerEvent): void {
    // Touch/pen drives the card by tap (see onPointerDown), so a finger
    // drag must not move/clear the pinned card — only mouse hovers.
    if (e.pointerType !== 'mouse') return;
    this.viewport.clientToHud(e.clientX, e.clientY, this._hudPt);
    const onSidebar = this.sidebar.handlePointerMove(this._hudPt.x, this._hudPt.y);
    const onButton = this.hud.handlePointerMove(this._hudPt.x, this._hudPt.y);
    this.canvas.style.cursor = (onSidebar || onButton) ? 'pointer' : '';
    const pick = this.pickAt(this._hudPt.x, this._hudPt.y);
    this.diagram.setHovered(pick);
    this.hud.setHoveredBody(pick, this._hudPt.x, this._hudPt.y);
  }

  // Pick the disc under a HUD-space point, skipping the picker when the
  // point is over any interactive HUD chrome (back button) so a tooltip
  // can't appear under the chrome the user is aiming at.
  private pickAt(bufX: number, bufY: number): DiagramPick | null {
    const overChrome = this.sidebar.hitTest(bufX, bufY) !== 'transparent'
      || this.hud.hitTest(bufX, bufY) !== 'transparent';
    return overChrome ? null : this.diagram.pickAt(bufX, bufY);
  }

  private onPointerLeave(): void {
    // A tap-pinned card (touch/pen) must survive the spurious
    // pointerleave a finger-lift fires; only a mouse leaving the canvas
    // clears the transient hover state so it doesn't linger on stale
    // state when the cursor comes back.
    if (this.pinnedPick) return;
    this.diagram.setHovered(null);
    this.hud.setHoveredBody(null, 0, 0);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    // Escape clears a body selection first; a second press (nothing selected)
    // exits the system view.
    if (this.selectedPick) {
      this.select(null);
      return;
    }
    this.onExit();
  }

  // -- resize / render --------------------------------------------------

  private resize(): void {
    // ViewportSizer.apply does the load-bearing integer-multiple-of-N snap +
    // pushes the new dims into every pixel-snapped material's uViewport —
    // including the diagram's planet/moon material via makePlanetMaterial.
    this.viewport.apply(this.renderer);
    // Diagram lays out + renders in the content rect (left of the reserved sidebar
    // strip); the HUD spans the full buffer.
    this.diagram.resize(this.viewport.contentBufferW, this.viewport.bufferH);
    this.hud.resize(this.viewport.bufferW, this.viewport.bufferH);
    this.sidebar.resize(this.viewport.bufferW, this.viewport.bufferH);
  }

  private tick = (): void => {
    if (!this.running) return;
    // One full-buffer clear (the reserved sidebar strip stays clear-color), then
    // the diagram clipped to the content rect so its pixel-snapped body materials
    // line up with the content-width uViewport; the HUD spans the full buffer.
    const { cssW, cssH, contentCssW } = this.viewport;
    this.renderer.autoClear = false;
    this.renderer.clear();
    this.renderer.setViewport(0, 0, contentCssW, cssH);
    this.renderer.setScissor(0, 0, contentCssW, cssH);
    this.renderer.setScissorTest(true);
    this.renderer.render(this.diagram.scene, this.diagram.camera);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, cssW, cssH);
    this.renderer.render(this.hud.scene, this.hud.camera);
    this.renderer.render(this.sidebar.scene, this.sidebar.camera);
    this.renderer.autoClear = true;
    this.rafId = requestAnimationFrame(this.tick);
  };
}
