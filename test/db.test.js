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
  const s = store.summary({ now });
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

test('speed aggregation in summary and history buckets', () => {
  const store = freshStore();
  const now = Date.now();
  store.insertEvents([
    { ts: now - 30_000, direction: 'fwd', speed: 40, over: false },
    { ts: now - 40_000, direction: 'fwd', speed: 60, over: true },
    { ts: now - 50_000, direction: 'rev' }, // no speed measured
  ]);
  const s = store.summary({ now, limitKmh: 50 });
  assert.equal(s.speed.last5Min.n, 2);
  assert.equal(s.speed.last5Min.avgKmh, 50);
  assert.equal(s.speed.last5Min.maxKmh, 60);
  assert.equal(s.speed.last5Min.over, 1);

  const h = store.history({ bucket: 'hour', from: now - 3600_000, to: now, limitKmh: 50 });
  const hit = h.buckets.filter((b) => b.total > 0);
  const withSpeed = hit.find((b) => b.avgKmh != null);
  assert.equal(withSpeed.avgKmh, 50);
  assert.equal(withSpeed.maxKmh, 60);
  assert.equal(withSpeed.over, 1);
  store.close();
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

test('dynamic over-limit: the CURRENT limit reclassifies stored velocities', () => {
  const store = freshStore();
  const now = Date.now();
  store.insertEvents([
    { ts: now - 10_000, direction: 'fwd', speed: 45 },
    { ts: now - 11_000, direction: 'fwd', speed: 55 },
    { ts: now - 12_000, direction: 'fwd', speed: 65 },
  ]);
  assert.equal(store.summary({ now, limitKmh: 50 }).speed.last5Min.over, 2);
  assert.equal(store.summary({ now, limitKmh: 60 }).speed.last5Min.over, 1, 'limit change re-evaluates');
  assert.equal(store.summary({ now, limitKmh: 0 }).speed.last5Min.over, 0, 'no limit, no over');
  store.close();
});

test('maintain(): old raw events roll up, totals and history survive the prune', () => {
  const store = freshStore();
  const now = Date.parse('2026-07-17T12:00:00');
  const old = now - 40 * 86_400_000; // beyond 30-day retention
  store.insertEvents([
    { ts: old, direction: 'fwd', class: 'car', speed: 50 },
    { ts: old + 1000, direction: 'fwd', class: 'truck' },
    { ts: old + 61_000, direction: 'rev', class: 'car', speed: 70 },
    { ts: now - 1000, direction: 'fwd', class: 'car' }, // recent, stays raw
  ]);
  store.maintain(30, now);
  const raw = store.db.prepare('SELECT COUNT(*) AS n FROM events').get();
  assert.equal(raw.n, 1, 'old raw rows pruned');
  const s = store.summary({ now });
  assert.equal(s.allTime.total, 4, 'totals unchanged after rollup');
  assert.deepEqual([s.allTime.fwd, s.allTime.rev], [3, 1]);
  assert.equal(s.firstEventTs, Math.floor(old / 60000) * 60000, 'first event from rollup');

  const h = store.history({ bucket: 'day', from: old - 86_400_000, to: now });
  const oldDay = h.buckets.find((b) => b.key === bucketKey(old, 'day'));
  assert.equal(oldDay.total, 3, 'rolled-up day still charted');
  assert.equal(oldDay.avgKmh, 60, 'speed averages survive rollup');
  assert.equal(oldDay.maxKmh, 70);
  const classes = store.classStats({ from: old - 86_400_000, to: now, now });
  assert.deepEqual(
    classes.classes.map((c) => [c.class, c.total]),
    [['car', 3], ['truck', 1]],
    'class mix merges raw + rollup'
  );
  store.close();
});

test('maintain is idempotent and respects the minimum retention', () => {
  const store = freshStore();
  const now = Date.now();
  store.insertEvents([{ ts: now - 5 * 86_400_000, direction: 'fwd' }]);
  const r1 = store.maintain(1, now); // below minimum -> clamped to 3 days
  assert.equal(r1.retentionDays, 3);
  store.maintain(3, now);
  store.maintain(3, now);
  assert.equal(store.summary({ now }).allTime.total, 1, 'no double counting after repeat maintain');
  store.close();
});

test('speedStats: percentiles, histogram, per-class, over vs current limit', () => {
  const store = freshStore();
  const now = Date.now();
  const speeds = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75]; // p50=50, p85 idx=7 -> 65
  store.insertEvents(
    speeds.map((v, i) => ({
      ts: now - 1000 * (i + 1),
      direction: 'fwd',
      class: i % 2 ? 'truck' : 'car',
      speed: v,
      est: i % 3 === 0,
    }))
  );
  const st = store.speedStats({ from: now - 3600_000, to: now, limitKmh: 60, now });
  assert.equal(st.n, 10);
  assert.equal(st.p50Kmh, 50);
  assert.equal(st.p85Kmh, 65);
  assert.equal(st.maxKmh, 75);
  assert.equal(st.over, 3, '65, 70, 75 exceed 60');
  assert.equal(st.overPct, 30);
  assert.equal(st.histogram.reduce((a, b) => a + b.n, 0), 10, 'histogram covers all');
  assert.ok(st.histogram.every((b) => b.toKmh - b.fromKmh === 5), '5 km/h bins');
  const car = st.byClass.find((c) => c.class === 'car');
  assert.equal(car.n, 5);
  store.close();
});
