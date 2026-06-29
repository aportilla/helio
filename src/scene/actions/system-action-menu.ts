// SystemActionMenu — the system view's anchored action-menu chrome layer (Menu M2). A
// SystemScene-owned sibling of SystemHud: it owns its OWN ortho Scene + camera (1 unit =
// 1 buffer pixel) holding the ActionMenuPanel + a bouncing focus pointer (and ◄ ► actor arrows),
// exposes the same chrome surface the hud and sidebar do (handleClick / handlePointerMove /
// hitTest / handleKey / resize / dispose + scene/camera), and SystemScene routes it FIRST in the
// chrome chain and composites it after the diagram. It does NOT live inside the sealed
// SystemDiagram.
//
// It bridges the headless ActionMenu state machine (src/actions/) to the pixel panel and the
// in-field focus pointer. The menu drills three SEQUENTIAL levels — category → command (weapon) →
// target — choosing WHAT to do before scoping into targeting: at the command level you pick a
// weapon (↑/↓ / hover) with no target shown yet; Enter (or a click) ARMS it and enters targeting,
// where the BOX HIDES and the bouncing focus pointer moves out onto the locked target ship (the
// arrows / hover / a click move it); confirming at the target level FIRES the armed command at the
// locked target (a target click is itself the confirm). Escape walks back up a level at a time
// (target → command → category → close).
// On a committed ActionIntent the execute DISPATCH routes by the action's kind, resolved from
// the actor's own resolved command (no central registry) — 'immediate' resolves in place,
// 'encounter' hands off to the combat MODE (onEnterEncounter → SystemScene.enterEncounter),
// run in place over the same diagram.

import { OrthographicCamera, Scene } from 'three';
import { ActionMenuPanel, ActorArrow, MenuPointer } from '../../ui/action-menu';
import type { HitResult } from '../../ui/hit-test';
import { sizes } from '../../ui/theme';
import { ActionMenu, type MenuView, type TargetResolver } from '../../actions/menu';
import { commandFor } from '../../actions/derive';
import type { Actor, ActionIntent } from '../../actions/types';

// Gap (env px) between the anchored sprite's edge and the menu panel.
const MENU_GAP = 6;
// Forgiveness (env px) added to a target sprite's radius when clicking/hovering it to lock.
const TARGET_PICK_PAD = 4;
// Gap (env px) between the box's side and an actor-switch arrow flanking it.
const ARROW_GAP = 4;
// Gap (env px) between the focus pointer's tip and the target sprite it points at (target level).
const POINTER_TARGET_GAP = 3;
// Bouncing-pointer bob: horizontal amplitude (env px) and the time divisor that sets the
// oscillation period (full cycle ≈ 2π × this ms). Quantized to whole pixels — no sub-pixel.
const POINTER_BOB_AMP = 2;
const POINTER_BOB_SPEED = 110;

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
  // for the focus pointer). Re-read on every (re)place so a resize / fleet change tracks for free;
  // a null for the actor closes the menu (the ship is gone).
  readonly slotCenterFor: (shipId: string) => SlotCenter | null;
  // How many commandable actors the player can switch between in this context (the focus ring
  // size). >1 shows the ◄ ► actor-switch arrows at the category level. Absent ⇒ no arrows.
  readonly actorCount?: number;
}

export class SystemActionMenu {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private readonly panel = new ActionMenuPanel(120);
  // The bouncing 'you are here' focus pointer (rides the cursor row, or the locked target ship in
  // the field during targeting — re-placed each frame) and the ◄ ► actor-switch arrows flanking
  // the box. Siblings of the panel in this ortho scene.
  private readonly pointer = new MenuPointer(130);
  private readonly arrowL = new ActorArrow('left', 125);
  private readonly arrowR = new ActorArrow('right', 125);
  // The pointer's resting placement for the current cursor row (null = hidden); the per-frame
  // bob is added in tick(). Recomputed in refresh() when the cursor or layout changes.
  private pointerBase: { left: number; centerY: number } | null = null;
  // True while the actor-switch arrows are shown + placed (category level, >1 actor) — gates
  // their hit-testing so a click only cycles when they're actually on screen.
  private arrowsShown = false;
  // The candidate the hover last locked the focus pointer onto (target level). Hover only re-locks when
  // the pointer ENTERS a different candidate — so a stationary mouse resting on a candidate can't
  // keep clobbering a target the player just chose with the keyboard. Null = over empty field.
  private lastHoverTarget: string | null = null;
  private menu: ActionMenu | null = null;
  private opts: OpenMenuOptions | null = null;
  // Set while the menu is driving an encounter round (E4): flips dispatch from the live-view kind fork
  // to onEncounterCommit. The same menu instance serves both the system view and combat.
  private encounterMode = false;

  private bufH = 1;
  private contentW = 1;

  // The execute dispatch seam, routed by the command's kind on confirm. SystemScene fills both;
  // 'encounter' is the hand-off into the combat mode — SystemScene fills onEnterEncounter to enter.
  onImmediate: (intent: ActionIntent) => void = () => {};
  onEnterEncounter: (intent: ActionIntent) => void = () => {};
  // The IN-ENCOUNTER confirm sink (E4): while encounter mode is set, a committed intent routes HERE
  // (into the reducer) instead of the live-view kind fork. The EncounterController fills it.
  onEncounterCommit: (intent: ActionIntent) => void = () => {};

  // The OUTER focus axis: at the category level, ←/→ cycle the active ACTOR (the SoS ◄ ►), which
  // SystemScene fills by re-opening the menu on the next commandable actor. At the command level
  // ←/→ are inert; the target lock is moved only at the separate target level (the inner focus).
  // See src/actions/README.md (the focus hierarchy).
  onCycleActor: (delta: number) => void = () => {};

  constructor() {
    this.panel.addTo(this.scene);
    this.pointer.addTo(this.scene);
    this.arrowL.addTo(this.scene);
    this.arrowR.addTo(this.scene);
  }

  // Advance the bouncing pointer (the menu's only per-frame animation). SystemScene calls this
  // each tick before rendering the menu scene; cheap and a no-op while the pointer is hidden.
  tick(now: number): void {
    if (!this.pointerBase) return;
    const bob = Math.round(Math.sin(now / POINTER_BOB_SPEED) * POINTER_BOB_AMP);
    this.pointer.moveTo(this.pointerBase.left + bob, this.pointerBase.centerY);
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
    if (this.menu) this.refresh(true); // the camera + slot centers moved — force a re-anchor
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
    this.hideAdornments();
  }

  private hideAdornments(): void {
    this.pointer.setVisible(false);
    this.pointerBase = null;
    this.arrowL.setVisible(false);
    this.arrowR.setVisible(false);
    this.arrowsShown = false;
    this.lastHoverTarget = null;
  }

  // Flip the confirm sink between the live-view kind fork (false) and the in-encounter reducer commit
  // (true). The EncounterController raises it on enter, lowers it on exit.
  setEncounterMode(on: boolean): void {
    this.encounterMode = on;
  }

  // Re-place at the current anchor (after a fleet relayout that didn't change selection). Forces
  // the re-place: the slots moved but the menu's painted content didn't, so the paint gate alone
  // would skip it and leave the menu pinned to the old slot.
  refreshAnchor(): void {
    if (this.menu) this.refresh(true);
  }

  // -- input (chrome surface, buffer-px coords) -------------------------

  handleClick(bufX: number, bufY: number): boolean {
    if (!this.menu) return false;
    const level = this.menu.view().level;
    // Row clicks drill the hierarchy (category → command → enter targeting) — but NOT at the
    // target level, where the panel rows are frozen context; you target in the field there.
    if (level !== 'target') {
      const row = this.panel.hitRow(bufX, bufY);
      if (row !== null) {
        this.menu.setCursor(row);
        this.commit(this.menu.enter()); // category → command; command → arm + enter targeting
        return true;
      }
    }
    // Arrows BEFORE the plate absorb: a wide title makes the canvas overhang the box, so the
    // right arrow can sit inside visibleBounds — hitsBackground would otherwise swallow it.
    const arrow = this.hitArrow(bufX, bufY);
    if (arrow !== null) {
      this.onCycleActor(arrow); // ◄ / ► → switch to the prev/next commandable actor
      return true;
    }
    if (this.panel.hitsBackground(bufX, bufY)) return true; // absorb clicks on the plate
    // Target level: a click on a candidate ship/body locks it AND fires — the target click IS
    // the confirm (the mouse twin of arrow-to-aim + Enter-to-fire).
    const target = this.pickTarget(bufX, bufY);
    if (target) {
      this.menu.setTargetById(target);
      this.commit(this.menu.enter());
      return true;
    }
    return false; // fall through (deselect / pick another ship)
  }

  handlePointerMove(bufX: number, bufY: number): boolean {
    if (!this.menu) return false;
    const level = this.menu.view().level;
    if (level !== 'target') {
      const row = this.panel.hitRow(bufX, bufY);
      if (row !== null) {
        this.menu.setCursor(row);
        this.refresh();
        return true;
      }
    }
    if (this.hitArrow(bufX, bufY) !== null) return true; // pointer over an actor-switch arrow
    if (this.panel.hitsBackground(bufX, bufY)) return true;
    // Target level: entering a candidate previews the focus pointer on it (a click then fires).
    // Only on ENTER (target !== lastHoverTarget) so a stationary mouse can't revert a keyboard aim.
    const target = this.pickTarget(bufX, bufY);
    if (target) {
      if (target !== this.lastHoverTarget) {
        this.lastHoverTarget = target;
        this.menu.setTargetById(target);
        this.refresh();
      }
      return true;
    }
    this.lastHoverTarget = null; // back over empty field — re-entering a candidate re-previews
    return false;
  }

  hitTest(bufX: number, bufY: number): HitResult {
    if (!this.menu) return 'transparent';
    const level = this.menu.view().level;
    if (level !== 'target' && this.panel.hitRow(bufX, bufY) !== null) return 'interactive';
    if (this.hitArrow(bufX, bufY) !== null) return 'interactive';
    if (this.panel.hitsBackground(bufX, bufY)) return 'opaque';
    // A click on a target ship is interactive (it locks), but it must NOT block the diagram
    // pick when the menu is closed — guarded by the `!this.menu` return above.
    return this.pickTarget(bufX, bufY) !== null ? 'interactive' : 'transparent';
  }

  // Returns true if the key was consumed. The axes change with the level (Enter drills the
  // hierarchy category → command → target, then FIRES; Escape walks it back up):
  //  - target level: ALL arrows move the locked target (the field focus pointer); the armed weapon is frozen.
  //  - command level: ↑/↓ pick the weapon; ←/→ are inert (no target yet; you target with Enter).
  //  - category level: ↑/↓ pick the category; ←/→ cycle the active ACTOR (re-opening the menu).
  // Escape at the top level is NOT consumed, so it falls through to the scene's clear-selection.
  handleKey(e: KeyboardEvent): boolean {
    if (!this.menu) return false;
    const level = this.menu.view().level;
    switch (e.key.toLowerCase()) {
      case 'arrowup':
      case 'w':
        if (level === 'target') this.menu.moveTarget(-1);
        else this.menu.moveCursor(-1);
        this.refresh();
        return true;
      case 'arrowdown':
      case 's':
        if (level === 'target') this.menu.moveTarget(1);
        else this.menu.moveCursor(1);
        this.refresh();
        return true;
      case 'arrowleft':
      case 'a':
        if (level === 'target') {
          this.menu.moveTarget(-1); // inner focus: cycle the target
          this.refresh();
        } else if (level === 'category') {
          this.onCycleActor(-1); // outer focus: cycle the actor (re-opens the menu)
        }
        return true; // command level: inert, but consumed (no actor-switch mid-weapon-pick)
      case 'arrowright':
      case 'd':
        if (level === 'target') {
          this.menu.moveTarget(1);
          this.refresh();
        } else if (level === 'category') {
          this.onCycleActor(1);
        }
        return true;
      case 'enter':
        this.commit(this.menu.enter());
        return true;
      case 'escape':
        if (level !== 'category') {
          this.menu.back(); // target → command → category
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
    this.pointer.dispose();
    this.arrowL.dispose();
    this.arrowR.dispose();
  }

  // -- internals --------------------------------------------------------

  // The actor-switch direction under (x, y): -1 (◄ prev) / +1 (► next) / null. Only live while
  // the arrows are shown (category level with more than one commandable actor).
  private hitArrow(bufX: number, bufY: number): number | null {
    if (!this.arrowsShown) return null;
    if (this.arrowL.bounds.contains(bufX, bufY)) return -1;
    if (this.arrowR.bounds.contains(bufX, bufY)) return 1;
    return null;
  }

  // The candidate target id under (x, y), or null — a radial hit-test over the armed command's
  // candidate ships (only meaningful at the target level, where the focus pointer is live).
  private pickTarget(bufX: number, bufY: number): string | null {
    const view = this.menu?.view();
    if (!view || view.level !== 'target' || !view.targets || !this.opts) return null;
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
  // (dispatch + close); null means we drilled a level (repaint + re-place the pointer).
  private commit(intent: ActionIntent | null): void {
    if (intent) {
      this.dispatch(intent);
      return;
    }
    this.refresh();
  }

  private dispatch(intent: ActionIntent): void {
    // In an encounter the menu IS the round's input: a committed intent folds into the reducer via
    // onEncounterCommit, NOT the live-view kind fork. Close first (the controller re-opens on the next
    // active combatant).
    if (this.encounterMode) {
      this.close();
      this.onEncounterCommit(intent);
      return;
    }
    // Live view: resolve the action's kind from the actor's OWN resolved command (commandFor) — there
    // is no central registry after the inversion. An unknown actionId resolves to undefined ⇒ the
    // immediate path. Read before close() nulls `opts`.
    const kind = this.opts ? commandFor(this.opts.actor, intent.actionId)?.grant.kind : undefined;
    this.close();
    if (kind === 'encounter') this.onEnterEncounter(intent);
    else this.onImmediate(intent);
  }

  private refresh(force = false): void {
    if (!this.menu) return;
    if (this.menu.closed) {
      this.close();
      return;
    }
    // Target selection HIDES the box (the focus pointer moves out to the target ship); the other
    // levels show it. A cursor/hover move only re-rides the pointer (the paint is cursor-independent),
    // so place() is gated on a real content change; the explicit re-anchor paths (resize / fleet
    // relayout) pass force — the anchored sprite moved even though the menu's content didn't.
    if (this.menu.view().level === 'target') {
      this.panel.setVisible(false);
    } else {
      const wasHidden = !this.panel.visible; // coming back from a target-level hide
      const changed = this.panel.setModel(this.buildModel());
      if (changed || force || wasHidden) this.place(); // re-place on re-show in case the anchor moved while hidden
      this.panel.setVisible(true);
    }
    this.updateAdornments();
  }

  // Re-place the bouncing focus pointer and the actor-switch arrows. The pointer is the UNIVERSAL
  // focus mark: on the cursor ROW at the category/command levels, and out on the locked TARGET ship
  // in the field at the target level. Arrows flank the box only at the category level (>1 actor).
  // The pointer's per-frame bob is applied in tick(); this only sets where it rests.
  private updateAdornments(): void {
    const view = this.menu!.view();

    const base = view.level === 'target' ? this.targetPointerBase(view) : this.panel.cursorPointerAnchor();
    this.pointerBase = base;
    if (base) {
      this.pointer.setVisible(true);
      this.pointer.moveTo(base.left, base.centerY); // seed; tick() adds the bob
    } else {
      this.pointer.setVisible(false);
    }

    const box = this.panel.boxBounds();
    const showArrows = view.level === 'category' && (this.opts?.actorCount ?? 0) > 1 && box !== null;
    if (showArrows && box) {
      const centerY = box.y + box.h / 2;
      this.arrowL.placeAt(Math.round(box.x - ARROW_GAP - this.arrowL.width), Math.round(centerY - this.arrowL.height / 2));
      this.arrowR.placeAt(Math.round(box.x + box.w + ARROW_GAP), Math.round(centerY - this.arrowR.height / 2));
      this.arrowL.setVisible(true);
      this.arrowR.setVisible(true);
    } else {
      this.arrowL.setVisible(false);
      this.arrowR.setVisible(false);
    }
    this.arrowsShown = showArrows;
  }

  // The focus pointer's resting placement on the locked TARGET ship (target level): just left of
  // the sprite, pointing right at it. Null when there's no target to point at.
  private targetPointerBase(view: MenuView): { left: number; centerY: number } | null {
    if (!view.targets || view.targets.length === 0 || !this.opts) return null;
    const id = view.targets[view.targetCursor ?? 0];
    const c = id ? this.opts.slotCenterFor(id) : null;
    if (!c) return null;
    return { left: Math.round(c.cx - c.r - POINTER_TARGET_GAP - this.pointer.width), centerY: Math.round(c.cy) };
  }

  private buildModel() {
    const view = this.menu!.view();
    return {
      title: this.opts!.title,
      rows: view.rows.map((r) => ({ label: r.label, enabled: r.enabled })),
      cursor: view.cursor,
    };
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

    // Reserve room for the flanking ◄ ► arrows on BOTH sides whenever this actor can switch —
    // level-independent, so the box doesn't jump when you drill category↔command. The extra
    // offset pushes the box out far enough that the inner arrow clears the sprite; the inset
    // clamp keeps the outer arrow on-screen (and off the sidebar strip).
    const arm = this.arrowReach();
    const offset = anchor.r + MENU_GAP + arm;
    const pad = sizes.edgePad;
    let left = anchor.cx + offset;
    if (left + w + arm > this.contentW - pad) left = anchor.cx - offset - w; // flip if the right footprint overflows
    // Center the BOX (not the whole canvas) on the sprite — the box sits at the canvas bottom,
    // the label floats above it — then clamp using the full canvas height so the label never
    // runs off the top, and the arrow span so neither arrow runs off the side.
    let bottom = anchor.cy - Math.round(this.panel.boxHeight / 2);
    left = Math.max(pad + arm, Math.min(this.contentW - pad - w - arm, left));
    bottom = Math.max(pad, Math.min(this.bufH - pad - h, bottom));
    this.panel.placeAt(Math.round(left), Math.round(bottom));
  }

  // The horizontal span (px) one actor-switch arrow needs beyond the box edge — reserved on both
  // sides by place() when this actor is one of several to switch between. Zero when there's
  // nothing to switch to (so the single-actor layout is byte-identical to before the arrows).
  private arrowReach(): number {
    return (this.opts?.actorCount ?? 0) > 1 ? ARROW_GAP + this.arrowL.width : 0;
  }
}
