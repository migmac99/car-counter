import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { buildGrids, decode, nms } from '../public/js/yolox.js';

test('buildGrids covers all strides of the input square', () => {
  const grids = buildGrids(416);
  // 52*52 + 26*26 + 13*13
  assert.equal(grids.length, 2704 + 676 + 169);
  assert.deepEqual(grids[0], { gx: 0, gy: 0, stride: 8 });
  assert.equal(grids.at(-1).stride, 32);
});

test('decode maps grid-relative predictions to input pixels', () => {
  const grids = buildGrids(416);
  const data = new Float32Array(grids.length * 85);
  // Plant a car at grid cell index 100 of the stride-8 map: gx=100%52=48, gy=1
  const i = 100;
  const o = i * 85;
  data[o] = 0.5; // dx within cell
  data[o + 1] = 0.5;
  data[o + 2] = Math.log(4); // w = 4 * stride
  data[o + 3] = Math.log(2);
  data[o + 4] = 0.9; // objectness
  data[o + 5 + 2] = 0.8; // class 2 = car
  data[o + 5 + 7] = 0.3; // truck, weaker

  const dets = decode(data, grids, 0.25);
  assert.equal(dets.length, 1);
  const d = dets[0];
  assert.equal(d.classId, 2);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} !~ ${b}`);
  close(d.score, 0.72); // 0.9 * 0.8, through float32
  const { gx, gy, stride } = grids[i];
  close(d.bbox[2], 4 * stride);
  close(d.bbox[3], 2 * stride);
  close(d.bbox[0], (gx + 0.5) * stride - (4 * stride) / 2);
  close(d.bbox[1], (gy + 0.5) * stride - stride);
});

test('decode ignores non-vehicle classes and weak scores', () => {
  const grids = buildGrids(416);
  const data = new Float32Array(grids.length * 85);
  data[4] = 0.9;
  data[5 + 0] = 0.99; // person: not a vehicle class
  const none = decode(data, grids, 0.25);
  assert.equal(none.length, 0);
});

test('nms suppresses same-class duplicates, keeps the strongest', () => {
  const dets = [
    { bbox: [0, 0, 100, 100], score: 0.9, classId: 2 },
    { bbox: [5, 5, 100, 100], score: 0.8, classId: 2 }, // heavy overlap, same class
    { bbox: [300, 300, 80, 80], score: 0.7, classId: 7 }, // far away
  ];
  const kept = nms(dets, 0.45);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].score, 0.9);
  assert.equal(kept[1].score, 0.7);
});

test('nms keeps moderately overlapping vehicles of different classes (car behind truck)', () => {
  const dets = [
    { bbox: [0, 0, 100, 100], score: 0.9, classId: 7 }, // truck
    { bbox: [40, 20, 90, 90], score: 0.6, classId: 2 }, // car partly behind it, IoU ~0.36
  ];
  const kept = nms(dets);
  assert.equal(kept.length, 2, 'different real objects both survive');
});

test('nms merges near-identical boxes with different class labels (one hedged vehicle)', () => {
  const dets = [
    { bbox: [0, 0, 100, 100], score: 0.9, classId: 2 }, // "car"
    { bbox: [3, 2, 98, 99], score: 0.7, classId: 7 }, // same object called "truck", IoU ~0.9
  ];
  const kept = nms(dets);
  assert.equal(kept.length, 1, 'one physical vehicle, one detection');
  assert.equal(kept[0].classId, 2, 'strongest label wins');
});
