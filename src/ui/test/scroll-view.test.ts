// Pure-geometry proof for ScrollView: clamp bounds, scrollBy saturation, the
// content-coord hit mapping, and the offset→thumb-travel relation. All exercised
// through applyMetrics (the canvas-free state update), so no 2D context is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScrollView } from '../scroll-view.ts';

const VP = { x: 100, y: 20, w: 50, h: 80 } as const;

test('applyMetrics: a body that fits leaves no scroll room', () => {
  const sv = new ScrollView('#000');
  sv.applyMetrics(VP, 60); // content shorter than the 80-tall viewport
  assert.equal(sv.scrollOffset, 0);
  assert.equal(sv.scrollBy(30), false, 'cannot scroll when everything fits');
  assert.equal(sv.thumbGeom(), null, 'no thumb when there is nothing to scroll');
});

test('scrollBy: clamps to [0, contentH - viewportH] and reports movement', () => {
  const sv = new ScrollView('#000');
  sv.applyMetrics(VP, 200); // max scroll = 200 - 80 = 120
  assert.equal(sv.scrollBy(-10), false, 'already at top');
  assert.equal(sv.scrollBy(50), true);
  assert.equal(sv.scrollOffset, 50);
  assert.equal(sv.scrollBy(1000), true, 'saturates at the bottom');
  assert.equal(sv.scrollOffset, 120);
  assert.equal(sv.scrollBy(5), false, 'pinned at max');
});

test('applyMetrics: a shrunk content height re-clamps a now-too-large offset', () => {
  const sv = new ScrollView('#000');
  sv.applyMetrics(VP, 200);
  sv.scrollBy(120); // at the old max
  assert.equal(sv.scrollOffset, 120);
  sv.applyMetrics(VP, 100); // max is now 20
  assert.equal(sv.scrollOffset, 20, 'offset snaps down to the new max');
});

test('contains: only points inside the viewport rect', () => {
  const sv = new ScrollView('#000');
  sv.applyMetrics(VP, 200);
  assert.equal(sv.contains(120, 50), true);
  assert.equal(sv.contains(VP.x - 1, 50), false, 'left of viewport');
  assert.equal(sv.contains(120, VP.y + VP.h), false, 'bottom edge is exclusive');
});

test('mapInto: outside → null; inside → on-screen Y plus the scroll offset', () => {
  const sv = new ScrollView('#000');
  sv.applyMetrics(VP, 200);
  assert.equal(sv.mapInto(10, 10), null, 'outside the viewport');
  // At offset 0 the mapping is identity within the viewport.
  assert.deepEqual(sv.mapInto(120, 40), { x: 120, y: 40 });
  // Scrolled down: a row drawn at content-Y 100 is on-screen at 100 - 30 = 70; a
  // hit at screen-Y 70 must map back to content-Y 100 so the cached rect matches.
  sv.scrollBy(30);
  assert.deepEqual(sv.mapInto(120, 70), { x: 120, y: 100 });
});

test('thumbGeom: fills the track at the top, floors to the bottom at max scroll', () => {
  const sv = new ScrollView('#000');
  sv.applyMetrics(VP, 160); // viewport 80 is half the content → thumb ≈ half the track
  const top = sv.thumbGeom();
  assert.ok(top);
  assert.equal(top.y, VP.y, 'thumb starts at the track top when unscrolled');
  assert.equal(top.h, 40, 'thumb height = trackH * viewportH / contentH = 80 * 80/160');

  sv.scrollBy(1000); // to max (80)
  const bot = sv.thumbGeom();
  assert.ok(bot);
  assert.equal(bot.y + bot.h, VP.y + VP.h, 'thumb bottom meets the track bottom at max scroll');
});

test('resetOffset: snaps back to the top (used on a content-identity change)', () => {
  const sv = new ScrollView('#000');
  sv.applyMetrics(VP, 200);
  sv.scrollBy(90);
  assert.equal(sv.scrollOffset, 90);
  sv.resetOffset();
  assert.equal(sv.scrollOffset, 0);
});

test('mapInto: snaps a fractional offset to a whole pixel (pixel-crisp render match)', () => {
  const sv = new ScrollView('#000');
  sv.applyMetrics(VP, 200);
  // A fractional trackpad delta accumulates on the float offset...
  sv.scrollBy(30.4);
  assert.equal(sv.scrollOffset, 30.4, 'float offset accumulates for smooth scrolling');
  // ...but the hit mapping (like the render translate) uses the ROUNDED offset, so a
  // hit at screen-Y 70 maps to content-Y 70 + round(30.4) = 100, matching the cached rect.
  assert.deepEqual(sv.mapInto(120, 70), { x: 120, y: 100 });
});

test('bodyRegion: reserves a fixed right gutter so the bar never reflows content', () => {
  const sv = new ScrollView('#000');
  sv.applyMetrics(VP, 40); // fits — gutter is reserved regardless of overflow
  const r = sv.bodyRegion();
  assert.equal(r.x, VP.x);
  assert.equal(r.y, VP.y);
  assert.equal(r.h, VP.h);
  assert.ok(r.w < VP.w, 'body width is narrower than the viewport by the gutter');
});
