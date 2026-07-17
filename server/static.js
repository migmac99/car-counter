import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

// index.html and sw.js must always revalidate so deploys take effect;
// vendored runtime/model files are immutable at a given path.
function cacheControl(pathname) {
  if (pathname === '/index.html' || pathname === '/sw.js') return 'no-cache';
  if (pathname.startsWith('/vendor/')) return 'public, max-age=86400';
  return 'public, max-age=300';
}

export function makeStaticHandler(rootDir) {
  const root = resolve(rootDir);
  return async function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    const filePath = normalize(join(root, pathname));
    if (!filePath.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let info;
    try {
      info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }

    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': cacheControl(pathname),
      ETag: etag,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  };
}
