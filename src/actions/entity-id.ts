// entity-id — the pure id codec that lets ONE menu/resolver/anchor pipeline address both
// fleet ships and catalog bodies. An Actor.id (and an ActionIntent's actorId / targetIds)
// is a bare string today, always a ship id; M3 makes facility-bearing bodies peer actors
// AND peer targets, so their ids must share that one keyspace without colliding. A body
// mints `body:<bodyIdx>`; a ship id stays UN-PREFIXED — the legacy/default case, so every
// already-shipped ship intent is byte-unchanged and no migration is needed.
//
// FROZEN wire vocabulary. `body:` can enter a serialized ActionIntent.targetIds via the
// replay seam, so it earns the freeze from day one exactly like a command's composed
// `<providerId>:<grant.key>` id (./derive): adding a namespace is safe; renaming/removing
// `body:` would break a saved log.
//
// A pure leaf — it imports nothing (no catalog), so it cannot and must not reconstruct a
// body's precise planet/moon/belt/ring kind: it returns the COARSE body-vs-ship
// discriminant, and a caller that needs the exact body kind looks it up in BODIES by the
// returned bodyIdx. (The collision-freedom is real, not assumed: a ship id is 's'+digits
// and a facility id 'f'+digits — neither starts with the prefix nor contains a colon.)

export const BODY_ID_PREFIX = 'body:';
// The galaxy-destination namespace: a warp target is a SYSTEM, not an in-scene entity. Its suffix is the
// system handle (the cluster primary's slug — the same currency Ship.systemId holds), a string, NOT a
// numeric index like body:. Frozen like body: — it can enter a serialized ActionIntent.targetIds.
export const SYS_ID_PREFIX = 'sys:';

// A parsed entity id: a body (carrying its BODIES index — the scene's anchor key, ==
// DiagramPick.bodyIdx), a system (carrying its stable slug — a galaxy warp destination, with no
// in-scene anchor), or a ship (carrying its game-state Ship.id verbatim).
export type EntityRef =
  | { readonly kind: 'body'; readonly bodyIdx: number }
  | { readonly kind: 'system'; readonly systemId: string }
  | { readonly kind: 'ship'; readonly shipId: string };

// bodyIdx (the BODIES array index) → the body's entity id. The index, not the stable
// Body.id string, is what the scene's BodyCenterIndex / target bracket key on, so it is
// what an anchor lookup needs back out of the id.
export function encodeBodyEntityId(bodyIdx: number): string {
  return `${BODY_ID_PREFIX}${bodyIdx}`;
}

// systemId (the cluster primary's slug) → the system's entity id — a warp destination candidate. The
// slug is carried verbatim (it's already the durable Ship.systemId currency), so decode is the inverse.
export function encodeSystemEntityId(systemId: string): string {
  return `${SYS_ID_PREFIX}${systemId}`;
}

// Parse any entity id into its coarse discriminant. A `body:` prefix → the body arm (the
// suffix is the bodyIdx); anything else → the ship arm verbatim (the un-prefixed default
// keeps legacy ship ids working untouched). A suffix that is not a CANONICAL non-negative
// decimal integer falls back to the ship arm rather than minting a wrong/garbage index — so
// a truncated or corrupt replayed id misses cleanly instead of silently resolving to a live
// body. The `String(bodyIdx) === suffix` round-trip is the canonical check: it rejects the
// values Number() otherwise coerces ('' / ' ' → 0, '0x10' → 16, '1e2' → 100, '+5'/'07'/'5 '),
// while accepting every id encodeBodyEntityId can emit (String(Number(`${n}`)) === `${n}` for
// any non-negative integer n).
export function parseEntityId(id: string): EntityRef {
  if (id.startsWith(BODY_ID_PREFIX)) {
    const suffix = id.slice(BODY_ID_PREFIX.length);
    const bodyIdx = Number(suffix);
    if (Number.isInteger(bodyIdx) && bodyIdx >= 0 && String(bodyIdx) === suffix) {
      return { kind: 'body', bodyIdx };
    }
  }
  // A `sys:` prefix → the system arm, the suffix carried verbatim as the slug. No canonical check (a
  // slug is an opaque string, unlike a body's numeric index); an empty suffix simply yields ''.
  if (id.startsWith(SYS_ID_PREFIX)) {
    return { kind: 'system', systemId: id.slice(SYS_ID_PREFIX.length) };
  }
  return { kind: 'ship', shipId: id };
}

// The cheap namespace test for callers that only fork an anchor lookup (body ⇒ bodyCenter,
// ship ⇒ fleetSlotCenter) and don't need the parsed index — a syntactic prefix check, so
// it agrees with parseEntityId only on a WELL-FORMED body id (a malformed `body:` suffix
// is a ship to parseEntityId; use parseEntityId when the index matters).
export function isBodyEntityId(id: string): boolean {
  return id.startsWith(BODY_ID_PREFIX);
}

// The cheap namespace test for a system (warp-destination) id — a syntactic prefix check, so a caller
// can fork "has no in-scene anchor" (the destination lives in galaxy space) without parsing the slug.
export function isSystemEntityId(id: string): boolean {
  return id.startsWith(SYS_ID_PREFIX);
}
