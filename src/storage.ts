// The single home for Helio's localStorage keyspace + safe I/O. Every persisted
// blob — settings, the game-state save, the sim save — resolves its key through
// `slotKey` here, so the `helio.*` namespace AND the multi-slot scoping live in
// ONE place. When multi-slot saves land, the per-slot blobs become
// slotKey('game', slot) / slotKey('sim', slot) with no change to the layers'
// shapes; settings stays global (slot-independent). The two per-slot saves
// (game + sim) cross-reference by Body.id, so a future slot switch scopes them
// together from this one resolver.
//
// I/O is hardened the way every layer needs, in ONE place: reads tolerate
// localStorage being unavailable (private browsing) or an absent key → null;
// writes swallow quota/disabled errors (the session still runs, it just won't
// persist).
//
// Versioning convention (each layer owns its own `version`/`v` field): the JSON
// saves (settings, game-state) use validate-and-merge-over-defaults, so an
// additive field needs no bump and the `version` field is reserved for a future
// BREAKING migration. The sim's binary save instead hard-gates on its version +
// configHash, because raw bytes can't be merged — a mismatch must cold-start.

const NS = 'helio';

// Resolve a save's storage key. Slot 0 (the default — and all there is until
// multi-slot saves land) keeps the bare `helio.<name>` key the saves already use,
// so this stays backward-compatible; slot > 0 appends the index.
export function slotKey(name: string, slot = 0): string {
  return slot > 0 ? `${NS}.${name}.${slot}` : `${NS}.${name}`;
}

// Read a raw string, or null if the key is absent or localStorage is unavailable.
export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Persist a raw string, swallowing quota/disabled errors (applies this session,
// just won't survive a reload).
export function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // No recovery; swallow — same rationale across every save layer.
  }
}

// Remove a key, swallowing the same errors writeRaw does.
export function removeRaw(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Swallow.
  }
}
