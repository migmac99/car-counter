import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store } from './db.js';
import { routes, ApiError } from './api.js';
import { makeStaticHandler } from './static.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_BODY_BYTES = 512 * 1024;

// The app runs detection locally and only talks to its own origin, plus the
// CDN/model hosts used as fallback when vendored assets are absent.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
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

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp({ dbFile = join(ROOT, 'data', 'car-counter.sqlite') } = {}) {
  const store = new Store(dbFile);
  const serveStatic = makeStaticHandler(join(ROOT, 'public'));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      await serveStatic(req, res, url.pathname);
      return;
    }

    try {
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new ApiError(404, 'no such endpoint');
      let body, rawBody;
      if (req.method === 'POST' || req.method === 'PUT') {
        rawBody = await readBody(req);
        try {
          body = JSON.parse(rawBody.toString('utf8') || 'null');
        } catch {
          throw new ApiError(400, 'body must be valid JSON');
        }
      }
      const result = handler(store, { query: url.searchParams, body, rawBody });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) console.error(`[api] ${req.method} ${url.pathname}:`, err);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err instanceof ApiError ? err.message : 'internal error' }));
    }
  });

  server.on('close', () => store.close());
  return { server, store };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  const { server } = createApp();
  server.listen(port, host, () => {
    console.log(`car-counter listening on http://localhost:${port} (bound to ${host})`);
    console.log('Note: camera access from other devices requires HTTPS — see docs/user-guide.md');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
