import { test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';

let server;
let store;
let base;

beforeAll(() => {
  ({ server, store } = startServer({ port: 0, dbFile: ':memory:' }));
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  store.close();
});

const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('health endpoint', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('event ingestion, summary and history round-trip', async () => {
  const now = Date.now();
  const res = await post('/api/events', {
    events: [
      { ts: now - 5000, direction: 'fwd', class: 'car', confidence: 0.91, trackId: 7, line: 'line-abc123' },
      { ts: now - 4000, direction: 'rev', class: 'truck', confidence: 0.75, trackId: 8 },
    ],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { inserted: 2 });

  const summary = await (await fetch(`${base}/api/stats/summary`)).json();
  assert.equal(summary.perMinute.total, 2);
  assert.equal(summary.perMinute.fwd, 1);
  assert.equal(summary.perMinute.rev, 1);

  const history = await (
    await fetch(`${base}/api/stats/history?bucket=minute&from=${now - 120_000}&to=${now}`)
  ).json();
  assert.equal(history.bucket, 'minute');
  const total = history.buckets.reduce((sum, b) => sum + b.total, 0);
  assert.equal(total, 2);
});

test('rejects malformed events', async () => {
  for (const [events, why] of [
    [undefined, 'missing events'],
    [[], 'empty batch'],
    [[{ ts: Date.now(), direction: 'sideways' }], 'bad direction'],
    [[{ direction: 'fwd' }], 'missing ts'],
    [[{ ts: Date.now() + 600_000, direction: 'fwd' }], 'future ts'],
    [[{ ts: Date.now(), direction: 'fwd', confidence: 3 }], 'bad confidence'],
    [[{ ts: Date.now(), direction: 'fwd', line: 'x'.repeat(65) }], 'line too long'],
  ]) {
    const res = await post('/api/events', { events });
    assert.equal(res.status, 400, `should reject: ${why}`);
  }
  const res = await fetch(`${base}/api/events`, { method: 'POST', body: 'not json' });
  assert.equal(res.status, 400, 'non-JSON body');
});

test('history validates bucket and timestamps', async () => {
  assert.equal((await fetch(`${base}/api/stats/history?bucket=fortnight`)).status, 400);
  assert.equal((await fetch(`${base}/api/stats/history?bucket=hour&from=abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/stats/history?bucket=day`)).status, 200);
});

test('config round-trip', async () => {
  const config = { line: { a: { x: 0.1, y: 0.4 }, b: { x: 0.9, y: 0.6 } }, minScore: 0.6 };
  const put = await fetch(`${base}/api/config`, { method: 'PUT', body: JSON.stringify(config) });
  assert.equal(put.status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/config`)).json(), config);
  const bad = await fetch(`${base}/api/config`, { method: 'PUT', body: '[1,2]' });
  assert.equal(bad.status, 400, 'arrays are not a valid config');
});

test('delete requires confirmation', async () => {
  assert.equal((await fetch(`${base}/api/events`, { method: 'DELETE' })).status, 400);
  const res = await fetch(`${base}/api/events?confirm=yes`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const summary = await (await fetch(`${base}/api/stats/summary`)).json();
  assert.equal(summary.allTime.total, 0);
});

test('preset save, list, load, delete round-trip', async () => {
  const config = {
    lines: [{ id: 'line-1', a: { x: 0.1, y: 0.2 }, b: { x: 0.9, y: 0.2 } }],
    zones: [],
    view: { z: 2, cx: 0.5, cy: 0.5 },
  };
  const put = await fetch(`${base}/api/preset?name=Front%20Window`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
  assert.equal(put.status, 200);

  const list = await (await fetch(`${base}/api/presets`)).json();
  assert.ok(list.presets.some((p) => p.name === 'Front Window'));

  const loaded = await (await fetch(`${base}/api/preset?name=Front%20Window`)).json();
  assert.deepEqual(loaded, config);

  assert.equal((await fetch(`${base}/api/preset?name=Front%20Window`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/preset?name=Front%20Window`)).status, 404);
});

test('preset validation', async () => {
  assert.equal((await fetch(`${base}/api/preset?name=..%2Fevil`)).status, 400, 'bad name chars');
  assert.equal((await fetch(`${base}/api/preset`)).status, 400, 'missing name');
  const arr = await fetch(`${base}/api/preset?name=ok`, { method: 'PUT', body: '[1]' });
  assert.equal(arr.status, 400, 'array is not a valid preset');
  const long = await fetch(`${base}/api/preset?name=${'x'.repeat(41)}`, { method: 'PUT', body: '{}' });
  assert.equal(long.status, 400, 'name too long');
});

test('unknown api endpoint yields JSON 404', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});

test('static file serving with security headers', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal((await fetch(`${base}/../etc/passwd`)).status, 404, 'traversal blocked');
  assert.equal((await fetch(`${base}/nope.html`)).status, 404);
});
