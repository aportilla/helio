// Persisted user preferences — a JSON blob under the `helio.settings` key (the
// keyspace + safe I/O live in ./storage). Settings are GLOBAL, not per-save-slot.
// Reads validate-and-merge over defaults: an additive field needs no version bump,
// a corrupt/disabled/absent blob falls back to defaults rather than crash, and the
// `version` field is reserved for a future breaking migration (see ./storage).
//
// The module exposes a tiny pull-on-read API: callers `getSettings()` each frame
// (or each gesture) and read whichever fields they care about; mutations go
// through `setSetting()` which updates the in-memory value and persists. No
// reactive store needed for this scale of preferences.

import { slotKey, readRaw, writeRaw, removeRaw } from './storage';

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

const STORAGE_KEY = slotKey('settings');
// Pre-Helio-rename key. Read once and migrated forward (then dropped) so a
// returning user keeps their prefs across the namespace change.
const LEGACY_KEY = 'starmap.settings';
const DEFAULTS: Settings = {
  version: 2,
  singleTouchAction: 'orbit',
  showLabels: true,
  showDroplines: false,
  resolutionPreference: 'medium',
};

// Validate each field individually and merge over defaults so adding new fields
// later doesn't break old saves. Reject any value that isn't a known enum literal;
// for booleans, fall back to the default unless the stored value is exactly
// true/false. A null or corrupt blob yields fresh defaults.
function parse(raw: string | null): Settings {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
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

function readFromStorage(): Settings {
  const raw = readRaw(STORAGE_KEY);
  if (raw !== null) return parse(raw);
  // First run after the Helio rename: migrate the old `starmap.settings` blob
  // forward, then drop it, so prefs survive the namespace change.
  const legacy = readRaw(LEGACY_KEY);
  if (legacy === null) return { ...DEFAULTS };
  const migrated = parse(legacy);
  writeRaw(STORAGE_KEY, JSON.stringify(migrated));
  removeRaw(LEGACY_KEY);
  return migrated;
}

function writeToStorage(s: Settings): void {
  writeRaw(STORAGE_KEY, JSON.stringify(s));
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
