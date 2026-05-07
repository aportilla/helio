// SystemHud — composition root for the system view's HUD overlay.
//
// Mirrors MapHud's structure: own scene + ortho camera + composed widgets,
// drawn after the main scene with autoClear off. Owns:
//   - headerBar (top, full-width) — system name centered
//   - backBtn   (left edge of header) — IconButton, fires onBack
//   - infoCard  (top-left of content area) — same widget the galaxy view
//                uses, listing every cluster member
//
// The InfoCard is reused as-is (no close-X — the system view's exit is
// the back button in the header).

import {
  CanvasTexture,
  OrthographicCamera,
  Scene,
} from 'three';
import { paintLeftArrow, paintSurface } from '../painter';
import { colors, sizes } from '../theme';
import { paintToTexture } from '../widget';
import { IconButton, type IconButtonStates } from '../icon-button';
import { InfoCard } from '../map-hud/info-card';
import { HEADER_HEIGHT, HeaderBar } from './header-bar';

function buildBackBtnTexture(hover: boolean): CanvasTexture {
  const SIZE = sizes.iconBox;
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

  // Only the height needs caching for layout — the bar/header span the
  // full canvas width, fed straight into headerBar.setWidth(), and no
  // right-anchored chrome lives here yet.
  private bufferH = 1;

  private readonly headerBar: HeaderBar;
  private readonly backBtn: IconButton;
  private readonly infoCard: InfoCard;
  private readonly backBtnTextures: IconButtonStates;

  // Fired when the user clicks the back button. SystemScene wires this
  // to onExit, which AppController routes to exitSystem.
  onBack: () => void = () => {};

  constructor(clusterIdx: number) {
    this.headerBar = new HeaderBar(clusterIdx, 99);
    this.headerBar.addTo(this.scene);

    this.backBtnTextures = {
      off:   buildBackBtnTexture(false),
      hover: buildBackBtnTexture(true),
    };
    this.backBtn = new IconButton(sizes.iconBox, this.backBtnTextures, {
      renderOrder: 100,
      hitPad: sizes.iconHitPad,
    });
    this.backBtn.addTo(this.scene);

    this.infoCard = new InfoCard(100);
    this.infoCard.addTo(this.scene);
    this.infoCard.setCluster(clusterIdx);
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.headerBar.setWidth(bufferW);
    this.layoutAll();
  }

  // Returns true if the click hit any HUD interactive element.
  handleClick(bufX: number, bufY: number): boolean {
    if (this.backBtn.bounds.contains(bufX, bufY)) {
      this.onBack();
      return true;
    }
    return false;
  }

  // Returns true if the cursor is over an interactive element so the
  // caller can swap to the pointer cursor.
  handlePointerMove(bufX: number, bufY: number): boolean {
    const onBack = this.backBtn.bounds.contains(bufX, bufY);
    this.backBtn.setHover(onBack);
    return onBack;
  }

  private layoutAll(): void {
    // Header bar: full-width strip flush with the top of the canvas.
    this.headerBar.placeAt(0, this.bufferH - HEADER_HEIGHT);

    // Back button: left side of the header, vertically centered. The
    // -1 on the available height accounts for the bottom accent line so
    // the icon visually centers on the header's interior, not its frame.
    const headerBottom = this.bufferH - HEADER_HEIGHT;
    const innerH = HEADER_HEIGHT - 1;
    const btnBottom = headerBottom + Math.floor((innerH - sizes.iconBox) / 2) + 1;
    this.backBtn.placeAt(sizes.edgePad, btnBottom);

    // Info card: top-left of the content area, just under the header.
    const cardTop = headerBottom - sizes.cardMargin;
    this.infoCard.placeAt(sizes.cardMargin, cardTop - this.infoCard.height);
  }

  dispose(): void {
    for (const k of Object.keys(this.backBtnTextures) as Array<keyof IconButtonStates>) {
      this.backBtnTextures[k]?.dispose();
    }
    this.headerBar.dispose();
    this.backBtn.dispose();
    this.infoCard.dispose();
  }
}
