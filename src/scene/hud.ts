import {
  CanvasTexture,
  ClampToEdgeWrapping,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
} from 'three';
import { STARS } from '../data/stars';
import { FONTS, drawPixelText, getFont, measurePixelText } from '../data/pixel-font';

// HUD chrome (title, scale bar, toggle buttons) rendered as native pixel-art
// in a second orthographic pass after the main scene. The HUD camera is set
// up so 1 world unit = 1 buffer pixel, with origin at bottom-left, Y-up. All
// HUD geometry uses Mesh + PlaneGeometry so positions and sizes are integer
// pixel counts that map 1:1 to the buffer pixel grid.

const PADDING = 8;          // distance from screen edges
const BTN_GAP = 4;          // horizontal gap between buttons
// Info card sits a touch farther from the corner than the title/buttons so
// the boxed border has visible breathing room around it.
const INFO_CARD_MARGIN = 14;
// Inner padding within the info card box (in env pixels). Larger than the
// generic boxed-label pad because the card is the primary read surface and
// mixes a tall display font with smaller monospaced body lines.
const INFO_CARD_PAD_X = 8;
const INFO_CARD_PAD_Y = 6;
// Vertical gap between the EspySans name line and the Monaco body lines.
const INFO_CARD_NAME_GAP = 2;
// All HUD sizes are in *env pixels* — 1 env pixel = ENV_PX_PER_SCREEN_PX
// (currently 3) physical screen pixels after the browser's nearest-neighbor
// upscale. So a value of 3 here renders as a 9-physical-pixel-tall tick:
// 1 env (3 physical) above the bar, 1 env (3 physical) for the bar itself,
// 1 env (3 physical) below.
const SCALE_TICK_H = 3;
const SCALE_LABEL_GAP = 2;  // gap between the bar and its label below

const COLOR_TITLE_BRIGHT = '#5ec8ff';
const COLOR_TITLE_DIM    = '#2d7ab8';
const COLOR_ACCENT       = '#3a8fe0';  // bright grid color (left border, on-state border)
const COLOR_BORDER       = '#1e6fc4';  // dim grid color (off-state border)
const COLOR_BG_ON        = '#10325d';  // dim blue fill behind on-state buttons
const COLOR_BTN_OFF_TEXT = '#5ec8ff';
const COLOR_BTN_ON_TEXT  = '#ffffff';
const COLOR_BTN_HOVER_TEXT = '#cfeeff';
const COLOR_SCALE        = 0xe8f6ff;   // near-white for the scale bar + ticks

// Close-X dismisses the info card. The button is a square sitting flush in
// the card's top-right corner: its left + bottom edges are drawn into the
// texture in the dialog border color, while its top + right edges are the
// card's own border showing through. The X glyph (9x9, odd so the diagonal
// lands on a clean center pixel) is centered in the 17x17 box with 3 px of
// breathing room on every side (effective inner area is 15x15 after the 1 px
// strokes/borders, leaving (15-9)/2 = 3 px per side). (BOX_SIZE - SIZE must
// be an even, positive integer so the glyph centers cleanly.) Hit pad
// extends the click target slightly past the box so the target is forgiving
// at small pixel sizes.
const CLOSE_X_SIZE = 9;
const CLOSE_X_BOX_SIZE = 17;
const CLOSE_X_HIT_PAD = 2;
// Visual gap between the star name and the close-X box on the name line.
const NAME_TO_CLOSE_X_GAP = 4;
const COLOR_CLOSE_X       = '#2d7ab8';
const COLOR_CLOSE_X_HOVER = '#5ec8ff';

export type ToggleId = 'labels' | 'drops' | 'spin';
export type ActionId = 'reset';
type ButtonId = ToggleId | ActionId;

interface HudButton {
  id: ButtonId;
  toggle: boolean;
  on: boolean;
  hover: boolean;
  W: number;
  H: number;
  textures: { off: CanvasTexture; offHover: CanvasTexture; on: CanvasTexture; onHover: CanvasTexture };
  mesh: Mesh;
  mat: MeshBasicMaterial;
  // Top-left of the button bounding box in HUD coords (Y-up).
  bx: number;
  by: number;
}

function nearestFilteredTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(canvas);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  // colorSpace left at default — ColorManagement is disabled (see scene.ts)
  // so canvas pixels pass through to the framebuffer untouched.
  return t;
}

function buildTitleTexture(): { tex: CanvasTexture; w: number; h: number } {
  const line1 = 'NEARBY STARS';
  const line2 = '< 20 LIGHT YEARS  SOLAR NEIGHBOURHOOD';
  const accentW = 2;
  const gapL = 4;
  const padR = 4;
  const padTopBot = 3;
  // const titleFont = FONTS.Geneva[22];
  const titleFont = FONTS.EspySans[20];
  const subtitleFont = FONTS.Monaco[11];
  const w1 = measurePixelText(line1, titleFont);
  const w2 = measurePixelText(line2, subtitleFont);
  const lineH1 = getFont(titleFont).lineHeight;
  const lineH2 = getFont(subtitleFont).lineHeight;
  const W = accentW + gapL + Math.max(w1, w2) + padR;
  const H = lineH1 + lineH2 + padTopBot * 2;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;

  // Left accent bar in bright cyan, mirroring the original CSS border-left.
  g.fillStyle = COLOR_ACCENT;
  g.fillRect(0, 0, accentW, H);

  drawPixelText(g, line1, accentW + gapL, padTopBot, COLOR_TITLE_BRIGHT, titleFont);
  drawPixelText(g, line2, accentW + gapL, padTopBot + lineH1, COLOR_TITLE_DIM, subtitleFont);

  return { tex: nearestFilteredTexture(c), w: W, h: H };
}

type ButtonState = 'off' | 'offHover' | 'on' | 'onHover';

function buildButtonTexture(text: string, state: ButtonState, toggle: boolean): { tex: CanvasTexture; w: number; h: number } {
  const textW = measurePixelText(text);
  const padX = 6;
  const padY = 3;
  const W = textW + padX * 2;
  const H = getFont().lineHeight + padY * 2;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;

  const isOn = state === 'on' || state === 'onHover';
  const isHover = state === 'offHover' || state === 'onHover';
  const borderColor = isOn || isHover ? COLOR_ACCENT : COLOR_BORDER;
  const textColor = isOn
    ? COLOR_BTN_ON_TEXT
    : isHover
      ? COLOR_BTN_HOVER_TEXT
      : COLOR_BTN_OFF_TEXT;

  if (isOn) {
    g.fillStyle = COLOR_BG_ON;
    g.fillRect(0, 0, W, H);
  }
  // 1px border
  g.fillStyle = borderColor;
  g.fillRect(0, 0, W, 1);
  g.fillRect(0, H - 1, W, 1);
  g.fillRect(0, 0, 1, H);
  g.fillRect(W - 1, 0, 1, H);

  // Center the text horizontally; vertical baseline matches the label sprites.
  const textX = Math.round((W - textW) / 2);
  drawPixelText(g, text, textX, padY, textColor);

  // Non-toggle buttons (e.g. "reset view") never reach the on/onHover states
  // but we still need a texture for them — `toggle` is just here to make
  // skipping the on-state textures explicit at the call site.
  void toggle;

  return { tex: nearestFilteredTexture(c), w: W, h: H };
}

function buildCloseXTexture(color: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = CLOSE_X_BOX_SIZE; c.height = CLOSE_X_BOX_SIZE;
  const g = c.getContext('2d')!;

  // L-shaped border (always the dialog border color, regardless of hover) —
  // the strokes are structural so they don't change with the X's state.
  g.fillStyle = COLOR_ACCENT;
  g.fillRect(0, 0, 1, CLOSE_X_BOX_SIZE);                       // left
  g.fillRect(0, CLOSE_X_BOX_SIZE - 1, CLOSE_X_BOX_SIZE, 1);    // bottom

  // X glyph centered inside the box. Two diagonal lines one pixel wide
  // intersecting at the glyph's center pixel.
  const off = (CLOSE_X_BOX_SIZE - CLOSE_X_SIZE) / 2;
  g.fillStyle = color;
  for (let i = 0; i < CLOSE_X_SIZE; i++) {
    g.fillRect(off + i, off + i, 1, 1);
    g.fillRect(off + i, off + (CLOSE_X_SIZE - 1 - i), 1, 1);
  }
  return nearestFilteredTexture(c);
}

// Info card: star name in EspySans 15 (display font), body lines in the
// default Monaco 11 (key/value pairs). Built directly here rather than via
// makeLabelTexture so the two fonts and the wider internal padding can
// coexist on one canvas. The close-X is drawn separately as a sibling mesh
// — we only reserve horizontal space for it on the name line so a long star
// name doesn't run under it.
function buildInfoCardTexture(starIdx: number): { tex: CanvasTexture; w: number; h: number } {
  const s = STARS[starIdx];
  const NAME_COLOR = '#ffe98a';
  const KEY_COLOR  = '#2d7ab8';
  const VAL_COLOR  = '#aee4ff';
  const BG_COLOR     = 'rgba(0,8,20,0.92)';
  const BORDER_COLOR = '#3a8fe0';

  const nameFont = FONTS.EspySans[15];
  const nameLineH = getFont(nameFont).lineHeight;
  const bodyLineH = getFont().lineHeight;

  const body: Array<{ key: string; val: string }> = [
    { key: 'class    ', val: s.cls },
    { key: 'distance ', val: `${s.distLy.toFixed(2)} ly` },
    { key: 'mass     ', val: `${s.mass.toFixed(2)} Msun` },
    { key: 'diameter ', val: `${s.radiusSolar.toFixed(2)} Dsun` },
  ];

  const nameW = measurePixelText(s.name, nameFont);
  let maxBodyW = 0;
  for (const b of body) {
    const w = measurePixelText(b.key) + measurePixelText(b.val);
    if (w > maxBodyW) maxBodyW = w;
  }
  // Close-X sits flush at the top-right corner (drawn as an overlay mesh) —
  // it consumes the right padding strip on the name line, so the name only
  // needs to fit up to (W - CLOSE_X_BOX_SIZE - GAP). Body lines still need
  // symmetric padding on both sides.
  const W = Math.max(
    INFO_CARD_PAD_X + nameW + NAME_TO_CLOSE_X_GAP + CLOSE_X_BOX_SIZE,
    INFO_CARD_PAD_X * 2 + maxBodyW,
  );
  const H = INFO_CARD_PAD_Y * 2 + nameLineH + INFO_CARD_NAME_GAP + bodyLineH * body.length;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = BG_COLOR;
  g.fillRect(0, 0, W, H);
  g.fillStyle = BORDER_COLOR;
  g.fillRect(0, 0, W, 1); g.fillRect(0, H - 1, W, 1);
  g.fillRect(0, 0, 1, H); g.fillRect(W - 1, 0, 1, H);

  drawPixelText(g, s.name, INFO_CARD_PAD_X, INFO_CARD_PAD_Y, NAME_COLOR, nameFont);

  let cursorY = INFO_CARD_PAD_Y + nameLineH + INFO_CARD_NAME_GAP;
  for (const b of body) {
    drawPixelText(g, b.key, INFO_CARD_PAD_X, cursorY, KEY_COLOR);
    drawPixelText(g, b.val, INFO_CARD_PAD_X + measurePixelText(b.key), cursorY, VAL_COLOR);
    cursorY += bodyLineH;
  }

  return { tex: nearestFilteredTexture(c), w: W, h: H };
}

function buildScaleLabelTexture(text: string): { tex: CanvasTexture; w: number; h: number } {
  const padX = 1;
  const padY = 1;
  const tw = measurePixelText(text);
  const W = tw + padX * 2;
  const H = getFont().lineHeight + padY * 2;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  drawPixelText(g, text, padX, padY, '#e8f6ff');
  return { tex: nearestFilteredTexture(c), w: W, h: H };
}

export class Hud {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  private readonly titleMesh: Mesh;
  private readonly titleW: number;
  private readonly titleH: number;

  private readonly buttons: HudButton[] = [];

  // Scale bar parts. Bar + ticks share a single material (same color); label
  // gets its own material because its texture changes when the step changes.
  private readonly scaleBarMesh: Mesh;
  private readonly scaleLeftTickMesh: Mesh;
  private readonly scaleRightTickMesh: Mesh;
  private readonly scaleLabelMesh: Mesh;
  private readonly scaleLabelMat: MeshBasicMaterial;
  private scaleStep = -1;
  private scaleWidthPx = 0;
  private scaleLabelH = 0;

  // Selection info card (top-right). Texture rebuilt on selection change.
  private readonly infoCardMesh: Mesh;
  private readonly infoCardMat: MeshBasicMaterial;
  private infoCardW = 0;
  private infoCardH = 0;
  private selectedStar = -1;

  // Close-X on the card. Two pre-built textures (off/hover) swapped on hover.
  private readonly closeXMesh: Mesh;
  private readonly closeXMat: MeshBasicMaterial;
  private readonly closeXTexOff: CanvasTexture;
  private readonly closeXTexHover: CanvasTexture;
  private closeXBounds = { x: 0, y: 0, w: 0, h: 0 };
  private closeXHover = false;

  // Public callbacks. The scene wires these to its own toggle methods.
  onToggle: (id: ToggleId, on: boolean) => void = () => {};
  onAction: (id: ActionId) => void = () => {};
  onDeselect: () => void = () => {};

  constructor() {
    // ---- title -----------------------------------------------------------
    const title = buildTitleTexture();
    this.titleW = title.w;
    this.titleH = title.h;
    const titleMat = new MeshBasicMaterial({ map: title.tex, transparent: true, depthTest: false, depthWrite: false });
    this.titleMesh = new Mesh(new PlaneGeometry(title.w, title.h), titleMat);
    this.titleMesh.renderOrder = 100;
    this.scene.add(this.titleMesh);

    // ---- buttons ---------------------------------------------------------
    const specs: Array<{ id: ButtonId; text: string; toggle: boolean; on: boolean }> = [
      { id: 'labels', text: 'labels',    toggle: true,  on: true  },
      { id: 'drops',  text: 'droplines', toggle: true,  on: true  },
      { id: 'spin',   text: 'autospin',  toggle: true,  on: false },
      { id: 'reset',  text: 'reset view', toggle: false, on: false },
    ];
    for (const spec of specs) {
      const off      = buildButtonTexture(spec.text, 'off',      spec.toggle);
      const offHover = buildButtonTexture(spec.text, 'offHover', spec.toggle);
      const on       = spec.toggle ? buildButtonTexture(spec.text, 'on',      spec.toggle) : off;
      const onHover  = spec.toggle ? buildButtonTexture(spec.text, 'onHover', spec.toggle) : offHover;
      const initialTex = spec.on ? on.tex : off.tex;
      const mat = new MeshBasicMaterial({ map: initialTex, transparent: true, depthTest: false, depthWrite: false });
      const mesh = new Mesh(new PlaneGeometry(off.w, off.h), mat);
      mesh.renderOrder = 100;
      this.scene.add(mesh);
      this.buttons.push({
        id: spec.id, toggle: spec.toggle, on: spec.on, hover: false,
        W: off.w, H: off.h,
        textures: { off: off.tex, offHover: offHover.tex, on: on.tex, onHover: onHover.tex },
        mesh, mat, bx: 0, by: 0,
      });
    }

    // ---- scale bar -------------------------------------------------------
    const barMat = new MeshBasicMaterial({ color: COLOR_SCALE, transparent: false, depthTest: false, depthWrite: false });
    this.scaleBarMesh = new Mesh(new PlaneGeometry(1, 1), barMat);
    this.scaleLeftTickMesh = new Mesh(new PlaneGeometry(1, SCALE_TICK_H), barMat);
    this.scaleRightTickMesh = new Mesh(new PlaneGeometry(1, SCALE_TICK_H), barMat);
    this.scaleBarMesh.renderOrder = 100;
    this.scaleLeftTickMesh.renderOrder = 100;
    this.scaleRightTickMesh.renderOrder = 100;
    this.scaleBarMesh.visible = false;
    this.scaleLeftTickMesh.visible = false;
    this.scaleRightTickMesh.visible = false;
    this.scene.add(this.scaleBarMesh);
    this.scene.add(this.scaleLeftTickMesh);
    this.scene.add(this.scaleRightTickMesh);

    this.scaleLabelMat = new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
    this.scaleLabelMesh = new Mesh(new PlaneGeometry(1, 1), this.scaleLabelMat);
    this.scaleLabelMesh.renderOrder = 100;
    this.scaleLabelMesh.visible = false;
    this.scene.add(this.scaleLabelMesh);

    // ---- info card -------------------------------------------------------
    // Texture is rebuilt on selection change via setSelectedStar(); the mesh
    // exists hidden until then. Boxed-label style matches the hover tooltip
    // so "selected" and "hovered" UIs feel like the same family.
    this.infoCardMat = new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
    this.infoCardMesh = new Mesh(new PlaneGeometry(1, 1), this.infoCardMat);
    this.infoCardMesh.renderOrder = 100;
    this.infoCardMesh.visible = false;
    this.scene.add(this.infoCardMesh);

    // ---- close X on card -------------------------------------------------
    this.closeXTexOff   = buildCloseXTexture(COLOR_CLOSE_X);
    this.closeXTexHover = buildCloseXTexture(COLOR_CLOSE_X_HOVER);
    this.closeXMat = new MeshBasicMaterial({ map: this.closeXTexOff, transparent: true, depthTest: false, depthWrite: false });
    this.closeXMesh = new Mesh(new PlaneGeometry(CLOSE_X_BOX_SIZE, CLOSE_X_BOX_SIZE), this.closeXMat);
    this.closeXMesh.renderOrder = 101;  // above the card
    this.closeXMesh.visible = false;
    this.scene.add(this.closeXMesh);
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.layout();
  }

  setScale(step: number, widthPx: number): void {
    if (this.scaleStep === step && this.scaleWidthPx === widthPx) return;

    if (this.scaleStep !== step) {
      // Step change: rebuild label texture.
      const text = step === 1 ? '1 Light Year' : `${step} Light Years`;
      if (this.scaleLabelMat.map) this.scaleLabelMat.map.dispose();
      const lab = buildScaleLabelTexture(text);
      this.scaleLabelMat.map = lab.tex;
      this.scaleLabelMat.needsUpdate = true;
      this.scaleLabelH = lab.h;
      this.scaleLabelMesh.geometry.dispose();
      this.scaleLabelMesh.geometry = new PlaneGeometry(lab.w, lab.h);
    }
    this.scaleStep = step;
    this.scaleWidthPx = widthPx;

    this.scaleBarMesh.visible = true;
    this.scaleLeftTickMesh.visible = true;
    this.scaleRightTickMesh.visible = true;
    this.scaleLabelMesh.visible = true;
    this.layoutScale();
  }

  // Selection card. Pass -1 to clear. Rebuilds the boxed label texture only
  // when the selection actually changes; safe to call every frame, but the
  // scene only calls on click.
  setSelectedStar(starIdx: number): void {
    if (this.selectedStar === starIdx) return;
    this.selectedStar = starIdx;
    if (starIdx < 0) {
      this.infoCardMesh.visible = false;
      this.closeXMesh.visible = false;
      // Reset hover state so the next time the card appears, the X starts in
      // its off color regardless of where the cursor was last.
      if (this.closeXHover) {
        this.closeXHover = false;
        this.closeXMat.map = this.closeXTexOff;
        this.closeXMat.needsUpdate = true;
      }
      return;
    }
    if (this.infoCardMat.map) this.infoCardMat.map.dispose();
    const { tex, w, h } = buildInfoCardTexture(starIdx);
    this.infoCardMat.map = tex;
    this.infoCardMat.needsUpdate = true;
    this.infoCardW = w;
    this.infoCardH = h;
    this.infoCardMesh.geometry.dispose();
    this.infoCardMesh.geometry = new PlaneGeometry(w, h);
    this.infoCardMesh.visible = true;
    this.closeXMesh.visible = true;
    this.layoutInfoCard();
  }

  // External state sync — called when the scene toggles state from elsewhere
  // (e.g. keyboard shortcut) or when reset re-arms autospin off, etc.
  setToggleState(id: ToggleId, on: boolean): void {
    const b = this.buttons.find(b => b.id === id);
    if (!b || b.on === on) return;
    b.on = on;
    this.applyButtonTexture(b);
  }

  // Returns true if the click hit any HUD interactive element (button or
  // info-card close X) and the action was fired.
  handleClick(bufX: number, bufY: number): boolean {
    if (this.isOverCloseX(bufX, bufY)) {
      this.onDeselect();
      return true;
    }
    const hit = this.findButton(bufX, bufY);
    if (!hit) return false;
    if (hit.toggle) {
      hit.on = !hit.on;
      this.applyButtonTexture(hit);
      this.onToggle(hit.id as ToggleId, hit.on);
    } else {
      this.onAction(hit.id as ActionId);
    }
    return true;
  }

  // Returns true if the cursor is over any HUD interactive element (caller
  // changes cursor to pointer in that case).
  handlePointerMove(bufX: number, bufY: number): boolean {
    const onCloseX = this.isOverCloseX(bufX, bufY);
    if (onCloseX !== this.closeXHover) {
      this.closeXHover = onCloseX;
      this.closeXMat.map = onCloseX ? this.closeXTexHover : this.closeXTexOff;
      this.closeXMat.needsUpdate = true;
    }
    const hit = this.findButton(bufX, bufY);
    let changed = false;
    for (const b of this.buttons) {
      const wantHover = b === hit;
      if (b.hover !== wantHover) {
        b.hover = wantHover;
        this.applyButtonTexture(b);
        changed = true;
      }
    }
    void changed;
    return hit !== null || onCloseX;
  }

  clearHover(): void {
    for (const b of this.buttons) {
      if (b.hover) {
        b.hover = false;
        this.applyButtonTexture(b);
      }
    }
  }

  private applyButtonTexture(b: HudButton): void {
    const tex = b.on
      ? (b.hover ? b.textures.onHover : b.textures.on)
      : (b.hover ? b.textures.offHover : b.textures.off);
    b.mat.map = tex;
    b.mat.needsUpdate = true;
  }

  private findButton(bufX: number, bufY: number): HudButton | null {
    for (const b of this.buttons) {
      if (bufX >= b.bx && bufX < b.bx + b.W && bufY >= b.by && bufY < b.by + b.H) return b;
    }
    return null;
  }

  // -- layout ------------------------------------------------------------

  private layout(): void {
    // Title at top-left.
    this.titleMesh.position.set(PADDING + this.titleW / 2, this.bufferH - PADDING - this.titleH / 2, 0);

    // Buttons at bottom-right, horizontal row, right-aligned.
    let cursor = this.bufferW - PADDING;
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      const right = cursor;
      const left = right - b.W;
      b.bx = left;
      b.by = PADDING;
      b.mesh.position.set(left + b.W / 2, PADDING + b.H / 2, 0);
      cursor = left - BTN_GAP;
    }

    this.layoutScale();
    this.layoutInfoCard();
  }

  private layoutInfoCard(): void {
    if (!this.infoCardMesh.visible) return;
    // Top-right corner. Uses INFO_CARD_MARGIN (a touch farther in than the
    // title/buttons' PADDING) so the boxed border has visible breathing
    // room from the screen edge. Mesh origin is at center, so position =
    // (right edge - half width, top edge - half height). All values are
    // integer pixel counts so the texture texels land 1:1 on buffer pixels.
    const cx = this.bufferW - INFO_CARD_MARGIN - this.infoCardW / 2;
    const cy = this.bufferH - INFO_CARD_MARGIN - this.infoCardH / 2;
    this.infoCardMesh.position.set(cx, cy, 0);

    // Close-X box flush with the card's top-right corner. Position is
    // half-integer because CLOSE_X_BOX_SIZE is odd; the 17 px texture maps
    // onto the 17 pixels (cardRight - 17) .. (cardRight - 1).
    const cardRight = this.bufferW - INFO_CARD_MARGIN;
    const cardTop   = this.bufferH - INFO_CARD_MARGIN;
    const closeCX = cardRight - CLOSE_X_BOX_SIZE / 2;
    const closeCY = cardTop   - CLOSE_X_BOX_SIZE / 2;
    this.closeXMesh.position.set(closeCX, closeCY, 0);
    this.closeXBounds = {
      x: cardRight - CLOSE_X_BOX_SIZE - CLOSE_X_HIT_PAD,
      y: cardTop   - CLOSE_X_BOX_SIZE - CLOSE_X_HIT_PAD,
      w: CLOSE_X_BOX_SIZE + 2 * CLOSE_X_HIT_PAD,
      h: CLOSE_X_BOX_SIZE + 2 * CLOSE_X_HIT_PAD,
    };
  }

  private isOverCloseX(bufX: number, bufY: number): boolean {
    if (!this.closeXMesh.visible) return false;
    const b = this.closeXBounds;
    return bufX >= b.x && bufX < b.x + b.w && bufY >= b.y && bufY < b.y + b.h;
  }

  private layoutScale(): void {
    if (this.scaleWidthPx <= 0) return;
    // Layout from bottom up: label, gap, then the tick block with the bar
    // running through its vertical center (so each tick extends equally
    // above and below the bar — proper end-cap measurement marks).
    const labelCY = PADDING + this.scaleLabelH / 2;
    const tickBottom = labelCY + this.scaleLabelH / 2 + SCALE_LABEL_GAP;
    const barCY = tickBottom + SCALE_TICK_H / 2;  // bar AND tick share this center
    const tickCY = barCY;

    const barLeft = PADDING;
    const barRight = barLeft + this.scaleWidthPx;

    this.scaleBarMesh.scale.set(this.scaleWidthPx, 1, 1);
    this.scaleBarMesh.position.set(barLeft + this.scaleWidthPx / 2, barCY, 0);

    // Ticks are 1px-wide vertical bars at each end, aligned to the integer
    // pixel column (offset by 0.5 because mesh center sits at pixel center).
    this.scaleLeftTickMesh.scale.set(1, SCALE_TICK_H, 1);
    this.scaleLeftTickMesh.position.set(barLeft + 0.5, tickCY, 0);
    this.scaleRightTickMesh.scale.set(1, SCALE_TICK_H, 1);
    this.scaleRightTickMesh.position.set(barRight - 0.5, tickCY, 0);

    // Label centered horizontally under the bar. The label width is always
    // even (font advance is 6 × char count + even padding), so center X must
    // be an integer for the quad's edges to land on pixel boundaries; round
    // the natural center because it's half-integer whenever the bar width
    // is odd. Without this, the rasterizer skips a column of edge texels
    // and the text rendering looks fuzzy/off-grid.
    this.scaleLabelMesh.position.set(Math.round(barLeft + this.scaleWidthPx / 2), labelCY, 0);
  }
}
