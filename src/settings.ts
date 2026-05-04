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

export interface Settings {
  version: 1;
  // Behavior of a single-finger TOUCH drag (mouse drags always orbit,
  // unaffected by this setting). When 'orbit', single touch yaws/pitches
  // the camera (the original behavior); when 'pan', single touch shifts
  // view.target along the camera's screen-aligned right/up axes — and
  // the two-finger "pan" gesture instead drives orbit. Pinch-to-zoom is
  // unchanged either way.
  singleTouchAction: SingleTouchAction;
}

const STORAGE_KEY = 'starmap.settings';
const DEFAULTS: Settings = { version: 1, singleTouchAction: 'orbit' };

function readFromStorage(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Validate each field individually and merge over defaults so adding
    // new fields later doesn't break old saves. Reject any value that
    // isn't one of the known enum literals.
    return {
      ...DEFAULTS,
      singleTouchAction: parsed.singleTouchAction === 'pan' ? 'pan' : 'orbit',
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
