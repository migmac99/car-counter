import { join, resolve } from 'node:path';
import { Store } from './db.js';
import { routes, ApiError } from './api.js';
import { makeStaticHandler } from './static.js';

// The counting engine is optional: it needs ffmpeg plus the worker's
// onnxruntime-node dependency (bun install --cwd worker). Without them the
// server still runs fully — the browser does the counting instead.
let engineModule = null;
let engineUnavailableReason = null;
try {
  engineModule = await import('../worker/engine.js');
  engineUnavailableReason = engineModule.checkRequirements();
  if (engineUnavailableReason) engineModule = null;
} catch {
  engineUnavailableReason =
    "engine dependencies not installed — run: bun install --cwd worker (and ensure ffmpeg is installed)";
}

const ROOT = resolve(import.meta.dir, '..');
const MAX_BODY_BYTES = 512 * 1024;

// The app runs detection locally and only talks to its own origin, plus the
// CDN/model hosts used as fallback when vendored assets are absent.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // Cross-origin isolation enables multithreaded WASM for the ONNX backend's
  // CPU fallback. CDN-fallback scripts are loaded with crossorigin=anonymous.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Content-Security-Policy': [
    "default-src 'self'",
    // 'unsafe-eval' is required by TensorFlow.js (it generates kernel code
    // via new Function); see docs/architecture.md#security.
    "script-src 'self' https://cdn.jsdelivr.net 'unsafe-eval' 'wasm-unsafe-eval'",
    "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com https://www.kaggle.com https://tfhub.dev",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "style-src 'self'",
    "worker-src 'self' blob:",
  ].join('; '),
};

export function createApp({ dbFile = join(ROOT, 'data', 'car-counter.sqlite') } = {}) {
  const store = new Store(dbFile);
  const serveStatic = makeStaticHandler(join(ROOT, 'public'));
  const engine = engineModule
    ? new engineModule.CountingEngine({
        getConfig: () => store.getConfig('app') ?? {},
        postEvents: (events) => store.insertEvents(events),
      })
    : null;

  async function handle(req, url) {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response(null, { status: 405 });
      }
      return serveStatic(req, url.pathname);
    }

    try {
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new ApiError(404, 'no such endpoint');
      let body, rawBody;
      if (req.method === 'POST' || req.method === 'PUT') {
        rawBody = await req.text();
        if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
          throw new ApiError(413, 'request body too large');
        }
        try {
          body = JSON.parse(rawBody || 'null');
        } catch {
          throw new ApiError(400, 'body must be valid JSON');
        }
      }
      const result = await handler(store, {
        query: url.searchParams,
        body,
        rawBody,
        engine,
        engineUnavailableReason,
      });
      if (result instanceof Response) return result;
      return Response.json(result);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) console.error(`[api] ${req.method} ${url.pathname}:`, err);
      return Response.json(
        { error: err instanceof ApiError ? err.message : 'internal error' },
        { status }
      );
    }
  }

  async function fetch(req) {
    const res = await handle(req, new URL(req.url));
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  }

  return { fetch, store, engine };
}

export function startServer({
  port = Number(process.env.PORT ?? 3000),
  hostname = process.env.HOST ?? '0.0.0.0',
  dbFile = process.env.DB_FILE,
} = {}) {
  const app = createApp(dbFile ? { dbFile } : {});
  const server = Bun.serve({
    port,
    hostname,
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: app.fetch,
  });
  return { server, store: app.store, engine: app.engine };
}

if (import.meta.main) {
  // Under `bun --hot` this module re-evaluates on every save; Bun.serve reuses
  // the listening socket and swaps the fetch handler in place. Close the
  // previous run's DB connection and register signal handlers only once.
  await globalThis.__carCounter?.engine?.stop();
  globalThis.__carCounter?.store.close();
  globalThis.__carCounter = startServer();
  const { server, store, engine } = globalThis.__carCounter;
  console.log(`car-counter listening on http://localhost:${server.port} (bound to ${server.hostname})`);
  console.log('Note: camera access from other devices requires HTTPS — see docs/user-guide.md');
  if (engine) {
    const saved = store.getConfig('app')?.engine;
    if (saved?.enabled) {
      engine
        .start(saved)
        .then(() => console.log(`engine: counting from ${engine.state.source} (${engine.state.model}/${engine.state.ep})`))
        .catch((err) => console.error(`engine: could not start (${err.message}) — start it from the web UI`));
    } else {
      console.log('engine: available — enable server-side counting from the web UI (or PUT /api/engine)');
    }
  } else {
    console.log(`engine: unavailable (${engineUnavailableReason}) — the browser will do the counting`);
  }
  if (!globalThis.__carCounterSignals) {
    globalThis.__carCounterSignals = true;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => {
        await globalThis.__carCounter.engine?.stop();
        globalThis.__carCounter.server.stop();
        globalThis.__carCounter.store.close();
        process.exit(0);
      });
    }
  }
}
