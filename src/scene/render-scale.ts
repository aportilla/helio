// Render-scale observer: picks an integer N (1, 2, 3, or 4) such that one
// "env pixel" (the unit our scene and HUD are authored in) covers N physical
// screen pixels — chosen to land closest to a 72-DPI visual size given the
// browser's reported devicePixelRatio.
//
// Math: CSS spec defines 1 CSS px ≈ 1/96", so screen physical resolution is
// 96 × dpr DPI. To make an env-pixel of N physical pixels equal 1/72":
//   N = (4/3) × dpr.
// Round to nearest integer, clamp to {1,2,3,4}. Boundaries:
//   dpr < 1.125 → 1
//   dpr < 1.875 → 2
//   dpr < 2.625 → 3
//   else        → 4
// Retina (dpr=2) → 3, matching today's hardcoded behavior.
//
// DPR can change mid-session — browser zoom (Chrome/Firefox), window dragged
// between monitors of different DPI, or OS scale changes. We watch all three
// triggers; the callback fires only when N actually crosses a boundary, so
// minor jitter (e.g. 2 → 2.5 from a Chrome zoom step) is a no-op since both
// resolve to N=3.

import type { ResolutionPreference } from '../settings';

export type RenderScale = 1 | 2 | 3 | 4;

export function computeRenderScale(dpr: number): RenderScale {
  const safe = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const raw = Math.round((4 / 3) * safe);
  if (raw <= 1) return 1;
  if (raw === 2) return 2;
  if (raw === 3) return 3;
  return 4;
}

// Apply the user's resolution preference as a bias on the auto-computed
// integer N. Higher N = chunkier (fewer fragments), lower N = sharper
// (more fragments). Clamped to {1..4}; when the clamp swallows the bias,
// the effective scale equals auto and the corresponding radio option is
// disabled in the UI (caller's job to surface that).
//
//   low    → auto + 1
//   medium → auto
//   high   → auto - 1
export function effectiveScale(auto: RenderScale, pref: ResolutionPreference): RenderScale {
  const bias = pref === 'low' ? 1 : pref === 'high' ? -1 : 0;
  const next = auto + bias;
  if (next <= 1) return 1;
  if (next === 2) return 2;
  if (next === 3) return 3;
  return 4;
}

type Listener = (scale: RenderScale) => void;

export class RenderScaleObserver {
  private _scale: RenderScale;
  private listeners = new Set<Listener>();
  private mql: MediaQueryList | null = null;
  private mqlHandler: (() => void) | null = null;
  private readonly hasWindow: boolean;

  constructor() {
    this.hasWindow = typeof window !== 'undefined';
    this._scale = this.hasWindow ? computeRenderScale(window.devicePixelRatio) : 1;
    if (this.hasWindow) {
      window.addEventListener('resize', this.reevaluate);
      this.armMatchMedia();
    }
  }

  get scale(): RenderScale {
    return this._scale;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    if (!this.hasWindow) return;
    window.removeEventListener('resize', this.reevaluate);
    this.disarmMatchMedia();
    this.listeners.clear();
  }

  // A matchMedia resolution query only fires `change` once — when the current
  // dpr no longer matches the value baked into the query string. After each
  // fire we tear down and re-arm against the new dpr so future changes still
  // get caught.
  private armMatchMedia(): void {
    if (!this.hasWindow || typeof window.matchMedia !== 'function') return;
    const dpr = window.devicePixelRatio;
    this.mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    this.mqlHandler = () => {
      this.reevaluate();
      this.disarmMatchMedia();
      this.armMatchMedia();
    };
    this.mql.addEventListener('change', this.mqlHandler);
  }

  private disarmMatchMedia(): void {
    if (this.mql && this.mqlHandler) {
      this.mql.removeEventListener('change', this.mqlHandler);
    }
    this.mql = null;
    this.mqlHandler = null;
  }

  private reevaluate = (): void => {
    if (!this.hasWindow) return;
    const next = computeRenderScale(window.devicePixelRatio);
    if (next === this._scale) return;
    this._scale = next;
    for (const cb of this.listeners) cb(next);
  };
}
