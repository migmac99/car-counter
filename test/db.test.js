import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { Store, bucketKey, bucketFloor } from '../server/db.js';

const MIN = 60_000;

function freshStore() {
  return new Store(':memory:');
}

const ev = (ts, direction = 'fwd', cls = 'car') => ({ ts, direction, class: cls, confidence: 0.9 });

test('insert + summary aggregates per direction and window', () => {
  const store = freshStore();
  const now = Date.parse('2026-07-17T12:00:00');
  store.insertEvents([
    ev(now - 30_000, 'fwd'), // within last minute
    ev(now - 30_000, 'rev'),
    ev(now - 4 * MIN, 'fwd'), // within last 5 min
    ev(now - 30 * MIN, 'fwd'), // within last hour
    ev(now - 26 * 60 * MIN, 'fwd'), // yesterday
  ]);
  const s = store.summary(now);
  assert.deepEqual(s.perMinute, { total: 2, fwd: 1, rev: 1 });
  assert.deepEqual(s.per5Min, { total: 3, fwd: 2, rev: 1, ratePerMin: 0.6 });
  assert.equal(s.lastHour.total, 4);
  assert.equal(s.today.total, 4);
  assert.equal(s.allTime.total, 5);
  assert.equal(s.totalEvents, 5);
  store.close();
});

test('history minute buckets are zero-filled and correctly counted', () => {
  const store = freshStore();
  const base = bucketFloor(Date.parse('2026-07-17T10:30:00'), 'minute');
  store.insertEvents([ev(base + 1000, 'fwd'), ev(base + 2000, 'fwd'), ev(base + MIN, 'rev')]);
  const h = store.history({ bucket: 'minute', from: base - 2 * MIN, to: base + 3 * MIN });
  assert.equal(h.buckets.length, 6);
  const nonZero = h.buckets.filter((b) => b.total > 0);
  assert.equal(nonZero.length, 2);
  assert.deepEqual(
    nonZero.map((b) => [b.fwd, b.rev]),
    [
      [2, 0],
      [0, 1],
    ]
  );
  assert.ok(h.buckets.every((b) => b.total === b.fwd + b.rev));
  store.close();
});

test('history day buckets use JS local-time keys', () => {
  const store = freshStore();
  const noon = Date.parse('2026-07-15T12:00:00');
  store.insertEvents([ev(noon), ev(noon + 3600_000, 'rev')]);
  const h = store.history({ bucket: 'day', from: noon - 86_400_000, to: noon + 86_400_000 });
  const hit = h.buckets.find((b) => b.total > 0);
  assert.equal(hit.key, bucketKey(noon, 'day'));
  assert.equal(hit.fwd, 1);
  assert.equal(hit.rev, 1);
  store.close();
});

test('history range is capped to the bucket maximum', () => {
  const store = freshStore();
  const now = Date.now();
  const h = store.history({ bucket: 'minute', from: now - 90 * 86_400_000, to: now });
  assert.ok(h.from >= now - 24 * 3600_000, 'minute range capped at 24h');
  store.close();
});

test('bucketKey formats local time', () => {
  const ts = new Date(2026, 0, 5, 9, 7).getTime(); // Jan 5 2026 09:07 local
  assert.equal(bucketKey(ts, 'minute'), '2026-01-05T09:07');
  assert.equal(bucketKey(ts, 'hour'), '2026-01-05T09:00');
  assert.equal(bucketKey(ts, 'day'), '2026-01-05');
});

test('config roundtrip and clearEvents', () => {
  const store = freshStore();
  assert.equal(store.getConfig('app'), null);
  store.setConfig('app', { line: { a: { x: 0.1, y: 0.5 } } });
  assert.deepEqual(store.getConfig('app'), { line: { a: { x: 0.1, y: 0.5 } } });
  store.insertEvents([ev(Date.now())]);
  store.clearEvents();
  assert.equal(store.summary().allTime.total, 0);
  store.close();
});

test('invalid direction is rejected by the schema constraint', () => {
  const store = freshStore();
  assert.throws(() => store.insertEvents([ev(Date.now(), 'sideways')]));
  assert.equal(store.summary().allTime.total, 0, 'transaction rolled back');
  store.close();
});
