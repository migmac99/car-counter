const MAX_BATCH = 500;
const MAX_EVENT_AGE_MS = 30 * 86_400_000;
const MAX_FUTURE_SKEW_MS = 120_000;
const MAX_CONFIG_BYTES = 32 * 1024;
const DIRECTIONS = new Set(['fwd', 'rev']);

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateEvent(e, now) {
  if (typeof e !== 'object' || e === null) return 'event must be an object';
  if (!Number.isFinite(e.ts)) return 'ts must be a number (epoch ms)';
  if (e.ts > now + MAX_FUTURE_SKEW_MS) return 'ts is in the future';
  if (e.ts < now - MAX_EVENT_AGE_MS) return 'ts is too old';
  if (!DIRECTIONS.has(e.direction)) return "direction must be 'fwd' or 'rev'";
  if (e.class != null && (typeof e.class !== 'string' || e.class.length > 32)) return 'invalid class';
  if (e.confidence != null && !(e.confidence >= 0 && e.confidence <= 1)) return 'invalid confidence';
  if (e.trackId != null && !Number.isInteger(e.trackId)) return 'invalid trackId';
  if (e.source != null && (typeof e.source !== 'string' || e.source.length > 64)) return 'invalid source';
  return null;
}

/** Route table: { 'METHOD /path': (store, { query, body }) => result } */
export const routes = {
  'GET /api/health': () => ({ ok: true, uptime: process.uptime() }),

  'POST /api/events': (store, { body }) => {
    const events = body?.events;
    if (!Array.isArray(events) || events.length === 0)
      throw new ApiError(400, 'body must be { events: [...] } with at least one event');
    if (events.length > MAX_BATCH) throw new ApiError(400, `at most ${MAX_BATCH} events per batch`);
    const now = Date.now();
    for (const e of events) {
      const problem = validateEvent(e, now);
      if (problem) throw new ApiError(400, problem);
    }
    const inserted = store.insertEvents(events);
    return { inserted };
  },

  'GET /api/stats/summary': (store) => store.summary(),

  'GET /api/stats/history': (store, { query }) => {
    const bucket = query.get('bucket') ?? 'minute';
    if (!['minute', 'hour', 'day'].includes(bucket))
      throw new ApiError(400, "bucket must be 'minute', 'hour' or 'day'");
    const parseTs = (name) => {
      const raw = query.get(name);
      if (raw == null) return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ApiError(400, `${name} must be epoch ms`);
      return n;
    };
    return store.history({ bucket, from: parseTs('from'), to: parseTs('to') });
  },

  'GET /api/config': (store) => store.getConfig('app') ?? {},

  'PUT /api/config': (store, { body, rawBody }) => {
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new ApiError(400, 'config must be a JSON object');
    if (rawBody.length > MAX_CONFIG_BYTES) throw new ApiError(413, 'config too large');
    store.setConfig('app', body);
    return { ok: true };
  },

  'DELETE /api/events': (store, { query }) => {
    if (query.get('confirm') !== 'yes')
      throw new ApiError(400, "pass ?confirm=yes to delete all recorded events");
    store.clearEvents();
    return { ok: true };
  },
};
