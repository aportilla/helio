// Persisted user preferences. Single namespaced localStorage key, JSON
// blob with a version field so we can migrate the shape later without
// blowing up old saves. Reads are robust against localStorage being
// disabled (private browsing, quota errors) and against corrupt or
// older-version blobs — fall back to defaults rather than crash.
//
// The module exposes a tiny pull-on-read API: callers `getSettings()`
// each frame (or each gesture) and read whichever fields they care
// about; mutations go through `setSetting()` which updates the
// in-memory value and persists. No reactive store needed for this
// scale of preferences.

export type SingleTouchAction = 'orbit' | 'pan';
// Resolution preference: a bias applied to the auto-computed render scale
// (the integer N from RenderScaleObserver targeting 72 DPI). 'medium'
// keeps the auto value, 'low' nudges N up by 1 (chunkier, fewer fragments),
// 'high' nudges N down by 1 (sharper, more fragments). Clamped to {1..4};
// when the clamp swallows the bias the option is disabled in the UI.
export type ResolutionPreference = 'low' | 'medium' | 'high';

export interface Settings {
  version: 2;
  // Behavior of a single-finger TOUCH drag (mouse drags always orbit,
  // unaffected by this setting). When 'orbit', single touch yaws/pitches
  // the camera (the original behavior); when 'pan', single touch shifts
  // view.target along the camera's screen-aligned right/up axes — and
  // the two-finger "pan" gesture instead drives orbit. Pinch-to-zoom is
  // unchanged either way.
  singleTouchAction: SingleTouchAction;
  // Display toggles surfaced in the settings panel. Persisted so a user
  // who turns droplines off (the more common case after first visit)
  // doesn't have to re-toggle on every reload. The transient `spin`
  // toggle is intentionally NOT here — it's a session-scoped fidget,
  // not a preference that should survive a refresh.
  showLabels: boolean;
  showDroplines: boolean;
  resolutionPreference: ResolutionPreference;
}

const STORAGE_KEY = 'starmap.settings';
const DEFAULTS: Settings = {
  version: 2,
  singleTouchAction: 'orbit',
  showLabels: true,
  showDroplines: false,
  resolutionPreference: 'medium',
};

function readFromStorage(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Validate each field individually and merge over defaults so adding
    // new fields later doesn't break old saves. Reject any value that
    // isn't one of the known enum literals; for booleans, fall back to
    // the default unless the stored value is exactly `true` or `false`.
    const pref = parsed.resolutionPreference;
    return {
      ...DEFAULTS,
      singleTouchAction: parsed.singleTouchAction === 'pan' ? 'pan' : 'orbit',
      showLabels: typeof parsed.showLabels === 'boolean' ? parsed.showLabels : DEFAULTS.showLabels,
      showDroplines: typeof parsed.showDroplines === 'boolean' ? parsed.showDroplines : DEFAULTS.showDroplines,
      resolutionPreference: pref === 'low' || pref === 'high' ? pref : 'medium',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeToStorage(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorage disabled or full — settings still apply for this
    // session, they just won't persist. No way to recover; swallow.
  }
}

let current: Settings = readFromStorage();

export function getSettings(): Readonly<Settings> {
  return current;
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  writeToStorage(current);
}
