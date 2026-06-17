// Pins the sim-save base64 codec round-trip, including the 0x8000 chunk boundary
// the chunked String.fromCharCode exists to handle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64FromBytes, bytesFromBase64 } from '../base64.ts';

test('round-trips arbitrary bytes including 0 and 255', () => {
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
  assert.deepEqual(bytesFromBase64(base64FromBytes(bytes)), bytes);
});

test('round-trips an empty array', () => {
  assert.deepEqual(bytesFromBase64(base64FromBytes(new Uint8Array(0))), new Uint8Array(0));
});

test('round-trips across the 0x8000 chunk boundary (the overflow guard)', () => {
  const n = 0x8000 * 2 + 123; // spans three chunks
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) & 0xff;
  const restored = bytesFromBase64(base64FromBytes(bytes));
  assert.equal(restored.length, n);
  assert.deepEqual(restored, bytes);
});
