import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { nightFromLuma, effectiveNight, trackingTuning, meanLuma, SceneState, sharpness } from '../public/js/scene.js';
import { zoneMaxDims, plausibleVehicle } from '../public/js/geometry.js';

test('night detection has hysteresis (no dusk flapping)', () => {
  assert.equal(nightFromLuma(40, false), true, 'dark enters night');
  assert.equal(nightFromLuma(60, true), true, 'dusk stays night');
  assert.equal(nightFromLuma(60, false), false, 'dusk stays day');
  assert.equal(nightFromLuma(120, true), false, 'bright exits night');
  assert.equal(nightFromLuma(68, false), false, 'shadowed daylight road is day');
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

test('SceneState dwell: headlight spikes cannot flap night mode', () => {
  const s = new SceneState(10_000, true); // night, 10s dwell
  // A car's headlights push the road-band luma into "day" for 3 seconds…
  assert.equal(s.update(90, 0), true);
  assert.equal(s.update(95, 2000), true);
  assert.equal(s.update(88, 3000), true, 'still night through the flare');
  // …then darkness returns: candidate resets.
  assert.equal(s.update(20, 4000), true);
  // Another flare later must restart its own dwell, not inherit the first.
  assert.equal(s.update(90, 20_000), true);
  assert.equal(s.update(90, 29_000), true, '9s of bright: still night');
  assert.equal(s.update(90, 30_100), false, 'sustained past dwell: dawn');
});

test('SceneState: dusk enters night only after the dwell', () => {
  const s = new SceneState(10_000, false);
  assert.equal(s.update(30, 0), false);
  assert.equal(s.update(30, 9000), false);
  assert.equal(s.update(30, 10_500), true);
  // In-band luma (hysteresis zone) keeps the settled state.
  assert.equal(s.update(60, 20_000), true);
});

test('sharpness: defocus crushes the Laplacian variance', () => {
  const w = 64, h = 64;
  // Sharp: checkerboard of 4px tiles; Blurred: heavy box-blur of the same.
  const sharp = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = ((x >> 2) + (y >> 2)) % 2 ? 220 : 30;
      sharp.set([v, v, v], (y * w + x) * 3);
    }
  const blurred = new Uint8Array(w * h * 3);
  const R = 6;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0, n = 0;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          acc += sharp[(yy * w + xx) * 3 + 1];
          n++;
        }
      const v = acc / n;
      blurred.set([v, v, v], (y * w + x) * 3);
    }
  const sSharp = sharpness(sharp, w, h);
  const sBlur = sharpness(blurred, w, h);
  assert.ok(sSharp > 5 * sBlur, `sharp ${sSharp.toFixed(0)} should dwarf blurred ${sBlur.toFixed(0)}`);
  assert.ok(sharpness(new Uint8Array(w * h * 3).fill(128), w, h) === 0, 'flat frame scores zero');
});
