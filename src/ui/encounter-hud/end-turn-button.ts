// EndTurnButton — the player's fleet-scoped "end my phase" affordance, sitting in the CENTER of the
// encounter bar (EB) band, straddling the divider the two fleets face across. It is the click-twin of
// the `R` key's End Round: pressing it forfeits the controlled side's remaining initiative and hands the
// phase over (§3.8.3). Shown only during the controlled side's phase (the controller toggles it), so the
// opponent's auto-driven phase never offers it.
//
// A separate Widget from the bar (not painted into the bar's once-per-settle canvas) for two reasons:
// it needs its own HUD-space hit bounds for the click, and — when it becomes the suggested CTA — its
// border BLINKS gold, which wants a per-frame texture swap the bar's settle-paced repaint can't give.
// So it follows the IconButton idiom: a handful of pre-built textures resident in GPU memory, swapped by
// a cheap `material.map` poke (no per-frame canvas alloc). The controller drives the blink from its tick.
//
// The CTA emphasis (gold blink) is raised by the controller when NONE of the player's living ships has an
// affordable, target-having action left — i.e. spending more initiative would accomplish nothing, so
// ending the phase is the recommended move.

import { CanvasTexture } from 'three';
import { Widget, paintToTexture } from '../widget';
import { colors, fonts } from '../theme';
import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';

const LABEL = 'END TURN';
const PAD_X = 11; // horizontal text inset → the button's chunky width
const HEIGHT = 24; // band is 34 tall; this leaves a ~5px margin top+bottom when centered in it
// Pulsing-gold CTA frame: the bright accent (the locked-target / star-name yellow) alternating with a
// muted gold so the border reads as a deliberate gold BLINK, not a flat highlight. Text stays bright in
// both frames so the label never dims out of legibility.
const GOLD_BRIGHT = colors.starName; // '#ffe98a'
const GOLD_DIM = '#8a7320';

// The box is a right-leaning parallelogram — horizontal top/bottom, slanted sides — matching the pips'
// 1-in-2 lean so the bar reads as one sheared family. WIDTH is the interior; BTN_SHEAR is the top row's
// rightward offset, so the drawn texture is WIDTH + BTN_SHEAR wide.
const SHEAR_SLOPE = 0.5;
const WIDTH = measurePixelText(LABEL, fonts.body) + PAD_X * 2;
const BTN_SHEAR = Math.round((HEIGHT - 1) * SHEAR_SLOPE);
const TOTAL_W = WIDTH + BTN_SHEAR;

// Half the button's footprint plus a gap — the encounter bar clears this much space on each side of the
// center divider so its initiative pips never march under the button (index.ts reads it).
export const END_TURN_RESERVE = Math.round(TOTAL_W / 2) + 8;

type Variant = 'normal' | 'hover' | 'ctaBright' | 'ctaDim';

function buildTexture(variant: Variant): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = TOTAL_W;
  c.height = HEIGHT;
  const g = c.getContext('2d')!;
  const border =
    variant === 'ctaBright' ? GOLD_BRIGHT
    : variant === 'ctaDim' ? GOLD_DIM
    : variant === 'hover' ? colors.borderAccent
    : colors.borderDim;
  const text =
    variant === 'ctaBright' || variant === 'ctaDim' ? GOLD_BRIGHT
    : variant === 'hover' ? colors.glyphOnHover
    : colors.titleBright;
  // Row by row: fill the interior [off, off+WIDTH), then lay the 1-px frame — a full top & bottom edge,
  // and a single left/right pixel per interior row — so the slanted sides stair-step crisply.
  for (let y = 0; y < HEIGHT; y++) {
    const off = Math.round((HEIGHT - 1 - y) * SHEAR_SLOPE);
    g.fillStyle = colors.surface;
    g.fillRect(off, y, WIDTH, 1);
    g.fillStyle = border;
    if (y === 0 || y === HEIGHT - 1) {
      g.fillRect(off, y, WIDTH, 1);
    } else {
      g.fillRect(off, y, 1, 1);
      g.fillRect(off + WIDTH - 1, y, 1, 1);
    }
  }
  const tw = measurePixelText(LABEL, fonts.body);
  const ty = Math.round((HEIGHT - getFont(fonts.body).lineHeight) / 2);
  drawPixelText(g, LABEL, Math.round((TOTAL_W - tw) / 2), ty, text, fonts.body);
  return paintToTexture(c);
}

export class EndTurnButton extends Widget {
  // All four states resident; the swap is a uniform update (the IconButton pattern). Owned here, so this
  // widget disposes them itself (Widget.dispose only frees the standard owned-texture path, which is null).
  private readonly textures: Record<Variant, CanvasTexture> = {
    normal: buildTexture('normal'),
    hover: buildTexture('hover'),
    ctaBright: buildTexture('ctaBright'),
    ctaDim: buildTexture('ctaDim'),
  };
  private hovered = false;
  private shown = false;
  private emphasized = false;
  private blinkBright = false;
  private applied: Variant | '' = ''; // last-swapped variant, so a steady frame re-pokes nothing

  // Render above the bar (100) so the button sits ON the band, like the body card over the back button.
  constructor() {
    super(110);
    this.setSize(TOTAL_W, HEIGHT);
    this.material.map = this.textures.normal;
  }

  // Hover is set by the pointer-move path; it only matters in the resting (non-CTA) state — the gold blink
  // owns the border while the button is the CTA.
  setHover(h: boolean): void {
    if (this.hovered === h) return;
    this.hovered = h;
    this.apply();
  }

  // Per-frame drive from the controller's tick: visibility + CTA emphasis + the blink clock (`now`). Only
  // the variant CHANGE pokes the GPU; a steady frame is a no-op. When hidden, hover is dropped so the next
  // appearance starts un-hovered.
  update(now: number, visible: boolean, emphasized: boolean): void {
    this.setVisible(visible);
    if (!visible) {
      this.shown = false;
      this.hovered = false;
      return;
    }
    this.shown = true;
    this.emphasized = emphasized;
    // ~0.9s pulse: bright for one ~450ms window, muted for the next. Derived from the frame clock, not a
    // stored timer, so it free-runs and survives repaints. `now` is the scene's tick timestamp (ms).
    this.blinkBright = emphasized ? Math.floor(now / 450) % 2 === 0 : false;
    this.apply();
  }

  private apply(): void {
    if (!this.shown) return;
    const variant: Variant = this.emphasized
      ? (this.blinkBright ? 'ctaBright' : 'ctaDim')
      : (this.hovered ? 'hover' : 'normal');
    if (variant === this.applied) return;
    this.applied = variant;
    this.material.map = this.textures[variant];
    this.material.needsUpdate = true;
  }

  override dispose(): void {
    for (const t of Object.values(this.textures)) t.dispose();
    super.dispose();
  }
}
