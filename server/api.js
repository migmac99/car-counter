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
  if (e.line != null && (typeof e.line !== 'string' || e.line.length > 64)) return 'invalid line';
  if (e.speed != null && !(e.speed > 0 && e.speed < 400)) return 'invalid speed';
  if (e.over != null && typeof e.over !== 'boolean') return 'invalid over';
  if (e.est != null && typeof e.est !== 'boolean') return 'invalid est';
  if (e.source != null && (typeof e.source !== 'string' || e.source.length > 64)) return 'invalid source';
  return null;
}

/** Speed limit + retention as currently configured — stats evaluate against
 *  these at query time (only velocities are stored, so both can change
 *  retroactively). */
function statsSettings(store) {
  const config = store.getConfig('app') ?? {};
  return { limitKmh: Number(config.speed?.limitKmh) || 0 };
}

function parseTsParam(query, name) {
  const raw = query.get(name);
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ApiError(400, `${name} must be epoch ms`);
  return n;
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

  'GET /api/stats/summary': (store) => store.summary(statsSettings(store)),

  'GET /api/stats/history': (store, { query }) => {
    const bucket = query.get('bucket') ?? 'minute';
    if (!['minute', 'hour', 'day'].includes(bucket))
      throw new ApiError(400, "bucket must be 'minute', 'hour' or 'day'");
    return store.history({
      bucket,
      from: parseTsParam(query, 'from'),
      to: parseTsParam(query, 'to'),
      ...statsSettings(store),
    });
  },

  'GET /api/stats/speeds': (store, { query }) =>
    store.speedStats({
      from: parseTsParam(query, 'from'),
      to: parseTsParam(query, 'to'),
      limitKmh: statsSettings(store).limitKmh,
    }),

  'GET /api/stats/classes': (store, { query }) =>
    store.classStats({ from: parseTsParam(query, 'from'), to: parseTsParam(query, 'to') }),

  'GET /api/config': (store) => store.getConfig('app') ?? {},

  'PUT /api/config': (store, { body, rawBody, engine }) => {
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new ApiError(400, 'config must be a JSON object');
    if (rawBody.length > MAX_CONFIG_BYTES) throw new ApiError(413, 'config too large');
    // The `engine` block is server-managed (PUT /api/engine); UI config
    // saves never carry it and must not wipe engine enablement/autostart.
    const saved = store.getConfig('app')?.engine;
    if (saved && body.engine === undefined) body.engine = saved;
    store.setConfig('app', body);
    engine?.applyConfig(); // pick up new lines/zones/view/model immediately
    return { ok: true };
  },

  // --- server-side counting engine ---
  'GET /api/engine': (store, { engine, engineUnavailableReason }) =>
    engine ? engine.status : { available: false, running: false, reason: engineUnavailableReason },

  'GET /api/engine/devices': (store, { listDevices }) => {
    if (!listDevices) throw new ApiError(503, 'engine unavailable');
    return { devices: listDevices() };
  },

  'PUT /api/engine': async (store, { body, engine, engineUnavailableReason }) => {
    if (!engine) throw new ApiError(503, `engine unavailable: ${engineUnavailableReason}`);
    if (typeof body?.running !== 'boolean') throw new ApiError(400, 'body must include running: true|false');
    const config = store.getConfig('app') ?? {};
    const source = {
      device: String(body.device ?? config.engine?.device ?? '0'),
      // The name is the reliable selector: capture backends index cameras
      // differently, so the engine matches by name and only falls back to
      // the index. (≤ 64 chars, defensive.)
      deviceName:
        typeof body.deviceName === 'string'
          ? body.deviceName.slice(0, 64)
          : config.engine?.deviceName,
      size: body.size ?? config.engine?.size ?? '1920x1080',
      fps: Number(body.fps ?? config.engine?.fps ?? 30),
      ...(body.input ? { input: body.input, loop: Boolean(body.loop) } : {}),
    };
    // Persist enablement (file inputs are one-off runs, not remembered).
    config.engine = {
      enabled: body.running && !body.input,
      device: source.device,
      deviceName: source.deviceName,
      size: source.size,
      fps: source.fps,
    };
    store.setConfig('app', config);
    if (body.running) {
      try {
        await engine.start(source);
      } catch (err) {
        throw new ApiError(500, `engine failed to start: ${err.message}`);
      }
    } else {
      await engine.stop();
    }
    return engine.status;
  },

  'GET /api/preview': async (store, { engine }) => {
    const jpeg = engine ? await engine.preview() : null;
    if (!jpeg) throw new ApiError(404, 'no preview available — is the engine running?');
    return new Response(jpeg, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
    });
  },

  // Push stream of preview frames (multipart MJPEG): lower latency and far
  // less HTTP churn than polling /api/preview.
  'GET /api/preview.mjpeg': (store, { engine }) => {
    if (!engine) throw new ApiError(503, 'engine unavailable');
    const BOUNDARY = 'carcounterframe';
    let timer = null;
    const stream = new ReadableStream({
      start(controller) {
        let lastSeq = -1;
        let lastJpeg = null;
        let lastSentAt = Date.now();
        let stoppedSince = null;
        let sending = false;
        const part = (jpeg) =>
          Buffer.concat([
            Buffer.from(
              `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`
            ),
            jpeg,
            Buffer.from('\r\n'),
          ]);
        const shutdown = () => {
          clearInterval(timer);
          try {
            controller.close();
          } catch {}
        };
        timer = setInterval(async () => {
          if (sending) return;
          sending = true;
          try {
            // Close gracefully once the engine has been off for a while; the
            // client falls back / resubscribes on its next engine-mode entry.
            if (!engine.status.running) {
              stoppedSince ??= Date.now();
              if (Date.now() - stoppedSince > 5000) shutdown();
              return;
            }
            stoppedSince = null;
            const frame = await engine.previewFrame(lastSeq);
            if (frame) {
              lastSeq = frame.seq;
              lastJpeg = frame.jpeg;
              lastSentAt = Date.now();
              controller.enqueue(part(frame.jpeg));
            } else if (lastJpeg && Date.now() - lastSentAt > 4000) {
              // Heartbeat: re-send the last frame so the connection never
              // idles out during capture stalls (permission prompt, retry).
              lastSentAt = Date.now();
              controller.enqueue(part(lastJpeg));
            }
          } catch {
            shutdown();
          } finally {
            sending = false;
          }
        }, 70);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'Cache-Control': 'no-store',
      },
    });
  },

  'DELETE /api/events': (store, { query }) => {
    if (query.get('confirm') !== 'yes')
      throw new ApiError(400, "pass ?confirm=yes to delete all recorded events");
    store.clearEvents();
    return { ok: true };
  },

  'GET /api/presets': (store) => ({ presets: store.listPresets() }),

  'GET /api/preset': (store, { query }) => {
    const config = store.getConfig(presetKey(query));
    if (!config) throw new ApiError(404, 'no such preset');
    return config;
  },

  'PUT /api/preset': (store, { query, body, rawBody }) => {
    const key = presetKey(query);
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new ApiError(400, 'preset must be a JSON object');
    if (rawBody.length > MAX_CONFIG_BYTES) throw new ApiError(413, 'preset too large');
    store.setConfig(key, body);
    return { ok: true };
  },

  'DELETE /api/preset': (store, { query }) => {
    store.deleteConfig(presetKey(query));
    return { ok: true };
  },
};

const PRESET_NAME = /^\w[\w\- ]{0,39}$/;

function presetKey(query) {
  const name = query.get('name');
  if (!name || !PRESET_NAME.test(name))
    throw new ApiError(400, 'name must be 1-40 chars: letters, digits, spaces, - or _');
  return `preset:${name}`;
}
