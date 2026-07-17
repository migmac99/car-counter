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

// App code always revalidates (ETag makes that a cheap 304) so deploys take
// effect immediately; the multi-MB vendored runtime/model and icons are
// effectively immutable and may be cached hard.
function cacheControl(pathname) {
  if (pathname.startsWith('/vendor/') || pathname.startsWith('/icons/')) {
    return 'public, max-age=86400';
  }
  return 'no-cache';
}

export function makeStaticHandler(rootDir) {
  const root = resolve(rootDir);
  return async function serveStatic(req, pathname) {
    if (pathname === '/') pathname = '/index.html';
    const filePath = normalize(join(root, pathname));
    if (!filePath.startsWith(root + sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    let info;
    try {
      info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }

    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    const headers = {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': cacheControl(pathname),
      ETag: etag,
    };
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers });
    }
    if (req.method === 'HEAD') {
      return new Response(null, { headers: { ...headers, 'Content-Length': String(info.size) } });
    }
    return new Response(Bun.file(filePath), { headers });
  };
}
