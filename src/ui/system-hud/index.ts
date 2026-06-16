// SystemHud — composition root for the system view's HUD overlay.
//
// Three pieces of chrome live here:
//   - backBtn   — IconButton floating in the top-left corner.
//   - nameLabel — system name anchored to the top-right corner with the
//                 same edgePad inset as the back button. Display-only,
//                 transparent to pointer hits.
//   - bodyCard  — transient on-hover tooltip for the disc under the
//                 cursor (star, planet, or moon). Display-only,
//                 cursor-following with edge-flip placement.
//
// The diagram (stars + bodies + moons) is rendered by SystemDiagram into
// the content area beneath this HUD — see system-diagram.ts.

import {
  CanvasTexture,
  OrthographicCamera,
  Scene,
} from 'three';
import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { clusterDisplayName } from '../../data/stars';
import type { DiagramPick } from '../../scene/system-diagram';
import { BasePanel } from '../base-panel';
import { type HitResult } from '../hit-test';
import { paintLeftArrow, paintSurface } from '../painter';
import { colors, fonts, sizes } from '../theme';
import { paintToTexture } from '../widget';
import { IconButton, type IconButtonStates } from '../icon-button';
import { BodyInfoCard } from './body-info-card';
import { FacilitiesPanel, type SelectedBodyInfo } from './facilities-panel';

// The back button box renders at twice the shared icon-box size; the
// arrow glyph stays at its native 1× resolution (centered), so the button
// is bigger without blowing the pixel art up into chunky blocks.
const BACK_BTN_SIZE = sizes.iconBox * 2;

function buildBackBtnTexture(hover: boolean): CanvasTexture {
  const SIZE = BACK_BTN_SIZE;
  const c = document.createElement('canvas');
  c.width = SIZE; c.height = SIZE;
  const g = c.getContext('2d')!;
  paintSurface(g, 0, 0, SIZE, SIZE, {
    bg: colors.surface,
    border: hover ? colors.borderAccent : colors.borderDim,
  });
  paintLeftArrow(g, 0, 0, SIZE, hover ? colors.glyphHover : colors.glyphOff);
  return paintToTexture(c);
}

// System-name title texture. Painted once at construction (system never
// changes mid-life); SystemHud handles placement on each resize.
class SystemNameLabel extends BasePanel {
  private readonly text: string;
  constructor(text: string, renderOrder: number) {
    super(renderOrder);
    this.text = text;
  }
  protected measure(): { w: number; h: number } {
    return {
      w: measurePixelText(this.text, fonts.title),
      h: getFont(fonts.title).lineHeight,
    };
  }
  protected paintInto(g: CanvasRenderingContext2D, _w: number, _h: number): void {
    drawPixelText(g, this.text, 0, 0, colors.starName, fonts.title);
  }
}

export class SystemHud {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  private readonly nameLabel: SystemNameLabel;
  private readonly backBtn: IconButton;
  private readonly backBtnTextures: IconButtonStates;
  private readonly bodyCard: BodyInfoCard;
  private readonly facilitiesPanel: FacilitiesPanel;

  // The body the facilities bar is currently showing (null = bar hidden).
  // Held so a click on the Add button knows which body to build on.
  private selectedInfo: SelectedBodyInfo | null = null;

  // Cursor offset for the body info tooltip. Big enough that the card
  // never sits under the cursor (which would create hover cycles with
  // the disc the cursor is meant to be on).
  private readonly CARD_CURSOR_OFFSET = 12;

  // Fired when the user clicks the back button. SystemScene wires this
  // to onExit, which AppController routes to exitSystem.
  onBack: () => void = () => {};

  // Fired from the facilities bar. SystemScene routes these to the
  // game-state store, then re-pushes the updated body via setSelectedBody.
  onAddFacility: (bodyId: string) => void = () => {};
  onRemoveFacility: (facilityId: string) => void = () => {};

  constructor(clusterIdx: number) {
    const text = clusterDisplayName(clusterIdx);

    this.nameLabel = new SystemNameLabel(text, 99);
    this.nameLabel.addTo(this.scene);
    this.nameLabel.rebuild();

    this.backBtnTextures = {
      off:   buildBackBtnTexture(false),
      hover: buildBackBtnTexture(true),
    };
    this.backBtn = new IconButton(BACK_BTN_SIZE, this.backBtnTextures, {
      renderOrder: 100,
      hitPad: sizes.iconHitPad,
    });
    this.backBtn.addTo(this.scene);

    // Body info card renders on top of every other piece of HUD chrome,
    // so its renderOrder sits above the back button (100) and name
    // label (99). It starts hidden and shows whenever setHoveredBody is
    // called with a non-null pick.
    this.bodyCard = new BodyInfoCard(110);
    this.bodyCard.addTo(this.scene);

    // Bottom bar. Renders below the floating chrome and the tooltip (which
    // can overhang it near the bottom edge), so it takes a lower renderOrder.
    this.facilitiesPanel = new FacilitiesPanel(98);
    this.facilitiesPanel.addTo(this.scene);
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    // The bar spans the full viewport width; re-render it at the new width
    // (keeps the current body) before layoutAll re-places it at the bottom.
    this.facilitiesPanel.setWidth(bufferW);
    this.layoutAll();
  }

  // Show / update / hide the facilities bar for the selected body. Null hides
  // it. SystemScene calls this on every selection change and after each
  // add/remove so the row list stays in sync with the game-state store.
  setSelectedBody(info: SelectedBodyInfo | null): void {
    this.selectedInfo = info;
    this.facilitiesPanel.setBody(info);
    if (this.facilitiesPanel.visible) this.facilitiesPanel.placeAt(0, 0);
  }

  // Returns true if the click was consumed by the HUD. The name label is
  // display-only; the back button and the facilities bar take pointer events.
  handleClick(bufX: number, bufY: number): boolean {
    if (this.backBtn.bounds.contains(bufX, bufY)) {
      this.onBack();
      return true;
    }
    if (this.facilitiesPanel.visible && this.facilitiesPanel.bounds.contains(bufX, bufY)) {
      const hit = this.facilitiesPanel.hitTest(bufX, bufY);
      if (hit?.kind === 'add' && this.selectedInfo) this.onAddFacility(this.selectedInfo.bodyId);
      else if (hit?.kind === 'remove') this.onRemoveFacility(hit.facilityId);
      // Background (or null) is absorbed too — a click on the bar must never
      // fall through to the scene and deselect the body it's describing.
      return true;
    }
    return false;
  }

  handlePointerMove(bufX: number, bufY: number): boolean {
    const onBack = this.backBtn.bounds.contains(bufX, bufY);
    this.backBtn.setHover(onBack);
    const onPanel = this.facilitiesPanel.visible && this.facilitiesPanel.handlePointerMove(bufX, bufY);
    return onBack || onPanel;
  }

  hitTest(bufX: number, bufY: number): HitResult {
    if (this.backBtn.bounds.contains(bufX, bufY)) return 'interactive';
    if (this.facilitiesPanel.visible && this.facilitiesPanel.bounds.contains(bufX, bufY)) {
      const hit = this.facilitiesPanel.hitTest(bufX, bufY);
      return hit && hit.kind !== 'background' ? 'interactive' : 'opaque';
    }
    return 'transparent';
  }

  // Show / update / hide the body info card based on what the scene's
  // picker returned. Null = hide. Non-null = repaint (only on target
  // change) and place near the cursor, flipping across the cursor axis
  // when the default below-right placement would clip a screen edge.
  setHoveredBody(pick: DiagramPick | null, bufX: number, bufY: number): void {
    if (!pick) {
      this.bodyCard.setVisible(false);
      this.bodyCard.clearTarget();
      return;
    }
    this.bodyCard.setTarget(pick);
    const w = this.bodyCard.width;
    const h = this.bodyCard.height;
    // A pick with no rows (e.g. an unknown-class body with every numeric
    // field null) measures to (0, 0); BasePanel hides it automatically.
    if (w === 0 || h === 0) {
      this.bodyCard.setVisible(false);
      return;
    }

    const offset = this.CARD_CURSOR_OFFSET;
    const pad = sizes.edgePad;
    // Default: below-right of cursor on screen. In Y-up buffer coords
    // "below the cursor on screen" means a smaller bufY.
    let left = bufX + offset;
    if (left + w > this.bufferW - pad) left = bufX - offset - w;
    let bottom = bufY - offset - h;
    if (bottom < pad) bottom = bufY + offset;
    // Final clamp covers the degenerate "card too big to fit on either
    // side" case — picks a viewport corner over clipping off-edge.
    left = Math.max(pad, Math.min(this.bufferW - pad - w, left));
    bottom = Math.max(pad, Math.min(this.bufferH - pad - h, bottom));
    this.bodyCard.placeAt(Math.round(left), Math.round(bottom));
    this.bodyCard.setVisible(true);
  }

  private layoutAll(): void {
    // Back button: top-left, edgePad on both axes.
    this.backBtn.placeAt(
      sizes.edgePad,
      this.bufferH - sizes.edgePad - BACK_BTN_SIZE,
    );

    // System name: anchored to the top-right corner with the same
    // edgePad inset as the back button uses on the top-left, so the two
    // pieces of chrome read as a balanced pair across the top.
    const nameW = this.nameLabel.width;
    const nameH = this.nameLabel.height;
    const nameLeft = this.bufferW - sizes.edgePad - nameW;
    const nameBottom = this.bufferH - sizes.edgePad - nameH;
    this.nameLabel.placeAt(nameLeft, nameBottom);

    // Facilities bar: flush to the bottom edge, full width.
    if (this.facilitiesPanel.visible) this.facilitiesPanel.placeAt(0, 0);
  }

  dispose(): void {
    for (const k of Object.keys(this.backBtnTextures) as Array<keyof IconButtonStates>) {
      this.backBtnTextures[k]?.dispose();
    }
    this.nameLabel.dispose();
    this.backBtn.dispose();
    this.bodyCard.dispose();
    this.facilitiesPanel.dispose();
  }
}
