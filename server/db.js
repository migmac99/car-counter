import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  direction   TEXT    NOT NULL CHECK (direction IN ('fwd', 'rev')),
  class       TEXT    NOT NULL DEFAULT 'car',
  confidence  REAL,
  track_id    INTEGER,
  line        TEXT,
  speed       REAL,
  over        INTEGER,
  est         INTEGER NOT NULL DEFAULT 0,
  source      TEXT    NOT NULL DEFAULT 'default',
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_speed_ts ON events (ts) WHERE speed IS NOT NULL;

-- Storage efficiency: raw events are kept for a rolling window only; older
-- history lives in per-minute aggregates (~60 bytes per active minute per
-- direction/class instead of ~70 bytes PER VEHICLE). At highway volumes this
-- is the difference between megabytes and gigabytes per year. Counts, avg
-- and max speed survive forever; per-vehicle drill-down (percentiles,
-- re-evaluating 'over' against a changed limit) needs raw rows, so it spans
-- the retention window only.
CREATE TABLE IF NOT EXISTS rollup_minute (
  minute    INTEGER NOT NULL,
  direction TEXT    NOT NULL,
  class     TEXT    NOT NULL,
  n         INTEGER NOT NULL,
  n_speed   INTEGER NOT NULL DEFAULT 0,
  sum_speed REAL    NOT NULL DEFAULT 0,
  max_speed REAL,
  PRIMARY KEY (minute, direction, class)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

// Raw events older than this are always fully rolled up (data that old no
// longer changes); retention must exceed it so raw/rollup regions meet
// cleanly at the retention boundary.
const ROLLUP_LAG_MS = 48 * 3600_000;
export const MIN_RETENTION_DAYS = 3;
export const DEFAULT_RETENTION_DAYS = 30;

const BUCKETS = {
  minute: { stepMs: 60_000, maxRangeMs: 24 * 3600_000 },
  hour: { stepMs: 3600_000, maxRangeMs: 60 * 86_400_000 },
  day: { stepMs: 86_400_000, maxRangeMs: 400 * 86_400_000 },
};

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Format a timestamp as a local-time bucket key (e.g. "2026-07-17T13:56"). */
export function bucketKey(ts, bucket) {
  const d = new Date(ts);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (bucket === 'day') return date;
  if (bucket === 'hour') return `${date}T${pad(d.getHours())}:00`;
  return `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Floor a timestamp to the start of its local-time bucket. */
export function bucketFloor(ts, bucket) {
  const d = new Date(ts);
  d.setSeconds(0, 0);
  if (bucket === 'hour' || bucket === 'day') d.setMinutes(0);
  if (bucket === 'day') d.setHours(0);
  return d.getTime();
}

function nextBucket(ts, bucket) {
  if (bucket !== 'day') return ts + BUCKETS[bucket].stepMs;
  const d = new Date(ts);
  d.setDate(d.getDate() + 1); // DST-safe day increment
  return d.getTime();
}

export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    // Migrate databases created before the multi-line / speed columns existed.
    const columns = this.db.prepare(`PRAGMA table_info(events)`).all().map((c) => c.name);
    if (!columns.includes('line')) this.db.exec(`ALTER TABLE events ADD COLUMN line TEXT`);
    if (!columns.includes('speed')) {
      this.db.exec(`ALTER TABLE events ADD COLUMN speed REAL`);
      this.db.exec(`ALTER TABLE events ADD COLUMN over INTEGER`);
    }
    if (!columns.includes('est')) {
      this.db.exec(`ALTER TABLE events ADD COLUMN est INTEGER NOT NULL DEFAULT 0`);
    }
    this.stmts = {
      insert: this.db.prepare(
        `INSERT INTO events (ts, direction, class, confidence, track_id, line, speed, over, est, source, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      countSince: this.db.prepare(
        `SELECT direction, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY direction`
      ),
      countRange: this.db.prepare(
        `SELECT direction, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY direction`
      ),
      rollupTotals: this.db.prepare(
        `SELECT direction, SUM(n) AS n FROM rollup_minute WHERE minute < ? GROUP BY direction`
      ),
      bounds: this.db.prepare(
        `SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n FROM events`
      ),
      rollupBounds: this.db.prepare(
        `SELECT MIN(minute) AS first, MAX(minute) AS last, SUM(n) AS n FROM rollup_minute WHERE minute < ?`
      ),
      // `over` is evaluated against the CURRENT limit at query time — only
      // the velocity is stored, so the limit can be changed retroactively.
      perMinute: this.db.prepare(
        `SELECT (ts / 60000) * 60000 AS minute, direction, COUNT(*) AS n,
                SUM(speed) AS sumSpeed, COUNT(speed) AS nSpeed, MAX(speed) AS maxSpeed,
                SUM(CASE WHEN ? > 0 AND speed > ? THEN 1 ELSE 0 END) AS over
         FROM events WHERE ts >= ? AND ts <= ?
         GROUP BY minute, direction`
      ),
      rollupRange: this.db.prepare(
        `SELECT minute, direction, SUM(n) AS n, SUM(sum_speed) AS sumSpeed,
                SUM(n_speed) AS nSpeed, MAX(max_speed) AS maxSpeed
         FROM rollup_minute WHERE minute >= ? AND minute < ?
         GROUP BY minute, direction`
      ),
      speedSince: this.db.prepare(
        `SELECT COUNT(speed) AS n, AVG(speed) AS avg, MAX(speed) AS max,
                SUM(CASE WHEN ? > 0 AND speed > ? THEN 1 ELSE 0 END) AS over
         FROM events WHERE speed IS NOT NULL AND ts >= ?`
      ),
      speedAgg: this.db.prepare(
        `SELECT COUNT(*) AS n, AVG(speed) AS avg, MAX(speed) AS max, MIN(speed) AS min,
                SUM(CASE WHEN ? > 0 AND speed > ? THEN 1 ELSE 0 END) AS over
         FROM events WHERE speed IS NOT NULL AND ts >= ? AND ts <= ?`
      ),
      speedPercentile: this.db.prepare(
        `SELECT speed FROM events WHERE speed IS NOT NULL AND ts >= ? AND ts <= ?
         ORDER BY speed LIMIT 1 OFFSET ?`
      ),
      speedHistogram: this.db.prepare(
        `SELECT CAST(speed / ? AS INTEGER) AS bin, COUNT(*) AS n
         FROM events WHERE speed IS NOT NULL AND ts >= ? AND ts <= ?
         GROUP BY bin ORDER BY bin`
      ),
      speedByClass: this.db.prepare(
        `SELECT class, COUNT(*) AS n, AVG(speed) AS avg, MAX(speed) AS max,
                SUM(CASE WHEN ? > 0 AND speed > ? THEN 1 ELSE 0 END) AS over
         FROM events WHERE speed IS NOT NULL AND ts >= ? AND ts <= ?
         GROUP BY class ORDER BY n DESC`
      ),
      classesRaw: this.db.prepare(
        `SELECT class, direction, COUNT(*) AS n
         FROM events WHERE ts >= ? AND ts <= ? GROUP BY class, direction`
      ),
      classesRollup: this.db.prepare(
        `SELECT class, direction, SUM(n) AS n
         FROM rollup_minute WHERE minute >= ? AND minute < ? GROUP BY class, direction`
      ),
      rollupInsert: this.db.prepare(
        `INSERT OR REPLACE INTO rollup_minute (minute, direction, class, n, n_speed, sum_speed, max_speed)
         SELECT (ts / 60000) * 60000, direction, class, COUNT(*), COUNT(speed),
                COALESCE(SUM(speed), 0), MAX(speed)
         FROM events WHERE ts < ?
         GROUP BY (ts / 60000) * 60000, direction, class`
      ),
      pruneEvents: this.db.prepare(`DELETE FROM events WHERE ts < ?`),
      getConfig: this.db.prepare(`SELECT value FROM config WHERE key = ?`),
      setConfig: this.db.prepare(
        `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ),
      clearEvents: this.db.prepare(`DELETE FROM events`),
      listPresets: this.db.prepare(
        `SELECT key, updated_at FROM config WHERE key LIKE 'preset:%' ORDER BY key`
      ),
      deleteConfig: this.db.prepare(`DELETE FROM config WHERE key = ?`),
    };
  }

  insertEvents(events, receivedAt = Date.now()) {
    // bun:sqlite transactions roll back automatically when the callback throws.
    this.db.transaction(() => {
      for (const e of events) {
        this.stmts.insert.run(
          e.ts,
          e.direction,
          e.class ?? 'car',
          e.confidence ?? null,
          e.trackId ?? null,
          e.line ?? null,
          e.speed ?? null,
          e.speed != null ? (e.over ? 1 : 0) : null,
          e.est ? 1 : 0,
          e.source ?? 'default',
          receivedAt
        );
      }
    })();
    return events.length;
  }

  /**
   * Roll old raw events up into per-minute aggregates and prune raw rows
   * beyond the retention window. Idempotent; run at boot and periodically.
   */
  maintain(retentionDays = DEFAULT_RETENTION_DAYS, now = Date.now()) {
    const days = Math.max(MIN_RETENTION_DAYS, Number(retentionDays) || DEFAULT_RETENTION_DAYS);
    const rollupBefore = Math.floor((now - ROLLUP_LAG_MS) / 60000) * 60000;
    const pruneBefore = now - days * 86_400_000;
    this.db.transaction(() => {
      this.stmts.rollupInsert.run(rollupBefore);
      this.stmts.pruneEvents.run(pruneBefore);
    })();
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    return { rollupBefore, pruneBefore, retentionDays: days };
  }

  /**
   * The raw/rollup boundary is DATA-derived, not config-derived: rollups
   * answer for every minute older than the oldest raw event. Pruning keeps
   * raw rows contiguous up to now, so this is exact — and stays correct
   * when the retention setting changes after rows were already pruned.
   * (Rows older than 48 h exist in both; the boundary assigns each minute
   * to exactly one side, so nothing double-counts.)
   */
  #rawFloor() {
    const min = this.db.prepare('SELECT MIN(ts) AS t FROM events').get().t;
    return min == null ? 9_000_000_000_000_000 : Math.floor(min / 60000) * 60000;
  }

  #directionCounts(rows) {
    const out = { total: 0, fwd: 0, rev: 0 };
    for (const r of rows) {
      out[r.direction] = r.n;
      out.total += r.n;
    }
    return out;
  }

  #speedWindow(sinceTs, limitKmh) {
    const row = this.stmts.speedSince.get(limitKmh, limitKmh, sinceTs);
    return {
      n: row.n,
      avgKmh: row.avg == null ? null : Math.round(row.avg * 10) / 10,
      maxKmh: row.max == null ? null : Math.round(row.max * 10) / 10,
      over: row.over ?? 0,
    };
  }

  summary({ now = Date.now(), limitKmh = 0 } = {}) {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const since = (ms) => this.#directionCounts(this.stmts.countSince.all(now - ms));
    const per5Min = since(5 * 60_000);
    const bounds = this.stmts.bounds.get();
    // All-time totals span raw events plus the rolled-up past.
    const cutoff = this.#rawFloor();
    const allTime = this.#directionCounts(this.stmts.countRange.all(cutoff));
    for (const r of this.stmts.rollupTotals.all(cutoff)) {
      allTime[r.direction] += r.n;
      allTime.total += r.n;
    }
    const rb = this.stmts.rollupBounds.get(cutoff);
    return {
      now,
      perMinute: since(60_000),
      per5Min: { ...per5Min, ratePerMin: Math.round((per5Min.total / 5) * 100) / 100 },
      lastHour: since(3600_000),
      today: this.#directionCounts(this.stmts.countSince.all(startOfDay.getTime())),
      allTime,
      speed: {
        last5Min: this.#speedWindow(now - 5 * 60_000, limitKmh),
        today: this.#speedWindow(startOfDay.getTime(), limitKmh),
      },
      firstEventTs: rb.first != null ? Math.min(rb.first, bounds.first ?? rb.first) : bounds.first,
      lastEventTs: bounds.last ?? rb.last,
      totalEvents: allTime.total,
    };
  }

  /**
   * Speed analytics over raw events (the retention window): percentiles,
   * distribution histogram, per-class stats — all against the CURRENT limit.
   */
  speedStats({ from, to, limitKmh = 0, binKmh = 5, now = Date.now() } = {}) {
    to = Math.min(to ?? now, now + 60_000);
    from = from ?? to - 24 * 3600_000;
    const agg = this.stmts.speedAgg.get(limitKmh, limitKmh, from, to);
    const pct = (q) =>
      agg.n === 0
        ? null
        : this.stmts.speedPercentile.get(from, to, Math.floor(q * (agg.n - 1)))?.speed ?? null;
    const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
    return {
      from,
      to,
      limitKmh,
      n: agg.n,
      avgKmh: round1(agg.avg),
      minKmh: round1(agg.min),
      maxKmh: round1(agg.max),
      p50Kmh: round1(pct(0.5)),
      p85Kmh: round1(pct(0.85)),
      over: agg.over ?? 0,
      overPct: agg.n && limitKmh > 0 ? Math.round(((agg.over ?? 0) / agg.n) * 1000) / 10 : null,
      histogram: this.stmts.speedHistogram
        .all(binKmh, from, to)
        .map((r) => ({ fromKmh: r.bin * binKmh, toKmh: (r.bin + 1) * binKmh, n: r.n })),
      byClass: this.stmts.speedByClass.all(limitKmh, limitKmh, from, to).map((r) => ({
        class: r.class,
        n: r.n,
        avgKmh: round1(r.avg),
        maxKmh: round1(r.max),
        over: r.over ?? 0,
      })),
    };
  }

  /** Vehicle-class mix over [from, to], merging raw events and rollups. */
  classStats({ from, to, now = Date.now() } = {}) {
    to = Math.min(to ?? now, now + 60_000);
    from = from ?? new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
    const cutoff = this.#rawFloor();
    const byClass = new Map();
    const fold = (rows) => {
      for (const r of rows) {
        const e = byClass.get(r.class) ?? { class: r.class, fwd: 0, rev: 0, total: 0 };
        e[r.direction] += r.n;
        e.total += r.n;
        byClass.set(r.class, e);
      }
    };
    fold(this.stmts.classesRaw.all(Math.max(from, cutoff), to));
    if (from < cutoff) fold(this.stmts.classesRollup.all(from, Math.min(to, cutoff)));
    return { from, to, classes: [...byClass.values()].sort((a, b) => b.total - a.total) };
  }

  /**
   * Time-bucketed counts per direction, zero-filled over [from, to], in the
   * server's local time. SQL only pre-aggregates into UTC minute buckets
   * (timezone offsets are always whole minutes, so local minute boundaries
   * align with UTC ones everywhere); all calendar math — hours, DST-safe
   * days, bucket keys — happens in JS so there is exactly one source of
   * local time. (SQLite's own `localtime` modifier uses libc and can
   * disagree with the JS engine's timezone.)
   */
  history({ bucket = 'minute', from, to, limitKmh = 0 } = {}) {
    const spec = BUCKETS[bucket];
    if (!spec) throw new RangeError(`unknown bucket: ${bucket}`);
    const now = Date.now();
    to = Math.min(to ?? now, now + 60_000);
    from = from ?? to - Math.min(spec.stepMs * 60, spec.maxRangeMs);
    if (to - from > spec.maxRangeMs) from = to - spec.maxRangeMs;
    const cutoff = this.#rawFloor();

    const byKey = new Map();
    const fold = (rows, hasOver) => {
      for (const r of rows) {
        const key = bucketKey(r.minute, bucket);
        const entry =
          byKey.get(key) ?? { fwd: 0, rev: 0, sumSpeed: 0, nSpeed: 0, maxSpeed: null, over: 0 };
        entry[r.direction] += r.n;
        entry.sumSpeed += r.sumSpeed ?? 0;
        entry.nSpeed += r.nSpeed ?? 0;
        if (r.maxSpeed != null) entry.maxSpeed = Math.max(entry.maxSpeed ?? 0, r.maxSpeed);
        if (hasOver) entry.over += r.over ?? 0;
        byKey.set(key, entry);
      }
    };
    // Recent range from raw events ('over' vs the current limit); anything
    // beyond retention from the rollups (counts/avg/max survive; per-vehicle
    // 'over' cannot be re-derived there and reads 0).
    fold(this.stmts.perMinute.all(limitKmh, limitKmh, Math.max(from, cutoff), to), true);
    if (from < cutoff) fold(this.stmts.rollupRange.all(from, Math.min(to, cutoff)), false);

    const buckets = [];
    for (let t = bucketFloor(from, bucket); t <= to; t = nextBucket(t, bucket)) {
      const key = bucketKey(t, bucket);
      const e =
        byKey.get(key) ?? { fwd: 0, rev: 0, sumSpeed: 0, nSpeed: 0, maxSpeed: null, over: 0 };
      buckets.push({
        key,
        ts: t,
        fwd: e.fwd,
        rev: e.rev,
        total: e.fwd + e.rev,
        avgKmh: e.nSpeed ? Math.round((e.sumSpeed / e.nSpeed) * 10) / 10 : null,
        maxKmh: e.maxSpeed == null ? null : Math.round(e.maxSpeed * 10) / 10,
        over: e.over,
      });
    }
    return { bucket, from, to, buckets };
  }

  getConfig(key) {
    const row = this.stmts.getConfig.get(key);
    return row ? JSON.parse(row.value) : null;
  }

  setConfig(key, value) {
    this.stmts.setConfig.run(key, JSON.stringify(value), Date.now());
  }

  deleteConfig(key) {
    this.stmts.deleteConfig.run(key);
  }

  listPresets() {
    return this.stmts.listPresets
      .all()
      .map((r) => ({ name: r.key.slice('preset:'.length), updatedAt: r.updated_at }));
  }

  clearEvents() {
    this.stmts.clearEvents.run();
  }

  close() {
    this.db.close();
  }
}
