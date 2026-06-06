// TestHud — composition root for the planet-test-grid view's HUD overlay.
// Peer of SystemHud, trimmed to the two static pieces this view needs:
//
//   - backBtn — IconButton floating in the top-left corner.
//   - title   — fixed label anchored to the top-right corner with the same
//               edgePad inset as the back button. Display-only, transparent
//               to pointer hits.
//
// No body-info card: the grid is a fixed set of synthetic discs with no
// picking, so there's nothing to hover and nothing to describe.

import {
  CanvasTexture,
  OrthographicCamera,
  Scene,
} from 'three';
import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { BasePanel } from '../../ui/base-panel';
import { type HitResult } from '../../ui/hit-test';
import { paintLeftArrow, paintSurface } from '../../ui/painter';
import { colors, fonts, sizes } from '../../ui/theme';
import { paintToTexture } from '../../ui/widget';
import { IconButton, type IconButtonStates } from '../../ui/icon-button';

// Constant title shown top-right; this view is the same fixed grid every time.
const TITLE_TEXT = 'Planet Test';

// The back button box renders at twice the shared icon-box size; the arrow
// glyph stays at its native 1× resolution (centered), so the button is bigger
// without blowing the pixel art up into chunky blocks.
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

// Title texture. Painted once at construction (the text is constant);
// TestHud handles placement on each resize.
class TitleLabel extends BasePanel {
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

export class TestHud {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  private readonly title: TitleLabel;
  private readonly backBtn: IconButton;
  private readonly backBtnTextures: IconButtonStates;

  // Fired when the user clicks the back button. TestScene wires this to
  // onExit, which AppController routes back out of the test view.
  onBack: () => void = () => {};

  constructor() {
    this.title = new TitleLabel(TITLE_TEXT, 99);
    this.title.addTo(this.scene);
    this.title.rebuild();

    this.backBtnTextures = {
      off:   buildBackBtnTexture(false),
      hover: buildBackBtnTexture(true),
    };
    this.backBtn = new IconButton(BACK_BTN_SIZE, this.backBtnTextures, {
      renderOrder: 100,
      hitPad: sizes.iconHitPad,
    });
    this.backBtn.addTo(this.scene);
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.layoutAll();
  }

  // Returns true if the click was consumed by the HUD. The title is
  // display-only; only the back button takes pointer events.
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

  private layoutAll(): void {
    // Back button: top-left, edgePad on both axes.
    this.backBtn.placeAt(
      sizes.edgePad,
      this.bufferH - sizes.edgePad - BACK_BTN_SIZE,
    );

    // Title: anchored to the top-right corner with the same edgePad inset as
    // the back button uses on the top-left, so the two pieces of chrome read
    // as a balanced pair across the top.
    const titleW = this.title.width;
    const titleH = this.title.height;
    const titleLeft = this.bufferW - sizes.edgePad - titleW;
    const titleBottom = this.bufferH - sizes.edgePad - titleH;
    this.title.placeAt(titleLeft, titleBottom);
  }

  dispose(): void {
    for (const k of Object.keys(this.backBtnTextures) as Array<keyof IconButtonStates>) {
      this.backBtnTextures[k]?.dispose();
    }
    this.title.dispose();
    this.backBtn.dispose();
  }
}
