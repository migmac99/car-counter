import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { Tracker } from '../public/js/tracker.js';

const det = (x, y, w = 60, h = 40, cls = 'car', score = 0.8) => ({
  bbox: [x, y, w, h],
  class: cls,
  score,
});

test('detections create tracks that confirm after minHits', () => {
  const tracker = new Tracker({ minHits: 3 });
  let tracks = tracker.update([det(100, 100)], 0);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].confirmed, false);
  tracks = tracker.update([det(105, 100)], 50);
  assert.equal(tracks[0].confirmed, false);
  tracks = tracker.update([det(110, 100)], 100);
  assert.equal(tracks[0].confirmed, true);
  assert.equal(tracks[0].hits, 3);
});

test('a moving detection keeps its track id (IoU match)', () => {
  const tracker = new Tracker();
  const id = tracker.update([det(100, 100)], 0)[0].id;
  for (let i = 1; i <= 10; i++) {
    const tracks = tracker.update([det(100 + i * 10, 100)], i * 50);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].id, id);
  }
});

test('distance fallback catches fast movers with no bbox overlap', () => {
  const tracker = new Tracker();
  const id = tracker.update([det(100, 100)], 0)[0].id;
  // Jump of 65px: zero IoU for a 60px-wide box, but within one box diagonal.
  const tracks = tracker.update([det(165, 100)], 50);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].id, id);
});

test('two separate objects get distinct, stable ids', () => {
  const tracker = new Tracker();
  const first = tracker.update([det(0, 0), det(500, 300)], 0);
  assert.equal(first.length, 2);
  const ids = new Set(first.map((t) => t.id));
  assert.equal(ids.size, 2);
  const second = tracker.update([det(10, 0), det(490, 300)], 50);
  assert.deepEqual(new Set(second.map((t) => t.id)), ids);
});

test('unseen tracks are dropped after maxAgeMs', () => {
  const tracker = new Tracker({ maxAgeMs: 1000 });
  tracker.update([det(100, 100)], 0);
  assert.equal(tracker.update([], 500).length, 1, 'still alive within maxAge');
  assert.equal(tracker.update([], 1500).length, 0, 'dropped after maxAge');
});

test('ByteTrack stage 2: weak detections sustain tracks but never create them', () => {
  const tracker = new Tracker({ highThresh: 0.5, maxAgeMs: 1000 });
  // A lone low-confidence detection must not open a track.
  assert.equal(tracker.update([det(100, 100, 60, 40, 'car', 0.2)], 0).length, 0);

  // Establish a confident track, then feed only weak detections.
  tracker.update([det(100, 100, 60, 40, 'car', 0.9)], 0);
  tracker.update([det(110, 100, 60, 40, 'car', 0.9)], 50);
  const id = tracker.tracks[0].id;
  for (let i = 2; i <= 12; i++) {
    const tracks = tracker.update([det(100 + i * 10, 100, 60, 40, 'car', 0.2)], i * 50);
    assert.equal(tracks.length, 1, 'weak detections keep the track alive');
    assert.equal(tracks[0].id, id, 'same identity through the blur');
  }
  assert.ok(tracker.tracks[0].cx > 180, 'trajectory advanced on weak detections');
});

test('motion prediction bridges detection gaps for association', () => {
  const tracker = new Tracker({ maxAgeMs: 2000 });
  // Constant motion: +10px per 50ms => vx 0.2 px/ms
  for (let i = 0; i < 6; i++) tracker.update([det(100 + i * 10, 100)], i * 50);
  const id = tracker.tracks[0].id;
  // 600ms gap (12 steps of motion = +120px): raw IoU with the stale box
  // would fail for a 60px-wide box, but the predicted box tracks ahead.
  const tracks = tracker.update([det(100 + 5 * 10 + 120, 100)], 250 + 600);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].id, id);
});

test('track history records the smoothed path', () => {
  const tracker = new Tracker({ historyLen: 5 });
  for (let i = 0; i < 10; i++) tracker.update([det(i * 20, 100)], i * 50);
  const track = tracker.tracks[0];
  assert.equal(track.history.length, 5, 'history is capped');
  const xs = track.history.map((p) => p.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'path moves monotonically right');
});
