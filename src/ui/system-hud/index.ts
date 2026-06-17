// SystemHud — the floating chrome for the system view. Two pieces live here:
//   - backBtn  — IconButton in the top-left corner (the only click target).
//   - bodyCard — transient on-hover tooltip for the disc under the cursor.
//
// The selected body's facilities + the system name now live in the persistent
// Sidebar's contextual region (src/ui/sidebar/system-context.ts), not here. The
// diagram (stars + bodies + moons) is rendered by SystemDiagram into the content
// area beneath this HUD.

import { CanvasTexture, OrthographicCamera, Scene } from 'three';
import type { DiagramPick } from '../../scene/system-diagram';
import { type HitResult } from '../hit-test';
import { paintLeftArrow, paintSurface } from '../painter';
import { colors, sizes } from '../theme';
import { paintToTexture } from '../widget';
import { IconButton, type IconButtonStates } from '../icon-button';
import { BodyInfoCard } from './body-info-card';

// The back button box renders at twice the shared icon-box size; the arrow glyph
// stays at its native 1× resolution (centered), so the button is bigger without
// blowing the pixel art up into chunky blocks.
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

export class SystemHud {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  private readonly backBtn: IconButton;
  private readonly backBtnTextures: IconButtonStates;
  private readonly bodyCard: BodyInfoCard;

  // Cursor offset for the body info tooltip. Big enough that the card never sits
  // under the cursor (which would create hover cycles with the disc the cursor is
  // meant to be on).
  private readonly CARD_CURSOR_OFFSET = 12;

  // Fired when the user clicks the back button. SystemScene wires this to onExit,
  // which AppController routes to exitSystem.
  onBack: () => void = () => {};

  constructor() {
    this.backBtnTextures = {
      off:   buildBackBtnTexture(false),
      hover: buildBackBtnTexture(true),
    };
    this.backBtn = new IconButton(BACK_BTN_SIZE, this.backBtnTextures, {
      renderOrder: 100,
      hitPad: sizes.iconHitPad,
    });
    this.backBtn.addTo(this.scene);

    // Body info card renders on top of the back button (100), starts hidden, and
    // shows whenever setHoveredBody is called with a non-null pick.
    this.bodyCard = new BodyInfoCard(110);
    this.bodyCard.addTo(this.scene);
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.layoutAll();
  }

  // Returns true if the click was consumed by the HUD. Only the back button takes
  // pointer events.
  handleClick(bufX: number, bufY: number): boolean {
    if (this.backBtn.bounds.contains(bufX, bufY)) {
      this.onBack();
      return true;
    }
    return false;
  }

  handlePointerMove(bufX: number, bufY: number): boolean {
    const onBack = this.backBtn.bounds.contains(bufX, bufY);
    this.backBtn.setHover(onBack);
    return onBack;
  }

  hitTest(bufX: number, bufY: number): HitResult {
    if (this.backBtn.bounds.contains(bufX, bufY)) return 'interactive';
    return 'transparent';
  }

  // Show / update / hide the body info card based on what the scene's picker
  // returned. Null = hide. Non-null = repaint (only on target change) and place
  // near the cursor, flipping across the cursor axis when the default below-right
  // placement would clip a screen edge.
  setHoveredBody(pick: DiagramPick | null, bufX: number, bufY: number): void {
    if (!pick) {
      this.bodyCard.setVisible(false);
      this.bodyCard.clearTarget();
      return;
    }
    this.bodyCard.setTarget(pick);
    const w = this.bodyCard.width;
    const h = this.bodyCard.height;
    // A pick with no rows (e.g. an unknown-class body with every numeric field
    // null) measures to (0, 0); BasePanel hides it automatically.
    if (w === 0 || h === 0) {
      this.bodyCard.setVisible(false);
      return;
    }

    const offset = this.CARD_CURSOR_OFFSET;
    const pad = sizes.edgePad;
    // Default: below-right of cursor on screen. In Y-up buffer coords "below the
    // cursor on screen" means a smaller bufY.
    let left = bufX + offset;
    if (left + w > this.bufferW - pad) left = bufX - offset - w;
    let bottom = bufY - offset - h;
    if (bottom < pad) bottom = bufY + offset;
    // Final clamp covers the degenerate "card too big to fit on either side" case
    // — picks a viewport corner over clipping off-edge.
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
  }

  dispose(): void {
    for (const k of Object.keys(this.backBtnTextures) as Array<keyof IconButtonStates>) {
      this.backBtnTextures[k]?.dispose();
    }
    this.backBtn.dispose();
    this.bodyCard.dispose();
  }
}
