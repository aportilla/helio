// CombatTracers — the transient action-event animation layer (§14, EV). For the duration of an action's
// playback window (driven by EncounterController), it paints the action's `EncounterEvent`s as a BEAT made
// of BOLTS: per `damage` event the controller fans the firing weapon's `count` (its barrage size, §14.4)
// into that many bolts, staggered in launch time + offset in position; each bolt travels from the source
// combatant's slot to the target's, then an impact flash + (on the last bolt of a target) a rising damage
// number; a `down` on that target turns the killing bolt's flash into a destruction burst.
//
// It is a SIBLING of the static ship-gauges overlay in the SAME canvas idiom — a content-buffer
// CanvasTexture redrawn each frame and re-uploaded via `needsUpdate` (the IconButton manage-your-own-
// texture path, NOT a per-frame setTexture alloc) — so the bolts, flashes, and drawPixelText numbers
// compose into one surface. SystemScene paints the gauges in an EARLIER content-scissor pass, so these
// tracers (the encounter mode's own ortho pass) read OVER the HP / energy bars for free. This is not the
// Appendix A `tracers` LineSegments row (the DIAGRAM-scene geometry idiom, whose uViewport snap keys off
// the diagram camera, not this overlay scene). Positions re-resolve through
// the same slotCenterFor accessor each frame, so a body target (E5) needs no new path. Render-only:
// nothing here reaches the integer-milli reducer (§6.4); per-weapon look + timing are DATA (vfxForCommand,
// §14.5), and the layer is cleared between beats / on exit.

import { type CanvasTexture } from 'three';
import { paintToTexture, Widget } from '../ui/widget';
import { drawPixelText, measurePixelText, getFont } from '../data/pixel-font';
import { fonts } from '../ui/theme';
import type { ActionCommand } from '../actions/types';
import type { SlotCenter } from './actions/system-action-menu';

// Per-weapon beat visuals, resolved render-side from the firing command (§14.5). Colour is the grant's own
// accent (the weapon's identity, already declared as data); timing keys off the grant key with a default,
// so a new weapon paces its salvo differently without touching this layer.
interface BeatVfx {
  readonly color: string;
  readonly travelMs: number; // a single bolt's flight time
  readonly impactMs: number; // its flash + number-pop time
  readonly salvoGapMs: number; // stagger between successive bolts of one barrage
}

const DEFAULT_TIMING = { travelMs: 240, impactMs: 170, salvoGapMs: 90 };
const TIMING_BY_KEY: Record<string, typeof DEFAULT_TIMING> = {
  laser: { travelMs: 210, impactMs: 160, salvoGapMs: 80 },
};
const FALLBACK_COLOR = '#ffffff';

// The beat visuals for the command that fired — colour from the grant, timing per grant key. Falls back to
// a neutral default when no command resolves (defensive; a real attack always carries one).
export function vfxForCommand(command: ActionCommand | undefined): BeatVfx {
  if (!command) return { color: FALLBACK_COLOR, ...DEFAULT_TIMING };
  return { color: command.grant.color, ...(TIMING_BY_KEY[command.grant.key] ?? DEFAULT_TIMING) };
}

// One fanned projectile of a beat — the layer's atom. The controller expands an action's damage events ×
// barrage count into these, staggered in launch time + offset in source/target position (§14.6 steps 5–6).
// Times are absolute ms within the window; the layer renders every bolt at one shared elapsed time.
export interface Bolt {
  readonly sourceId: string;
  readonly targetId: string;
  readonly color: string;
  readonly startMs: number;
  readonly travelMs: number;
  readonly impactMs: number;
  readonly srcDx: number; // launch-point offset at the source (buffer px)
  readonly srcDy: number;
  readonly dstDx: number; // impact-point offset at the target (buffer px)
  readonly dstDy: number;
  readonly popMilli: number | null; // the target's TOTAL damage, popped once on its last bolt; else null
  readonly kill: boolean; // draw a destruction burst (a `down` hit this target on this bolt)
}

// All buffer px. Render-only sizing — never reaches the reducer.
const CORE = 3; // bolt-head square side
const TRAIL_LEN = 16; // px the comet trail extends behind the head
const TRAIL_STEP_PX = 2; // px between trail samples
const FLASH_MAX = 4; // impact-flash half-side at first contact (shrinks to 0)
const KILL_MAX = 9; // destruction-burst half-side (a downed target)
const POP_RISE = 12; // px the damage number floats up over the impact phase
const HEAD = '#ffffff'; // bolt head + ordinary impact flash (hot white core)
const NUMBER_COLOR = '#fff2b0';
const RENDER_ORDER = 120; // above the bar/end-turn in this scene; the ship gauges read over via pass order

export class CombatTracers extends Widget {
  private readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private tex: CanvasTexture | null = null;
  private contentW = 1;
  private bufH = 1;
  private bolts: readonly Bolt[] = [];

  constructor(private readonly slotCenterFor: (id: string) => SlotCenter | null) {
    super(RENDER_ORDER);
    this.g = this.canvas.getContext('2d')!;
  }

  // (Re)size the canvas + its persistent texture to the content buffer (the diagram's slot-anchor space),
  // place the quad at the origin, start hidden. Mirrors the ship-gauges overlay's content-buffer sizing.
  resize(contentBufferW: number, bufferH: number): void {
    this.contentW = Math.max(1, contentBufferW);
    this.bufH = Math.max(1, bufferH);
    this.canvas.width = this.contentW;
    this.canvas.height = this.bufH;
    if (this.tex) this.tex.dispose();
    this.tex = paintToTexture(this.canvas);
    this.material.map = this.tex;
    this.material.needsUpdate = true;
    this.setSize(this.contentW, this.bufH);
    this.placeAt(0, 0);
    this.setVisible(false);
  }

  // Arm the layer with the bolts of the action just committed (the controller fans the events × count).
  setBolts(bolts: readonly Bolt[]): void {
    this.bolts = bolts;
  }

  // Paint one frame at the window's elapsed ms: each bolt draws only within its own [startMs, startMs +
  // travelMs + impactMs] slice, so a staggered barrage reads as a stutter of bolts. Positions re-resolve
  // through slotCenterFor each call so the beat tracks the live layout.
  render(elapsedMs: number): void {
    if (!this.tex) return;
    this.g.clearRect(0, 0, this.contentW, this.bufH);
    for (const bolt of this.bolts) this.drawBolt(bolt, elapsedMs);
    this.tex.needsUpdate = true;
    this.setVisible(true);
  }

  // Drop the current bolts and hide — called at the end of a window and on encounter exit.
  clearBolts(): void {
    this.bolts = [];
    if (this.tex) {
      this.g.clearRect(0, 0, this.contentW, this.bufH);
      this.tex.needsUpdate = true;
    }
    this.setVisible(false);
  }

  private drawBolt(bolt: Bolt, elapsedMs: number): void {
    const local = elapsedMs - bolt.startMs;
    if (local < 0) return; // not launched yet
    const src = this.slotCenterFor(bolt.sourceId);
    const dst = this.slotCenterFor(bolt.targetId);
    if (!src || !dst) return;
    const g = this.g;
    // Buffer coords are Y-up (origin bottom-left); the canvas is Y-down — flip Y once here.
    const cy = (yUp: number): number => this.bufH - yUp;
    const ax = src.cx + bolt.srcDx;
    const ay = src.cy + bolt.srcDy;
    const bx = dst.cx + bolt.dstDx;
    const by = dst.cy + bolt.dstDy;
    if (local < bolt.travelMs) {
      const t = local / bolt.travelMs; // 0..1 along source→target
      const hxF = ax + (bx - ax) * t;
      const hyF = ay + (by - ay) * t;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      // Comet trail: 1-px dots stepping back from the head along the path, fading toward the tail.
      for (let d = TRAIL_LEN; d >= TRAIL_STEP_PX; d -= TRAIL_STEP_PX) {
        g.globalAlpha = Math.max(0.12, 0.5 * (1 - d / TRAIL_LEN));
        g.fillStyle = bolt.color;
        g.fillRect(Math.round(hxF - ux * d), Math.round(cy(hyF - uy * d)), 1, 1);
      }
      // Bright head core.
      g.globalAlpha = 1;
      g.fillStyle = HEAD;
      g.fillRect(Math.round(hxF) - (CORE >> 1), Math.round(cy(hyF)) - (CORE >> 1), CORE, CORE);
    } else if (local < bolt.travelMs + bolt.impactMs) {
      const f = (local - bolt.travelMs) / bolt.impactMs; // 0..1 over the impact phase
      const tx = Math.round(bx);
      const ty = Math.round(cy(by));
      // Impact flash (or a larger destruction burst in the weapon colour when this bolt downs the target).
      const fs = Math.max(1, Math.round((bolt.kill ? KILL_MAX : FLASH_MAX) * (1 - f)));
      g.globalAlpha = Math.max(0, 1 - f);
      g.fillStyle = bolt.kill ? bolt.color : HEAD;
      g.fillRect(tx - fs, ty - fs, fs * 2, fs * 2);
      g.globalAlpha = 1;
      // Rising damage number — the target's total, popped once (only the last bolt carries it).
      if (bolt.popMilli !== null) {
        const label = String(Math.max(1, Math.round(bolt.popMilli / 1000)));
        const lh = getFont(fonts.body).lineHeight;
        const nx = Math.round(dst.cx - measurePixelText(label, fonts.body) / 2);
        const ny = Math.round(ty - lh / 2 - f * POP_RISE);
        drawPixelText(g, label, nx, ny, NUMBER_COLOR, fonts.body);
      }
    }
  }

  override dispose(): void {
    if (this.tex) {
      this.tex.dispose();
      this.tex = null;
    }
    super.dispose();
  }
}
