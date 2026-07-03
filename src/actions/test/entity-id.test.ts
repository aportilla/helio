// entity-id codec invariants — the frozen `body:` / un-prefixed-ship keyspace that lets one
// menu/resolver/anchor pipeline address ships and bodies without collision. Pure; runs
// under `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BODY_ID_PREFIX, SYS_ID_PREFIX, encodeBodyEntityId, encodeSystemEntityId, parseEntityId, isBodyEntityId, isSystemEntityId } from '../entity-id.ts';

test('a body id round-trips through encode → parse', () => {
  const id = encodeBodyEntityId(7);
  assert.equal(id, 'body:7');
  assert.deepEqual(parseEntityId(id), { kind: 'body', bodyIdx: 7 });
});

test('bodyIdx 0 is a valid body id (not swallowed as falsy)', () => {
  assert.equal(encodeBodyEntityId(0), 'body:0');
  assert.deepEqual(parseEntityId('body:0'), { kind: 'body', bodyIdx: 0 });
});

test('an un-prefixed id parses as a ship verbatim (the legacy/default case)', () => {
  assert.deepEqual(parseEntityId('s7'), { kind: 'ship', shipId: 's7' });
  // Any non-body-prefixed string is a ship id, passed through unchanged.
  assert.deepEqual(parseEntityId('anything'), { kind: 'ship', shipId: 'anything' });
});

test('ship ids never collide with the body namespace', () => {
  // Ship.id is 's'+digits, facility id 'f'+digits — neither starts with the prefix.
  assert.equal(isBodyEntityId('s12'), false);
  assert.equal(isBodyEntityId('f3'), false);
  assert.equal(isBodyEntityId(encodeBodyEntityId(0)), true);
  assert.equal(BODY_ID_PREFIX, 'body:');
});

test('a malformed body suffix falls back to the ship arm, never a NaN/negative index', () => {
  // A corrupt replayed id misses cleanly (parses as a ship that no fleet contains)
  // instead of indexing BODIES at NaN.
  assert.deepEqual(parseEntityId('body:nope'), { kind: 'ship', shipId: 'body:nope' });
  assert.deepEqual(parseEntityId('body:-1'), { kind: 'ship', shipId: 'body:-1' });
  assert.deepEqual(parseEntityId('body:1.5'), { kind: 'ship', shipId: 'body:1.5' });
});

test('a non-canonical body suffix is a ship, NOT a Number()-coerced index', () => {
  // Number() would coerce each of these to a valid-looking (live!) index — the empty suffix
  // to 0 worst of all. The canonical-string round-trip guard rejects them all.
  for (const id of ['body:', 'body: 5', 'body:5 ', 'body:0x10', 'body:1e2', 'body:+5', 'body:07']) {
    assert.deepEqual(parseEntityId(id), { kind: 'ship', shipId: id });
  }
});

// -- the sys: namespace (a galaxy warp destination) --------------------

test('a system id round-trips through encode → parse (the slug carried verbatim)', () => {
  const id = encodeSystemEntityId('sirius-a');
  assert.equal(id, 'sys:sirius-a');
  assert.deepEqual(parseEntityId(id), { kind: 'system', systemId: 'sirius-a' });
  assert.equal(SYS_ID_PREFIX, 'sys:');
});

test('the sys: and body: namespaces do not collide, and neither is a ship', () => {
  assert.equal(isSystemEntityId('sys:vega'), true);
  assert.equal(isSystemEntityId('body:5'), false);
  assert.equal(isSystemEntityId('s7'), false);
  assert.equal(isBodyEntityId('sys:vega'), false);
  // A sys id is its own arm, never the ship fallback.
  assert.deepEqual(parseEntityId('sys:vega'), { kind: 'system', systemId: 'vega' });
  // An un-prefixed slug-looking id is still a ship (only the explicit prefix marks a system).
  assert.deepEqual(parseEntityId('vega'), { kind: 'ship', shipId: 'vega' });
});
