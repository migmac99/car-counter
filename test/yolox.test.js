import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  buildGrids,
  decode,
  nms,
  planTiles,
  regionScale,
  clipFlags,
  mergeSeamFragments,
} from '../public/js/yolox.js';

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

test('nms suppresses a same-class box nested inside a bigger one (one vehicle)', () => {
  const dets = [
    { bbox: [4, 451, 333, 203], score: 0.6, classId: 2 }, // stretched frame-edge box
    { bbox: [253, 448, 88, 112], score: 0.4, classId: 2 }, // tight box inside it
  ];
  assert.equal(nms(dets).length, 1, 'nested same-class boxes are one vehicle');
});

test('nms cross-class: protruding car in front of a truck survives; fully-swallowed fragment merges', () => {
  const protruding = [
    { bbox: [100, 100, 400, 240], score: 0.8, classId: 7 }, // truck
    { bbox: [420, 200, 160, 80], score: 0.6, classId: 2 }, // car half in front, half beyond
  ];
  assert.equal(nms(protruding).length, 2, 'partially nested cross-class = two vehicles');
  const fragment = [
    { bbox: [100, 100, 400, 240], score: 0.8, classId: 2 }, // car
    { bbox: [180, 200, 80, 60], score: 0.4, classId: 3 }, // "motorcycle" piece inside it
  ];
  assert.equal(nms(fragment).length, 1, 'fully nested cross-class = one vehicle (fragment)');
});

test('planTiles covers the region with overlap, right-aligned tail', () => {
  assert.deepEqual(planTiles(400, 416), [{ x: 0 }], 'narrow region: one tile');
  const tiles = planTiles(1500, 416, 48);
  assert.equal(tiles[0].x, 0);
  assert.equal(tiles.at(-1).x, 1500 - 416, 'last tile hugs the right edge');
  for (let i = 1; i < tiles.length; i++) {
    const prevEnd = tiles[i - 1].x + 416;
    assert.ok(tiles[i].x < prevEnd, 'consecutive tiles overlap');
    assert.ok(prevEnd - tiles[i].x >= 40, 'overlap is meaningful');
  }
  // Full horizontal coverage
  let covered = 0;
  for (const t of tiles) covered = Math.max(covered, t.x + 416);
  assert.equal(covered, 1500);
});

test('clipFlags marks inner-edge contact only when a neighbour exists', () => {
  assert.deepEqual(clipFlags([300, 50, 116, 60], true, true, 416), { clipLeft: false, clipRight: true });
  assert.deepEqual(clipFlags([300, 50, 116, 60], true, false, 416), { clipLeft: false, clipRight: false });
  assert.deepEqual(clipFlags([0, 50, 120, 60], true, true, 416), { clipLeft: true, clipRight: false });
});

test('mergeSeamFragments reunites a vehicle split across a seam', () => {
  // Car straddling a seam at x=312 (tiles 0..416 and 312..728):
  const dets = [
    { bbox: [250, 100, 166, 80], classId: 2, score: 0.7, clipLeft: false, clipRight: true },
    { bbox: [312, 102, 150, 78], classId: 2, score: 0.6, clipLeft: true, clipRight: false },
  ];
  const merged = mergeSeamFragments(dets);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].bbox, [250, 100, 212, 80], 'union of the two halves');
  assert.equal(merged[0].score, 0.7);
});

test('mergeSeamFragments chains across multiple seams and respects lanes', () => {
  // Truck spanning three tiles
  const truck = mergeSeamFragments([
    { bbox: [200, 100, 216, 90], classId: 7, score: 0.6, clipLeft: false, clipRight: true },
    { bbox: [312, 100, 416, 90], classId: 7, score: 0.7, clipLeft: true, clipRight: true },
    { bbox: [624, 100, 200, 90], classId: 7, score: 0.5, clipLeft: true, clipRight: false },
  ]);
  assert.equal(truck.length, 1, 'three-tile truck reunites');
  assert.equal(truck[0].bbox[2], 624, '200..824 wide');
  // Two vehicles in DIFFERENT lanes near the same seam stay separate
  const lanes = mergeSeamFragments([
    { bbox: [250, 100, 166, 60], classId: 2, score: 0.7, clipLeft: false, clipRight: true },
    { bbox: [312, 300, 150, 60], classId: 2, score: 0.6, clipLeft: true, clipRight: false },
  ]);
  assert.equal(lanes.length, 2, 'no vertical overlap: not merged');
});

test('regionScale balances upscale cap, height fit and tile budget', () => {
  // Small zoomed crop: upscale but no more than 1.6x
  assert.equal(regionScale(256, 144, 416), 1.6);
  // Wide road band: bounded by the 4-tile width budget
  const f = regionScale(1800, 220, 416);
  const scaledW = 1800 * f;
  assert.ok(scaledW <= 4 * (416 - 50) + 50 + 1, 'fits in 4 tiles');
  assert.ok(220 * f <= 416, 'height fits the model input');
  assert.ok(f > 0.5, 'still far better than full-frame letterboxing');
  // Full 1080p frame: height-bound
  const f2 = regionScale(1920, 1080, 416);
  assert.ok(Math.abs(1080 * f2 - 416) < 1, 'height scaled to the input');
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
