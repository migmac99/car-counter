import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';

let server;
let base;

before(async () => {
  ({ server } = createApp({ dbFile: ':memory:' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

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
      { ts: now - 5000, direction: 'fwd', class: 'car', confidence: 0.91, trackId: 7 },
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
