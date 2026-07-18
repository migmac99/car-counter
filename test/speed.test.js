import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { SpeedMatcher, gateCalibration, historyKmh } from '../public/js/speed.js';

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

test('re-applying an identical config keeps pending half-pairs', () => {
  const m = configured();
  m.observe(1, 'la', 10_000);
  m.configure({ gateA: 'la', gateB: 'lb', meters: 26, limitKmh: 50 }); // periodic re-apply
  assert.equal(m.observe(1, 'lb', 12_000).kmh, 46.8, 'measurement survives reconfigure');
});

test('changing gates clears pending half-pairs', () => {
  const m = configured();
  m.observe(1, 'la', 10_000);
  m.configure({ gateA: 'la', gateB: 'lc', meters: 26 });
  assert.equal(m.observe(1, 'lc', 12_000), null, 'stale gate-A timestamp discarded');
});

test('prune drops half-completed measurements for dead tracks', () => {
  const m = configured();
  m.observe(7, 'la', 1_000);
  m.prune(new Set());
  assert.equal(m.observe(7, 'lb', 3_000), null, 'gate A crossing was pruned');
});

test('gateCalibration: px-per-meter from gate midpoint separation', () => {
  const lines = [
    { id: 'g1', a: { x: 100, y: 100 }, b: { x: 100, y: 300 } },
    { id: 'g2', a: { x: 360, y: 100 }, b: { x: 360, y: 300 } },
  ];
  assert.equal(gateCalibration(lines, { gateA: 'g1', gateB: 'g2', meters: 26 }), 10, '260 px / 26 m');
  assert.equal(gateCalibration(lines, { gateA: 'g1', gateB: 'g1', meters: 26 }), 0, 'same gate: inactive');
  assert.equal(gateCalibration(lines, { gateA: 'g1', gateB: 'gX', meters: 26 }), 0, 'missing line');
  assert.equal(gateCalibration(lines, { gateA: 'g1', gateB: 'g2', meters: 0 }), 0, 'no distance');
});

test('historyKmh: constant motion through the calibration', () => {
  // 10 px/m scale, 13 px per 100 ms step = 130 px/s = 46.8 km/h
  const history = Array.from({ length: 12 }, (_, i) => ({ x: i * 13, y: 0, t: i * 100 }));
  assert.ok(Math.abs(historyKmh(history, 10) - 46.8) < 1e-9);
  assert.equal(historyKmh(history, 0), null, 'uncalibrated: no estimate');
  assert.equal(historyKmh(history.slice(0, 3), 10), null, 'too little history');
});

test('historyKmh: median discards centroid-teleport spike frames', () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ x: i * 13, y: 0, t: i * 100 }));
  history[7] = { ...history[7], x: history[7].x + 160 }; // one-frame box flap
  const est = historyKmh(history, 10);
  assert.ok(Math.abs(est - 46.8) < 2, `spike ignored, got ${est}`);
});
