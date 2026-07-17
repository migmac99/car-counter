import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { nightFromLuma, effectiveNight, trackingTuning, meanLuma } from '../public/js/scene.js';
import { zoneMaxDims, plausibleVehicle } from '../public/js/geometry.js';

test('night detection has hysteresis (no dusk flapping)', () => {
  assert.equal(nightFromLuma(40, false), true, 'dark enters night');
  assert.equal(nightFromLuma(75, true), true, 'dusk stays night');
  assert.equal(nightFromLuma(75, false), false, 'dusk stays day');
  assert.equal(nightFromLuma(120, true), false, 'bright exits night');
});

test('scene setting overrides measurement', () => {
  assert.equal(effectiveNight('night', false), true);
  assert.equal(effectiveNight('day', true), false);
  assert.equal(effectiveNight('auto', true), true);
  assert.equal(effectiveNight('auto', false), false);
});

test('night tuning demands more evidence but associates more generously', () => {
  const day = trackingTuning(false);
  const night = trackingTuning(true);
  assert.ok(night.minHits > day.minHits, 'more confirmations at night');
  assert.ok(night.smoothing < day.smoothing, 'heavier smoothing at night');
  assert.ok(night.maxAgeMs > day.maxAgeMs, 'longer memory at night');
  assert.ok(night.threshScale < 1, 'lower association threshold at night');
  assert.ok(night.hysteresisScale > 1, 'wider crossing dead-band at night');
});

test('meanLuma reads the green channel across strides', () => {
  const dark = new Uint8Array(3000).fill(10);
  const bright = new Uint8Array(3000).fill(200);
  assert.equal(Math.round(meanLuma(dark, 3)), 10);
  assert.equal(Math.round(meanLuma(bright, 4)), 200);
});

test('plausibleVehicle rejects hallucinated giants, keeps real cars', () => {
  const zone = [
    // road band: 1800 wide, 200 tall
    { x: 60, y: 400 },
    { x: 1860, y: 380 },
    { x: 1860, y: 580 },
    { x: 60, y: 600 },
  ];
  const dims = zoneMaxDims([zone]);
  assert.equal(dims.w, 1800);
  assert.equal(dims.h, 220);
  const viewArea = 1920 * 1080;
  assert.ok(plausibleVehicle([500, 450, 120, 60], viewArea, dims), 'normal car passes');
  assert.ok(!plausibleVehicle([400, 100, 900, 700], viewArea, dims), 'taller than the road band: rejected');
  assert.ok(!plausibleVehicle([0, 0, 1920, 700], viewArea, dims), 'half the frame: rejected');
  assert.ok(plausibleVehicle([500, 450, 120, 60], viewArea, null), 'no zones: normal car still passes');
  assert.ok(!plausibleVehicle([0, 0, 1400, 900], viewArea, null), 'no zones: >50% of view still rejected');
});
