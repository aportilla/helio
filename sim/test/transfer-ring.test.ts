import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransferRing, EtaBuckets } from '../src/transfer-ring.ts';
import { asPlanet, asResource } from '../src/ids.ts';

function mintArgs(over: Partial<Parameters<TransferRing['mint']>[0]> = {}) {
  return {
    resource: asResource(0), qtyMilli: 100, srcPlanet: asPlanet(0), dstPlanet: asPlanet(1),
    arrivalTurn: 3, finalArrival: 3, hopIndex: 0, routeRef: 0, ...over,
  };
}

test('mint assigns monotonic ids and tracks live count + in-flight total', () => {
  const ring = new TransferRing(16, 64);
  const s1 = ring.mint(mintArgs({ qtyMilli: 100, arrivalTurn: 2 }));
  const s2 = ring.mint(mintArgs({ qtyMilli: 250, arrivalTurn: 5 }));
  assert.equal(ring.transferId[s1], 1);
  assert.equal(ring.transferId[s2], 2);
  assert.equal(ring.liveCount, 2);
  assert.equal(ring.inFlightTotal, 350);
});

test('takeDue drains only the matching bucket, in id order', () => {
  const ring = new TransferRing(16, 64);
  ring.mint(mintArgs({ arrivalTurn: 4 }));
  ring.mint(mintArgs({ arrivalTurn: 4 }));
  ring.mint(mintArgs({ arrivalTurn: 7 }));
  const due = ring.takeDue(4);
  assert.equal(due.length, 2);
  assert.deepEqual(due.map((s) => ring.transferId[s]), [1, 2], 'sorted by transferId');
  assert.equal(ring.takeDue(4).length, 0, 'bucket emptied after takeDue');
  assert.equal(ring.takeDue(7).length, 1, 'other buckets untouched');
});

test('relink moves a slot to a new bucket without changing qty', () => {
  const ring = new TransferRing(16, 64);
  const s = ring.mint(mintArgs({ arrivalTurn: 3, qtyMilli: 500 }));
  ring.takeDue(3);
  ring.relink(s, 6, 1);
  assert.equal(ring.inFlightTotal, 500, 'relink does not change in-flight total');
  const due = ring.takeDue(6);
  assert.deepEqual(due, [s]);
  assert.equal(ring.hopIndex[s], 1);
});

test('free returns the slot and decrements totals', () => {
  const ring = new TransferRing(16, 64);
  const s = ring.mint(mintArgs({ qtyMilli: 400 }));
  const due = ring.takeDue(3);
  ring.free(due[0]!);
  assert.equal(ring.liveCount, 0);
  assert.equal(ring.inFlightTotal, 0);
  // freed slot is reusable
  const s2 = ring.mint(mintArgs({ qtyMilli: 10 }));
  assert.equal(s2, s, 'slot recycled from the free chain');
});

test('pool exhaustion throws (the v1 active-flow hard stop)', () => {
  const ring = new TransferRing(16, 2);
  ring.mint(mintArgs());
  ring.mint(mintArgs());
  assert.throws(() => ring.mint(mintArgs()), /pool exhausted/);
});

test('EtaBuckets: add/sub and inboundWithinH window', () => {
  const led = new EtaBuckets(4, 32);
  const p = asPlanet(1), r = asResource(0);
  led.add(p, r, 105, 300); // lands turn 105
  led.add(p, r, 110, 50); // lands turn 110
  assert.equal(led.inboundWithinH(p, r, 100, 6), 300, 'only 105 within (100,106]');
  assert.equal(led.inboundWithinH(p, r, 100, 10), 350, 'both within (100,110]');
  assert.equal(led.inboundWithinH(p, r, 105, 6), 50, '105 is excluded (strictly after current turn)');
  led.sub(p, r, 105, 300);
  assert.equal(led.inboundWithinH(p, r, 100, 10), 50);
  assert.equal(led.total(), 50);
});

test('EtaBuckets: over-subtract throws (phantom-inbound guard)', () => {
  const led = new EtaBuckets(4, 32);
  led.add(asPlanet(0), asResource(0), 10, 5);
  assert.throws(() => led.sub(asPlanet(0), asResource(0), 10, 6), /negative inbound/);
});

test('EtaBuckets rebuildFrom the ring matches an incrementally-built ledger', () => {
  const ring = new TransferRing(32, 64);
  const inc = new EtaBuckets(4, 32);
  const mk = (dst: number, res: number, fin: number, qty: number) => {
    ring.mint(mintArgs({ dstPlanet: asPlanet(dst), resource: asResource(res), finalArrival: fin, arrivalTurn: 3, qtyMilli: qty }));
    inc.add(asPlanet(dst), asResource(res), fin, qty);
  };
  mk(1, 0, 105, 300);
  mk(1, 0, 105, 200); // same cell — sums
  mk(2, 1, 108, 75);
  const rebuilt = new EtaBuckets(4, 32);
  rebuilt.rebuildFrom(ring);
  assert.ok(rebuilt.equals(inc), 'rebuild from ring == incremental ledger');
  assert.equal(inc.total(), ring.inFlightTotal);
});
