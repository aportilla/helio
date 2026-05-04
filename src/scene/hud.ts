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
import { getSettings, setSetting } from '../settings';

// HUD chrome (title, scale bar, toggle buttons) rendered as native pixel-art
// in a second orthographic pass after the main scene. The HUD camera is set
// up so 1 world unit = 1 buffer pixel, with origin at bottom-left, Y-up. All
// HUD geometry uses Mesh + PlaneGeometry so positions and sizes are integer
// pixel counts that map 1:1 to the buffer pixel grid.

const PADDING = 8;          // distance from screen edges
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
const COLOR_BTN_OFF_TEXT = '#5ec8ff';
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

// Settings trigger — three horizontal "slider" lines centered in a 17x17
// box (matching the close-X size for visual consistency). Drawn into a
// transparent canvas so it lays cleanly over the scene without a
// background of its own; hover state swaps to a brighter color.
const SETTINGS_ICON_SIZE = 17;
const SETTINGS_ICON_HIT_PAD = 2;
// Settings modal panel — same boxed style as the info card, opens above
// the trigger at bottom-left. Internal padding matches the info card so
// the two read surfaces feel like the same family.
const SETTINGS_PANEL_PAD_X = 8;
const SETTINGS_PANEL_PAD_Y = 6;
// Vertical gap between the title line and the body rows.
const SETTINGS_PANEL_TITLE_GAP = 2;
// Gap between the trigger icon and the panel that opens above it.
const SETTINGS_PANEL_TRIGGER_GAP = 6;
// Checkbox glyph: a 9x9 square with a 1 px border (matches the close-X
// glyph width so the two pixel-art primitives feel the same scale).
// Filled state stamps a 3x3 dot in the center; centering is exact
// because (9 - 3) / 2 = 3.
const CHECKBOX_SIZE = 9;
const CHECKBOX_FILL_SIZE = 3;
const CHECKBOX_LABEL_GAP = 4;

export type ToggleId = 'labels' | 'drops' | 'spin';
export type ActionId = 'reset';

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

// Draws a pill-style action button (1 px border, centered text) directly
// into an existing 2D context at (x, y). Returns the rendered dimensions
// so the caller can lay out subsequent rows. Used inside the settings
// panel for the "Reset view" action — visually distinct from the
// checkbox-toggle rows so it reads as actionable, not stateful.
function drawPanelActionButton(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  hover: boolean,
): { w: number; h: number } {
  const textW = measurePixelText(text);
  const padX = 6;
  const padY = 3;
  const W = textW + padX * 2;
  const H = getFont().lineHeight + padY * 2;

  const borderColor = hover ? COLOR_ACCENT : COLOR_BORDER;
  const textColor   = hover ? COLOR_BTN_HOVER_TEXT : COLOR_BTN_OFF_TEXT;

  g.fillStyle = borderColor;
  g.fillRect(x, y, W, 1);
  g.fillRect(x, y + H - 1, W, 1);
  g.fillRect(x, y, 1, H);
  g.fillRect(x + W - 1, y, 1, H);

  const textX = x + Math.round((W - textW) / 2);
  drawPixelText(g, text, textX, y + padY, textColor);

  return { w: W, h: H };
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

// Three horizontal "slider" lines centered in a SETTINGS_ICON_SIZE × SIZE
// transparent box. Color is the only difference between off and hover
// states, so we build both up-front and swap textures on hover (cheaper
// than rebuilding the canvas mid-frame).
function buildSettingsIconTexture(color: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = SETTINGS_ICON_SIZE; c.height = SETTINGS_ICON_SIZE;
  const g = c.getContext('2d')!;
  // Three 9-px-wide, 1-px-tall lines on rows 5/8/11 — symmetric in a
  // 17-row box (5 px above, 5 px below, 2 px gaps between lines).
  g.fillStyle = color;
  const lineW = 9;
  const lineX = (SETTINGS_ICON_SIZE - lineW) / 2;  // 4
  g.fillRect(lineX, 5, lineW, 1);
  g.fillRect(lineX, 8, lineW, 1);
  g.fillRect(lineX, 11, lineW, 1);
  return nearestFilteredTexture(c);
}

// Settings modal: a title line, then one or more sections. Each section
// has a small dim header followed by a list of rows. Row kinds:
//   - toggle : checkbox glyph + label, click flips a boolean (drives a
//              ToggleId callback or a settings.* preference)
//   - action : pill-styled action button (drives an ActionId callback)
// The whole row is clickable, not just the glyph — bigger touch target
// and easier hover affordance. Section headers are non-interactive.
//
// The close-X is a sibling mesh (own texture, own hover state) so its
// state changes don't force a panel rebuild; everything else lives on
// the panel's single canvas so hover/toggle-state updates rebuild once.

export type PanelRowId = ToggleId | ActionId | 'singleTouchPan';

interface PanelRowSpec {
  kind: 'toggle' | 'action';
  id: PanelRowId;
  label: string;
  on?: boolean;  // toggle rows only
}

interface PanelSectionSpec {
  header: string;
  rows: PanelRowSpec[];
}

interface PanelRowHit {
  id: PanelRowId;
  kind: 'toggle' | 'action';
  // Hit zone in panel-local Y-down coords (origin at panel top-left).
  // Hit-test code converts to HUD Y-up using the laid-out panel position.
  y: number;
  h: number;
}

interface SettingsPanelLayout {
  tex: CanvasTexture;
  w: number;
  h: number;
  rowHits: PanelRowHit[];
}

// Layout constants for the panel's vertical rhythm. Values picked so
// section headers feel grouped with the rows below them (small gap
// after) and separated from the section above (larger gap before).
const PANEL_TITLE_TO_SECTION_GAP = 4;
const PANEL_SECTION_GAP_BEFORE   = 6;
const PANEL_SECTION_GAP_AFTER    = 2;
const PANEL_ROW_PAD_Y            = 2;  // hit-pad above/below each row

function buildSettingsPanelTexture(
  sections: PanelSectionSpec[],
  hoveredRowId: PanelRowId | null,
): SettingsPanelLayout {
  const TITLE_COLOR    = '#ffe98a';   // matches info card name color
  const SECTION_COLOR  = '#2d7ab8';   // dim cyan for section headers
  const LABEL_COLOR    = '#aee4ff';   // body text default
  const LABEL_HOVER    = '#ffffff';   // brighter on hover
  const BG_COLOR       = 'rgba(0,8,20,0.92)';
  const BORDER_COLOR   = '#3a8fe0';
  const CHECKBOX_BORDER = '#3a8fe0';

  const titleFont = FONTS.EspySans[15];
  const titleLineH = getFont(titleFont).lineHeight;
  const bodyLineH  = getFont().lineHeight;

  const title = 'Settings';
  const titleW = measurePixelText(title, titleFont);

  // Pre-compute action-button widths (we need them for the panel-width
  // max calc and to position them later). Same rendering logic as the
  // actual draw — kept in sync via drawPanelActionButton().
  const actionBtnPadX = 6;
  const actionBtnW = (label: string) => measurePixelText(label) + actionBtnPadX * 2;

  // ---- width pass ------------------------------------------------------
  let maxRowContentW = 0;
  for (const section of sections) {
    const headerW = measurePixelText(section.header);
    if (headerW > maxRowContentW) maxRowContentW = headerW;
    for (const r of section.rows) {
      let w = 0;
      if (r.kind === 'toggle') {
        w = CHECKBOX_SIZE + CHECKBOX_LABEL_GAP + measurePixelText(r.label);
      } else {
        w = actionBtnW(r.label);
      }
      if (w > maxRowContentW) maxRowContentW = w;
    }
  }
  const W = Math.max(
    SETTINGS_PANEL_PAD_X + titleW + NAME_TO_CLOSE_X_GAP + CLOSE_X_BOX_SIZE,
    SETTINGS_PANEL_PAD_X * 2 + maxRowContentW,
  );

  // ---- height pass -----------------------------------------------------
  let H = SETTINGS_PANEL_PAD_Y + titleLineH + SETTINGS_PANEL_TITLE_GAP + PANEL_TITLE_TO_SECTION_GAP;
  for (let si = 0; si < sections.length; si++) {
    if (si > 0) H += PANEL_SECTION_GAP_BEFORE;
    H += bodyLineH + PANEL_SECTION_GAP_AFTER;  // header line
    for (const r of sections[si].rows) {
      const rowH = r.kind === 'toggle'
        ? bodyLineH + PANEL_ROW_PAD_Y * 2
        : (getFont().lineHeight + 3 * 2) + PANEL_ROW_PAD_Y * 2;  // action button pad
      H += rowH;
    }
  }
  H += SETTINGS_PANEL_PAD_Y;

  // ---- draw ------------------------------------------------------------
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;

  g.fillStyle = BG_COLOR;
  g.fillRect(0, 0, W, H);
  g.fillStyle = BORDER_COLOR;
  g.fillRect(0, 0, W, 1); g.fillRect(0, H - 1, W, 1);
  g.fillRect(0, 0, 1, H); g.fillRect(W - 1, 0, 1, H);

  drawPixelText(g, title, SETTINGS_PANEL_PAD_X, SETTINGS_PANEL_PAD_Y, TITLE_COLOR, titleFont);

  let cursorY = SETTINGS_PANEL_PAD_Y + titleLineH + SETTINGS_PANEL_TITLE_GAP + PANEL_TITLE_TO_SECTION_GAP;
  const rowHits: PanelRowHit[] = [];

  for (let si = 0; si < sections.length; si++) {
    if (si > 0) cursorY += PANEL_SECTION_GAP_BEFORE;
    drawPixelText(g, sections[si].header, SETTINGS_PANEL_PAD_X, cursorY, SECTION_COLOR);
    cursorY += bodyLineH + PANEL_SECTION_GAP_AFTER;

    for (const r of sections[si].rows) {
      const isHover = r.id === hoveredRowId;

      if (r.kind === 'toggle') {
        const rowTop = cursorY;
        const rowH = bodyLineH + PANEL_ROW_PAD_Y * 2;
        const labelY = rowTop + PANEL_ROW_PAD_Y;
        const checkboxX = SETTINGS_PANEL_PAD_X;
        const checkboxY = labelY + Math.floor((bodyLineH - CHECKBOX_SIZE) / 2);

        g.fillStyle = CHECKBOX_BORDER;
        g.fillRect(checkboxX, checkboxY, CHECKBOX_SIZE, 1);
        g.fillRect(checkboxX, checkboxY + CHECKBOX_SIZE - 1, CHECKBOX_SIZE, 1);
        g.fillRect(checkboxX, checkboxY, 1, CHECKBOX_SIZE);
        g.fillRect(checkboxX + CHECKBOX_SIZE - 1, checkboxY, 1, CHECKBOX_SIZE);
        if (r.on) {
          const off = (CHECKBOX_SIZE - CHECKBOX_FILL_SIZE) / 2;
          g.fillRect(checkboxX + off, checkboxY + off, CHECKBOX_FILL_SIZE, CHECKBOX_FILL_SIZE);
        }

        const labelX = checkboxX + CHECKBOX_SIZE + CHECKBOX_LABEL_GAP;
        drawPixelText(g, r.label, labelX, labelY, isHover ? LABEL_HOVER : LABEL_COLOR);

        rowHits.push({ id: r.id, kind: 'toggle', y: rowTop, h: rowH });
        cursorY += rowH;
      } else {
        // Action button — same pill style as the old standalone bottom-
        // right buttons, drawn inline at SETTINGS_PANEL_PAD_X.
        const rowTop = cursorY;
        const btn = drawPanelActionButton(
          g,
          SETTINGS_PANEL_PAD_X,
          rowTop + PANEL_ROW_PAD_Y,
          r.label,
          isHover,
        );
        const rowH = btn.h + PANEL_ROW_PAD_Y * 2;
        rowHits.push({ id: r.id, kind: 'action', y: rowTop, h: rowH });
        cursorY += rowH;
      }
    }
  }

  return { tex: nearestFilteredTexture(c), w: W, h: H, rowHits };
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

  // Toggle state for the in-panel checkboxes. Held here (not on visible
  // mesh objects, since the standalone bottom-right buttons are gone)
  // and serialized into the panel rows on each rebuild. Defaults match
  // the old standalone-button defaults so existing behavior is
  // preserved out of the box.
  private readonly toggleState: { [K in ToggleId]: boolean } = {
    labels: true,
    drops:  true,
    spin:   false,
  };

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

  // Settings trigger (bottom-left, above scale). Two pre-built icon
  // textures swapped on hover.
  private readonly settingsIconMesh: Mesh;
  private readonly settingsIconMat: MeshBasicMaterial;
  private readonly settingsIconTexOff: CanvasTexture;
  private readonly settingsIconTexHover: CanvasTexture;
  private settingsIconBounds = { x: 0, y: 0, w: 0, h: 0 };
  private settingsIconHover = false;

  // Settings modal (visible only when user has opened it). Built lazily
  // and rebuilt whenever its state changes (toggle flipped, row hover
  // moved). Its own close-X is a sibling mesh sharing the closeXTex*
  // textures so its hover state can update without a panel rebuild.
  private readonly settingsPanelMesh: Mesh;
  private readonly settingsPanelMat: MeshBasicMaterial;
  private readonly settingsPanelCloseMesh: Mesh;
  private readonly settingsPanelCloseMat: MeshBasicMaterial;
  private settingsPanelOpen = false;
  private settingsPanelW = 0;
  private settingsPanelH = 0;
  private settingsPanelX = 0;  // panel left, in HUD coords
  private settingsPanelY = 0;  // panel bottom, in HUD coords
  // Per-row hit zones in panel-local Y-down coords (origin at panel
  // top-left, matching the texture). Translated to HUD Y-up at hit-test
  // time using the laid-out panel position.
  private settingsRowHits: PanelRowHit[] = [];
  private settingsPanelCloseBounds = { x: 0, y: 0, w: 0, h: 0 };
  private settingsPanelCloseHover = false;
  private settingsHoveredRowId: PanelRowId | null = null;

  // Public callbacks. The scene wires these to its own toggle methods.
  onToggle: (id: ToggleId, on: boolean) => void = () => {};
  onAction: (id: ActionId) => void = () => {};
  onDeselect: () => void = () => {};
  // Fires when a setting changes via the modal — scene reads getSettings()
  // each gesture so this is informational, but having a hook lets the
  // scene react immediately if a setting requires recomputed state.
  onSettingsChanged: () => void = () => {};

  constructor() {
    // ---- title -----------------------------------------------------------
    const title = buildTitleTexture();
    this.titleW = title.w;
    this.titleH = title.h;
    const titleMat = new MeshBasicMaterial({ map: title.tex, transparent: true, depthTest: false, depthWrite: false });
    this.titleMesh = new Mesh(new PlaneGeometry(title.w, title.h), titleMat);
    this.titleMesh.renderOrder = 100;
    this.scene.add(this.titleMesh);

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

    // ---- settings icon (bottom-left trigger) -----------------------------
    this.settingsIconTexOff   = buildSettingsIconTexture(COLOR_CLOSE_X);
    this.settingsIconTexHover = buildSettingsIconTexture(COLOR_CLOSE_X_HOVER);
    this.settingsIconMat = new MeshBasicMaterial({ map: this.settingsIconTexOff, transparent: true, depthTest: false, depthWrite: false });
    this.settingsIconMesh = new Mesh(new PlaneGeometry(SETTINGS_ICON_SIZE, SETTINGS_ICON_SIZE), this.settingsIconMat);
    this.settingsIconMesh.renderOrder = 100;
    this.scene.add(this.settingsIconMesh);

    // ---- settings panel (modal) ------------------------------------------
    // Hidden by default; texture lazily built on first open.
    this.settingsPanelMat = new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
    this.settingsPanelMesh = new Mesh(new PlaneGeometry(1, 1), this.settingsPanelMat);
    this.settingsPanelMesh.renderOrder = 100;
    this.settingsPanelMesh.visible = false;
    this.scene.add(this.settingsPanelMesh);

    this.settingsPanelCloseMat = new MeshBasicMaterial({ map: this.closeXTexOff, transparent: true, depthTest: false, depthWrite: false });
    this.settingsPanelCloseMesh = new Mesh(new PlaneGeometry(CLOSE_X_BOX_SIZE, CLOSE_X_BOX_SIZE), this.settingsPanelCloseMat);
    this.settingsPanelCloseMesh.renderOrder = 101;  // above the panel
    this.settingsPanelCloseMesh.visible = false;
    this.scene.add(this.settingsPanelCloseMesh);
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
    // Settings icon sits above the scale; reposition it now that
    // scaleLabelH has a real value (it was 0 before the first emit).
    this.layoutSettingsIcon();
    if (this.settingsPanelOpen) this.layoutSettingsPanel();
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
  // (e.g. keyboard shortcut) or when reset re-arms autospin off, etc. If
  // the settings panel is currently open, rebuild it so the checkbox
  // glyph reflects the new state immediately.
  setToggleState(id: ToggleId, on: boolean): void {
    if (this.toggleState[id] === on) return;
    this.toggleState[id] = on;
    if (this.settingsPanelOpen) this.rebuildSettingsPanel();
  }

  // Returns true if the click hit any HUD interactive element (settings
  // trigger, info-card close X, or anything in the settings panel) and
  // the corresponding action was fired.
  handleClick(bufX: number, bufY: number): boolean {
    if (this.isOverCloseX(bufX, bufY)) {
      this.onDeselect();
      return true;
    }
    if (this.isOverSettingsIcon(bufX, bufY)) {
      // Click trigger when panel is already open → close. Matches the
      // common popover toggle pattern.
      if (this.settingsPanelOpen) this.closeSettingsPanel();
      else this.openSettingsPanel();
      return true;
    }
    if (this.settingsPanelOpen) {
      if (this.isOverSettingsPanelClose(bufX, bufY)) {
        this.closeSettingsPanel();
        return true;
      }
      const hitRow = this.findPanelRow(bufX, bufY);
      if (hitRow) {
        this.dispatchPanelRow(hitRow);
        return true;
      }
      // Tap inside the panel rect but not on an interactive row — absorb
      // so it doesn't fall through to star picking behind the panel.
      if (this.isOverSettingsPanel(bufX, bufY)) return true;
    }
    return false;
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
    const onSettingsIcon = this.isOverSettingsIcon(bufX, bufY);
    if (onSettingsIcon !== this.settingsIconHover) {
      this.settingsIconHover = onSettingsIcon;
      this.settingsIconMat.map = onSettingsIcon ? this.settingsIconTexHover : this.settingsIconTexOff;
      this.settingsIconMat.needsUpdate = true;
    }
    let onSettingsPanelClose = false;
    let hoveredRow: PanelRowHit | null = null;
    if (this.settingsPanelOpen) {
      onSettingsPanelClose = this.isOverSettingsPanelClose(bufX, bufY);
      if (onSettingsPanelClose !== this.settingsPanelCloseHover) {
        this.settingsPanelCloseHover = onSettingsPanelClose;
        this.settingsPanelCloseMat.map = onSettingsPanelClose ? this.closeXTexHover : this.closeXTexOff;
        this.settingsPanelCloseMat.needsUpdate = true;
      }
      hoveredRow = this.findPanelRow(bufX, bufY);
      const newId = hoveredRow ? hoveredRow.id : null;
      if (newId !== this.settingsHoveredRowId) {
        this.settingsHoveredRowId = newId;
        // Row hover changes label/button colors → rebuild the panel.
        this.rebuildSettingsPanel();
      }
    }
    return onCloseX || onSettingsIcon || onSettingsPanelClose || hoveredRow !== null;
  }

  private dispatchPanelRow(row: PanelRowHit): void {
    if (row.kind === 'action') {
      this.onAction(row.id as ActionId);
      return;
    }
    if (row.id === 'singleTouchPan') {
      const next = getSettings().singleTouchAction === 'pan' ? 'orbit' : 'pan';
      setSetting('singleTouchAction', next);
      this.onSettingsChanged();
      this.rebuildSettingsPanel();
      return;
    }
    // Toggle row backed by a ToggleId — flip internal state, fire the
    // callback, rebuild so the checkbox glyph updates.
    const id = row.id as ToggleId;
    this.toggleState[id] = !this.toggleState[id];
    this.onToggle(id, this.toggleState[id]);
    this.rebuildSettingsPanel();
  }

  // Hit-test panel rows. Row geometry lives in panel-local Y-down coords
  // (texture origin at top-left); convert each to HUD Y-up using the
  // current panel position.
  private findPanelRow(bufX: number, bufY: number): PanelRowHit | null {
    if (!this.settingsPanelOpen) return null;
    if (bufX < this.settingsPanelX || bufX >= this.settingsPanelX + this.settingsPanelW) return null;
    const panelTop = this.settingsPanelY + this.settingsPanelH;
    for (const r of this.settingsRowHits) {
      const rowTopHud    = panelTop - r.y;
      const rowBottomHud = rowTopHud - r.h;
      if (bufY >= rowBottomHud && bufY < rowTopHud) return r;
    }
    return null;
  }

  // -- layout ------------------------------------------------------------

  private layout(): void {
    // Title at top-left.
    this.titleMesh.position.set(PADDING + this.titleW / 2, this.bufferH - PADDING - this.titleH / 2, 0);

    this.layoutScale();
    this.layoutInfoCard();
    this.layoutSettingsIcon();
    if (this.settingsPanelOpen) this.layoutSettingsPanel();
  }

  private layoutSettingsIcon(): void {
    // Bottom-right, where the standalone toggle/action buttons used to
    // sit. Single trigger now — its panel exposes everything they did,
    // plus the settings rows.
    const iconCenterX = this.bufferW - PADDING - SETTINGS_ICON_SIZE / 2;
    const iconCenterY = PADDING + SETTINGS_ICON_SIZE / 2;
    const iconLeft   = this.bufferW - PADDING - SETTINGS_ICON_SIZE;
    const iconBottom = PADDING;
    this.settingsIconMesh.position.set(iconCenterX, iconCenterY, 0);
    this.settingsIconBounds = {
      x: iconLeft - SETTINGS_ICON_HIT_PAD,
      y: iconBottom - SETTINGS_ICON_HIT_PAD,
      w: SETTINGS_ICON_SIZE + 2 * SETTINGS_ICON_HIT_PAD,
      h: SETTINGS_ICON_SIZE + 2 * SETTINGS_ICON_HIT_PAD,
    };
  }

  private layoutSettingsPanel(): void {
    if (!this.settingsPanelOpen) return;
    // Panel opens upward and to the LEFT of the bottom-right trigger so
    // it never extends off-screen on the right. Right edge aligns with
    // the trigger's right edge (window_right - PADDING) so the column
    // reads as a connected popover; bottom edge clears the trigger's top
    // by SETTINGS_PANEL_TRIGGER_GAP.
    const iconTopY = this.settingsIconBounds.y + this.settingsIconBounds.h - SETTINGS_ICON_HIT_PAD;
    const panelBottomY = iconTopY + SETTINGS_PANEL_TRIGGER_GAP;
    const panelRightX = this.bufferW - PADDING;
    const panelLeftX = panelRightX - this.settingsPanelW;
    this.settingsPanelX = panelLeftX;
    this.settingsPanelY = panelBottomY;
    this.settingsPanelMesh.position.set(
      panelLeftX + this.settingsPanelW / 2,
      panelBottomY + this.settingsPanelH / 2,
      0,
    );
    const panelTop = panelBottomY + this.settingsPanelH;
    this.settingsPanelCloseMesh.position.set(
      panelRightX - CLOSE_X_BOX_SIZE / 2,
      panelTop    - CLOSE_X_BOX_SIZE / 2,
      0,
    );
    this.settingsPanelCloseBounds = {
      x: panelRightX - CLOSE_X_BOX_SIZE - CLOSE_X_HIT_PAD,
      y: panelTop    - CLOSE_X_BOX_SIZE - CLOSE_X_HIT_PAD,
      w: CLOSE_X_BOX_SIZE + 2 * CLOSE_X_HIT_PAD,
      h: CLOSE_X_BOX_SIZE + 2 * CLOSE_X_HIT_PAD,
    };
  }

  private openSettingsPanel(): void {
    if (this.settingsPanelOpen) return;
    this.settingsPanelOpen = true;
    this.rebuildSettingsPanel();
    this.settingsPanelMesh.visible = true;
    this.settingsPanelCloseMesh.visible = true;
    this.layoutSettingsPanel();
  }

  private closeSettingsPanel(): void {
    if (!this.settingsPanelOpen) return;
    this.settingsPanelOpen = false;
    this.settingsPanelMesh.visible = false;
    this.settingsPanelCloseMesh.visible = false;
    if (this.settingsPanelCloseHover) {
      this.settingsPanelCloseHover = false;
      this.settingsPanelCloseMat.map = this.closeXTexOff;
      this.settingsPanelCloseMat.needsUpdate = true;
    }
    this.settingsHoveredRowId = null;
  }

  private rebuildSettingsPanel(): void {
    const s = getSettings();
    const sections: PanelSectionSpec[] = [
      {
        header: 'Display',
        rows: [
          { kind: 'toggle', id: 'labels', label: 'Show star labels',         on: this.toggleState.labels },
          { kind: 'toggle', id: 'drops',  label: 'Show distance droplines',  on: this.toggleState.drops  },
          { kind: 'toggle', id: 'spin',   label: 'Auto-rotate view',         on: this.toggleState.spin   },
          { kind: 'action', id: 'reset',  label: 'Reset view' },
        ],
      },
      {
        header: 'Touch input',
        rows: [
          { kind: 'toggle', id: 'singleTouchPan', label: 'Pan with single touch', on: s.singleTouchAction === 'pan' },
        ],
      },
    ];

    if (this.settingsPanelMat.map) this.settingsPanelMat.map.dispose();
    const layout = buildSettingsPanelTexture(sections, this.settingsHoveredRowId);
    this.settingsPanelMat.map = layout.tex;
    this.settingsPanelMat.needsUpdate = true;
    this.settingsPanelW = layout.w;
    this.settingsPanelH = layout.h;
    this.settingsRowHits = layout.rowHits;
    this.settingsPanelMesh.geometry.dispose();
    this.settingsPanelMesh.geometry = new PlaneGeometry(layout.w, layout.h);
    this.layoutSettingsPanel();
  }

  private isOverSettingsIcon(bufX: number, bufY: number): boolean {
    const b = this.settingsIconBounds;
    return bufX >= b.x && bufX < b.x + b.w && bufY >= b.y && bufY < b.y + b.h;
  }

  private isOverSettingsPanelClose(bufX: number, bufY: number): boolean {
    if (!this.settingsPanelOpen) return false;
    const b = this.settingsPanelCloseBounds;
    return bufX >= b.x && bufX < b.x + b.w && bufY >= b.y && bufY < b.y + b.h;
  }

  // Click is anywhere inside the panel rectangle (used to absorb taps so
  // they don't fall through to star picking).
  private isOverSettingsPanel(bufX: number, bufY: number): boolean {
    if (!this.settingsPanelOpen) return false;
    return (
      bufX >= this.settingsPanelX && bufX < this.settingsPanelX + this.settingsPanelW &&
      bufY >= this.settingsPanelY && bufY < this.settingsPanelY + this.settingsPanelH
    );
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
