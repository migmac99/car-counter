import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { SpeedMatcher } from '../public/js/speed.js';

function configured(limitKmh = 50) {
  const m = new SpeedMatcher();
  m.configure({ gateA: 'la', gateB: 'lb', meters: 26, limitKmh });
  return m;
}

test('speed from two gate crossings: 26 m in 2 s = 46.8 km/h', () => {
  const m = configured();
  assert.equal(m.observe(1, 'la', 10_000), null, 'first gate alone yields nothing');
  const result = m.observe(1, 'lb', 12_000);
  assert.equal(result.kmh, 46.8);
  assert.equal(result.over, false);
});

test('gate order does not matter and over-limit is flagged', () => {
  const m = configured(40);
  m.observe(2, 'lb', 5_000);
  const result = m.observe(2, 'la', 7_000);
  assert.equal(result.kmh, 46.8);
  assert.equal(result.over, true);
});

test('crossings of non-gate lines are ignored', () => {
  const m = configured();
  assert.equal(m.observe(1, 'other', 1_000), null);
  m.observe(1, 'la', 2_000);
  assert.equal(m.observe(1, 'other', 3_000), null);
  assert.equal(m.observe(1, 'lb', 4_000).kmh, 46.8);
});

test('implausible timing is rejected', () => {
  const m = configured();
  m.observe(1, 'la', 1_000);
  assert.equal(m.observe(1, 'lb', 1_050), null, 'faster than 150 ms is a glitch');
});

test('inactive without both gates and a distance', () => {
  const m = new SpeedMatcher();
  m.configure({ gateA: 'la', gateB: 'la', meters: 26 });
  assert.equal(m.active, false, 'same line twice is not a gate pair');
  m.configure({ gateA: 'la', gateB: 'lb', meters: 0 });
  assert.equal(m.active, false, 'no distance');
  m.configure({ gateA: 'la', gateB: 'lb', meters: 26 });
  assert.equal(m.active, true);
});

test('prune drops half-completed measurements for dead tracks', () => {
  const m = configured();
  m.observe(7, 'la', 1_000);
  m.prune(new Set());
  assert.equal(m.observe(7, 'lb', 3_000), null, 'gate A crossing was pruned');
});
