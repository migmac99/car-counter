import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineCounter } from '../public/js/counter.js';

// Horizontal line y=100 from x=0..200; 'fwd' = crossing downward (positive side).
const LINE = { a: { x: 0, y: 100 }, b: { x: 200, y: 100 } };

const track = (id, x, y, confirmed = true) => ({
  id,
  cx: x,
  cy: y,
  confirmed,
  class: 'car',
  score: 0.9,
});

function makeCounter() {
  const counter = new LineCounter({ hysteresis: 8, cooldownMs: 2000 });
  counter.setLine(LINE);
  return counter;
}

test('downward crossing emits one fwd event', () => {
  const counter = makeCounter();
  assert.deepEqual(counter.update([track(1, 100, 50)], 0), []);
  const events = counter.update([track(1, 100, 150)], 100);
  assert.equal(events.length, 1);
  assert.equal(events[0].direction, 'fwd');
  assert.equal(events[0].trackId, 1);
  assert.equal(events[0].class, 'car');
  // Continuing on the same side does not re-count.
  assert.deepEqual(counter.update([track(1, 100, 170)], 200), []);
});

test('upward crossing emits rev', () => {
  const counter = makeCounter();
  counter.update([track(1, 100, 150)], 0);
  const events = counter.update([track(1, 100, 40)], 100);
  assert.equal(events.length, 1);
  assert.equal(events[0].direction, 'rev');
});

test('jitter inside the hysteresis band never counts', () => {
  const counter = makeCounter();
  counter.update([track(1, 100, 50)], 0);
  for (let i = 0; i < 20; i++) {
    // Oscillate ±5px around the line, inside the 8px band.
    const y = 100 + (i % 2 === 0 ? 5 : -5);
    assert.deepEqual(counter.update([track(1, 100, y)], 100 + i * 50), []);
  }
});

test('crossing beyond the line extent is ignored', () => {
  const counter = makeCounter();
  counter.update([track(1, 400, 50)], 0); // far right of the 0..200 segment
  assert.deepEqual(counter.update([track(1, 400, 150)], 100), []);
});

test('unconfirmed tracks are not counted', () => {
  const counter = makeCounter();
  counter.update([track(1, 100, 50, false)], 0);
  assert.deepEqual(counter.update([track(1, 100, 150, false)], 100), []);
});

test('cooldown suppresses immediate re-count, allows later re-cross', () => {
  const counter = makeCounter();
  counter.update([track(1, 100, 50)], 0);
  assert.equal(counter.update([track(1, 100, 150)], 100).length, 1);
  // Bounces straight back within the cooldown: suppressed.
  assert.deepEqual(counter.update([track(1, 100, 50)], 500), []);
  // Crosses again long after the cooldown: counted.
  const events = counter.update([track(1, 100, 150)], 5000);
  assert.equal(events.length, 1);
  assert.equal(events[0].direction, 'fwd');
});

test('setLine resets crossing state', () => {
  const counter = makeCounter();
  counter.update([track(1, 100, 50)], 0);
  counter.setLine(LINE);
  // Track reappears below the line with no prior side: seeds, no count.
  assert.deepEqual(counter.update([track(1, 100, 150)], 100), []);
});

test('prune drops state for dead tracks', () => {
  const counter = makeCounter();
  counter.update([track(1, 100, 50)], 0);
  counter.prune(new Set()); // track 1 is gone
  // Same id reappears on the other side: treated as a fresh seed, no count.
  assert.deepEqual(counter.update([track(1, 100, 150)], 100), []);
});

test('no line configured means no events', () => {
  const counter = new LineCounter();
  assert.deepEqual(counter.update([track(1, 100, 50)], 0), []);
});
