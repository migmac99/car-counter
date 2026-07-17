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
  source      TEXT    NOT NULL DEFAULT 'default',
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

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
    this.stmts = {
      insert: this.db.prepare(
        `INSERT INTO events (ts, direction, class, confidence, track_id, line, speed, over, source, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      countSince: this.db.prepare(
        `SELECT direction, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY direction`
      ),
      countAll: this.db.prepare(
        `SELECT direction, COUNT(*) AS n FROM events GROUP BY direction`
      ),
      bounds: this.db.prepare(
        `SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n FROM events`
      ),
      perMinute: this.db.prepare(
        `SELECT (ts / 60000) * 60000 AS minute, direction, COUNT(*) AS n,
                SUM(speed) AS sumSpeed, COUNT(speed) AS nSpeed, SUM(over) AS over
         FROM events WHERE ts >= ? AND ts <= ?
         GROUP BY minute, direction`
      ),
      speedSince: this.db.prepare(
        `SELECT COUNT(speed) AS n, AVG(speed) AS avg, MAX(speed) AS max, SUM(over) AS over
         FROM events WHERE speed IS NOT NULL AND ts >= ?`
      ),
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
          e.source ?? 'default',
          receivedAt
        );
      }
    })();
    return events.length;
  }

  #directionCounts(rows) {
    const out = { total: 0, fwd: 0, rev: 0 };
    for (const r of rows) {
      out[r.direction] = r.n;
      out.total += r.n;
    }
    return out;
  }

  #speedWindow(sinceTs) {
    const row = this.stmts.speedSince.get(sinceTs);
    return {
      n: row.n,
      avgKmh: row.avg == null ? null : Math.round(row.avg * 10) / 10,
      maxKmh: row.max == null ? null : Math.round(row.max * 10) / 10,
      over: row.over ?? 0,
    };
  }

  summary(now = Date.now()) {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const since = (ms) => this.#directionCounts(this.stmts.countSince.all(now - ms));
    const per5Min = since(5 * 60_000);
    const bounds = this.stmts.bounds.get();
    return {
      now,
      perMinute: since(60_000),
      per5Min: { ...per5Min, ratePerMin: Math.round((per5Min.total / 5) * 100) / 100 },
      lastHour: since(3600_000),
      today: this.#directionCounts(this.stmts.countSince.all(startOfDay.getTime())),
      allTime: this.#directionCounts(this.stmts.countAll.all()),
      speed: {
        last5Min: this.#speedWindow(now - 5 * 60_000),
        today: this.#speedWindow(startOfDay.getTime()),
      },
      firstEventTs: bounds.first,
      lastEventTs: bounds.last,
      totalEvents: bounds.n,
    };
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
  history({ bucket = 'minute', from, to } = {}) {
    const spec = BUCKETS[bucket];
    if (!spec) throw new RangeError(`unknown bucket: ${bucket}`);
    const now = Date.now();
    to = Math.min(to ?? now, now + 60_000);
    from = from ?? to - Math.min(spec.stepMs * 60, spec.maxRangeMs);
    if (to - from > spec.maxRangeMs) from = to - spec.maxRangeMs;

    const byKey = new Map();
    for (const r of this.stmts.perMinute.all(from, to)) {
      const key = bucketKey(r.minute, bucket);
      const entry = byKey.get(key) ?? { fwd: 0, rev: 0, sumSpeed: 0, nSpeed: 0, over: 0 };
      entry[r.direction] += r.n;
      entry.sumSpeed += r.sumSpeed ?? 0;
      entry.nSpeed += r.nSpeed ?? 0;
      entry.over += r.over ?? 0;
      byKey.set(key, entry);
    }

    const buckets = [];
    for (let t = bucketFloor(from, bucket); t <= to; t = nextBucket(t, bucket)) {
      const key = bucketKey(t, bucket);
      const e = byKey.get(key) ?? { fwd: 0, rev: 0, sumSpeed: 0, nSpeed: 0, over: 0 };
      buckets.push({
        key,
        ts: t,
        fwd: e.fwd,
        rev: e.rev,
        total: e.fwd + e.rev,
        avgKmh: e.nSpeed ? Math.round((e.sumSpeed / e.nSpeed) * 10) / 10 : null,
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
