# Development

## Repo layout

```
server/           Zero-dependency Node 22 server
  index.js        HTTP server, routing, security headers, createApp() for tests
  api.js          Route table + validation
  db.js           SQLite Store: schema, prepared statements, aggregation
  static.js       Static file serving (ETag, cache policy, traversal guard)
public/           The PWA (ES modules, no build step)
  js/             App modules — geometry/tracker/counter are DOM-free and unit-tested
  css/app.css     Theme tokens (light/dark) + layout + chart styles
  icons/          Generated PNGs (committed)
  vendor/         ML runtime + model — gitignored, created by npm run setup
  sw.js           Service worker (see Caching below)
scripts/
  fetch-vendor.mjs    Downloads TF.js + COCO-SSD model into public/vendor/
  generate-icons.mjs  Renders the icon set with a hand-rolled PNG encoder
test/             node:test suites (unit + full-server integration)
docs/             You are here
data/             SQLite database — gitignored, created on first run
```

## Principles

- **Zero runtime dependencies.** Node 22 built-ins only. There is no
  `package-lock.json` because there is nothing to lock; `npm install` is
  never needed.
- **No build step.** The frontend is plain ES modules served as-is.
- **Pure logic stays pure.** `geometry.js`, `tracker.js`, `counter.js` and
  `server/db.js` have no DOM/network dependencies, so the interesting
  algorithms are testable in Node without a browser.

## Scripts

```sh
npm start        # run the server (PORT, HOST env vars)
npm test         # node --test test/*.test.js  — 39 tests, ~100 ms
npm run setup    # fetch ML vendor files (idempotent; --force to re-fetch)
npm run icons    # regenerate public/icons/*.png after changing the art
```

## Testing

- `geometry.test.js` — side/normal/intersection/polygon/IoU math
- `tracker.test.js` — association, confirmation, distance fallback, expiry
- `counter.test.js` — direction semantics, hysteresis, extent, cooldown
- `db.test.js` — aggregation windows, zero-fill, local-time bucket keys,
  range caps, constraint rollback (in-memory SQLite)
- `api.test.js` — full server on an ephemeral port: validation, round-trips,
  security headers, traversal rejection

For end-to-end verification of the CV pipeline, feed a video file through
**Open video…** — a clip with a known number of crossings makes a good manual
regression test (detection quality itself depends on viewpoint; see
[detection-and-tracking.md](detection-and-tracking.md)).

## Caching — read before shipping frontend changes

The service worker uses **network-first for the app shell**, so ordinary code
changes reach clients on the next load with no ceremony. Still bump `VERSION`
in `public/sw.js` when you change the shell file list or the caching logic
itself — activation of the new worker is what clears old caches. The
`/vendor/` files are cached forever by path; if you ever change model
versions, change the vendor paths (or the SW version).

Server-side, app code is served with `Cache-Control: no-cache` + ETag
(revalidation is a cheap 304), vendor/icons with `max-age=86400`.

## Conventions

- Plain JavaScript, ESM everywhere, `#private` class fields where a module
  has real invariants to protect.
- Comments explain constraints and intent, not mechanics.
- Commit messages: what + why in the body; imperative subject.
