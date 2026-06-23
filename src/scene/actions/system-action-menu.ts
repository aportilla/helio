// SystemActionMenu — the system view's anchored action-menu chrome layer (Menu M2). A
// SystemScene-owned sibling of SystemHud: it owns its OWN ortho Scene + camera (1 unit =
// 1 buffer pixel) holding the ActionMenuPanel + an in-field TargetBracket, exposes the same
// chrome surface the hud and sidebar do (handleClick / handlePointerMove / hitTest /
// handleKey / resize / dispose + scene/camera), and SystemScene routes it FIRST in the
// chrome chain and composites it after the diagram. It does NOT live inside the sealed
// SystemDiagram.
//
// It bridges the headless ActionMenu state machine (src/actions/) to the pixel panel and the
// field bracket. The Sea-of-Stars idiom: scoping into a category's command list IS the
// target-selection modality — VERTICAL input (↑/↓ / W/S, or hovering a row) moves through the
// commands; HORIZONTAL input (←/→ / A/D, or clicking an enemy) moves the locked target, shown
// by a bracket on a ship in the field. Confirming a command fires it at the locked target.
// On a committed ActionIntent the execute DISPATCH routes by ActionDef.kind — 'immediate'
// resolves in place, 'encounter' hands off to the (not-yet-built) encounter modality.

import { OrthographicCamera, Scene } from 'three';
import { ActionMenuPanel, TargetBracket } from '../../ui/action-menu';
import type { HitResult } from '../../ui/hit-test';
import { sizes } from '../../ui/theme';
import { ActionMenu, type TargetResolver } from '../../actions/menu';
import { ACTION_BY_ID } from '../../actions/registry';
import type { Actor, ActionIntent } from '../../actions/types';

// Gap (env px) between the anchored sprite's edge and the menu panel.
const MENU_GAP = 6;
// Forgiveness (env px) added to a target sprite's radius when clicking/hovering it to lock.
const TARGET_PICK_PAD = 4;

export interface SlotCenter {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

export interface OpenMenuOptions {
  readonly actor: Actor;
  // The panel's title line — the actor's display name (the Actor itself is name-agnostic).
  readonly title: string;
  readonly resolveTargets: TargetResolver;
  // The live on-screen slot center of any ship (the actor, for the menu anchor; a target,
  // for the bracket). Re-read on every (re)place so a resize / fleet change tracks for free;
  // a null for the actor closes the menu (the ship is gone).
  readonly slotCenterFor: (shipId: string) => SlotCenter | null;
}

export class SystemActionMenu {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private readonly panel = new ActionMenuPanel(120);
  private readonly bracket = new TargetBracket(110);
  private menu: ActionMenu | null = null;
  private opts: OpenMenuOptions | null = null;

  private bufH = 1;
  private contentW = 1;

  // The execute dispatch seam, routed by ActionDef.kind on confirm. SystemScene fills both;
  // 'encounter' is the hand-off the encounter modality (E-phases) will claim.
  onImmediate: (intent: ActionIntent) => void = () => {};
  onEnterEncounter: (intent: ActionIntent) => void = () => {};

  // The OUTER focus axis: at the category level, ←/→ cycle the active ACTOR (the SoS ◄ ►),
  // which SystemScene fills by re-opening the menu on the next commandable actor. Inert at the
  // command level, where ←/→ moves the target instead (the inner focus). See
  // plans/4x-system-action-menu.md "The focus hierarchy".
  onCycleActor: (delta: number) => void = () => {};

  constructor() {
    this.panel.addTo(this.scene);
    this.bracket.addTo(this.scene);
  }

  get isOpen(): boolean {
    return this.menu !== null;
  }

  resize(bufferW: number, bufferH: number, contentW: number): void {
    this.bufH = bufferH;
    this.contentW = contentW;
    this.camera.left = 0;
    this.camera.right = bufferW;
    this.camera.bottom = 0;
    this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    if (this.menu) this.refresh();
  }

  openFor(opts: OpenMenuOptions): void {
    this.menu = new ActionMenu(opts.actor, opts.resolveTargets);
    this.opts = opts;
    this.panel.reset(); // force a repaint even if the previous menu painted the same
    this.refresh();
  }

  close(): void {
    this.menu = null;
    this.opts = null;
    this.panel.reset();
    this.bracket.hide();
  }

  // Re-place at the current anchor (after a fleet relayout that didn't change selection).
  refreshAnchor(): void {
    if (this.menu) this.refresh();
  }

  // -- input (chrome surface, buffer-px coords) -------------------------

  handleClick(bufX: number, bufY: number): boolean {
    if (!this.menu) return false;
    const row = this.panel.hitRow(bufX, bufY);
    if (row !== null) {
      this.menu.setCursor(row);
      this.commit(this.menu.enter()); // category → drill; command → fire at the locked target
      return true;
    }
    if (this.panel.hitsBackground(bufX, bufY)) return true; // absorb clicks on the plate
    // Outside the panel: at the command level, a click on a candidate ship LOCKS it.
    const target = this.pickTarget(bufX, bufY);
    if (target) {
      this.menu.setTargetById(target);
      this.refresh();
      return true;
    }
    return false; // fall through (deselect / pick another ship)
  }

  handlePointerMove(bufX: number, bufY: number): boolean {
    if (!this.menu) return false;
    const row = this.panel.hitRow(bufX, bufY);
    if (row !== null) {
      this.menu.setCursor(row);
      this.refresh();
      return true;
    }
    if (this.panel.hitsBackground(bufX, bufY)) return true;
    return this.pickTarget(bufX, bufY) !== null; // pointer over a lockable target
  }

  hitTest(bufX: number, bufY: number): HitResult {
    if (!this.menu) return 'transparent';
    if (this.panel.hitRow(bufX, bufY) !== null) return 'interactive';
    if (this.panel.hitsBackground(bufX, bufY)) return 'opaque';
    // A click on a target ship is interactive (it locks), but it must NOT block the diagram
    // pick when the menu is closed — guarded by the `!this.menu` return above.
    return this.pickTarget(bufX, bufY) !== null ? 'interactive' : 'transparent';
  }

  // Returns true if the key was consumed. Two axes: vertical (W/S/↑/↓) moves the command,
  // horizontal (A/D/←/→) moves the locked target. Enter fires/drills; Escape backs out one
  // level — at the top level it is NOT consumed, so it falls through to the scene's
  // clear-selection (which closes the menu).
  handleKey(e: KeyboardEvent): boolean {
    if (!this.menu) return false;
    switch (e.key.toLowerCase()) {
      case 'arrowup':
      case 'w':
        this.menu.moveCursor(-1);
        this.refresh();
        return true;
      case 'arrowdown':
      case 's':
        this.menu.moveCursor(1);
        this.refresh();
        return true;
      case 'arrowleft':
      case 'a':
        if (this.menu.view().level === 'command') {
          this.menu.moveTarget(-1); // inner focus: cycle the target
          this.refresh();
        } else {
          this.onCycleActor(-1); // outer focus: cycle the actor (re-opens the menu)
        }
        return true;
      case 'arrowright':
      case 'd':
        if (this.menu.view().level === 'command') {
          this.menu.moveTarget(1);
          this.refresh();
        } else {
          this.onCycleActor(1);
        }
        return true;
      case 'enter':
        this.commit(this.menu.enter());
        return true;
      case 'escape':
        if (this.menu.view().level !== 'category') {
          this.menu.back();
          this.refresh();
          return true;
        }
        return false; // top level: let the scene clear the selection (closes the menu)
      default:
        return false;
    }
  }

  dispose(): void {
    this.panel.dispose();
    this.bracket.dispose();
  }

  // -- internals --------------------------------------------------------

  // The candidate target id under (x, y), or null — a radial hit-test over the locked
  // command's candidate ships (only meaningful at the command level).
  private pickTarget(bufX: number, bufY: number): string | null {
    const view = this.menu?.view();
    if (!view || view.level !== 'command' || !view.targets || !this.opts) return null;
    let best: string | null = null;
    let bestD = Infinity;
    for (const id of view.targets) {
      const c = this.opts.slotCenterFor(id);
      if (!c) continue;
      const dx = bufX - c.cx;
      const dy = bufY - c.cy;
      const d = dx * dx + dy * dy;
      const rr = c.r + TARGET_PICK_PAD;
      if (d <= rr * rr && d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  // Process the result of an enter()/confirm(): a non-null intent committed an action
  // (dispatch + close); null means we drilled a level (repaint + re-bracket).
  private commit(intent: ActionIntent | null): void {
    if (intent) {
      this.dispatch(intent);
      return;
    }
    this.refresh();
  }

  private dispatch(intent: ActionIntent): void {
    const def = ACTION_BY_ID.get(intent.actionId);
    this.close();
    if (def?.kind === 'encounter') this.onEnterEncounter(intent);
    else this.onImmediate(intent);
  }

  private refresh(): void {
    if (!this.menu) return;
    if (this.menu.closed) {
      this.close();
      return;
    }
    const changed = this.panel.setModel(this.buildModel());
    if (changed) this.place();
    this.updateBracket();
  }

  private buildModel() {
    const view = this.menu!.view();
    return {
      title: this.opts!.title,
      rows: view.rows.map((r) => ({ label: r.label, enabled: r.enabled })),
      cursor: view.cursor,
    };
  }

  // Ride the bracket on the locked target (command level only); hide it otherwise.
  private updateBracket(): void {
    const view = this.menu!.view();
    if (view.level === 'command' && view.targets && view.targets.length > 0) {
      const id = view.targets[view.targetCursor ?? 0];
      const c = id ? this.opts!.slotCenterFor(id) : null;
      if (c) {
        this.bracket.showAt(c.cx, c.cy, c.r);
        return;
      }
    }
    this.bracket.hide();
  }

  // Place the panel beside the anchored sprite, flipping to the other side and clamping so
  // it never runs under the sidebar strip or off the top/bottom. Mirrors BodyInfoCard.
  private place(): void {
    if (!this.opts) return;
    const anchor = this.opts.slotCenterFor(this.opts.actor.id);
    if (!anchor) {
      this.close();
      return;
    }
    const w = this.panel.width;
    const h = this.panel.height;
    if (w === 0 || h === 0) return;

    const offset = anchor.r + MENU_GAP;
    const pad = sizes.edgePad;
    let left = anchor.cx + offset;
    if (left + w > this.contentW - pad) left = anchor.cx - offset - w;
    let bottom = anchor.cy - Math.round(h / 2);
    left = Math.max(pad, Math.min(this.contentW - pad - w, left));
    bottom = Math.max(pad, Math.min(this.bufH - pad - h, bottom));
    this.panel.placeAt(Math.round(left), Math.round(bottom));
  }
}
