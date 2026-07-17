#!/usr/bin/env bun
/**
 * Standalone CLI for the counting engine — for running against a REMOTE
 * car-counter server, or processing recorded footage. When the server runs
 * on the same machine you normally don't need this: the server hosts the
 * engine itself (see docs/architecture.md).
 *
 * Usage:
 *   bun worker/index.js                     # default camera 0, server :3000
 *   bun worker/index.js --device 1          # pick a camera (see --list-devices)
 *   bun worker/index.js --input clip.webm   # process a recorded file (realtime)
 *   bun worker/index.js --list-devices
 * Options: --server URL  --size WxH  --fps N  --loop  --exit-on-end
 */
import { CountingEngine } from './engine.js';
import { checkRequirements, listDevices } from './devices.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

if (has('list-devices')) {
  for (const d of listDevices()) console.log(`${d.index}: ${d.name}`);
  process.exit(0);
}

const problem = checkRequirements();
if (problem) {
  console.error(problem);
  process.exit(1);
}

const SERVER = opt('server', 'http://localhost:3000');

const engine = new CountingEngine({
  async getConfig() {
    const res = await fetch(`${SERVER}/api/config`);
    if (!res.ok) throw new Error(`GET /api/config -> ${res.status}`);
    return res.json();
  },
  async postEvents(events) {
    const res = await fetch(`${SERVER}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    if (!res.ok && res.status !== 400) throw new Error(`POST /api/events -> ${res.status}`);
  },
});

try {
  await engine.start({
    input: opt('input', null),
    device: opt('device', '0'),
    size: opt('size', '1920x1080'),
    fps: Number(opt('fps', 30)),
    loop: has('loop'),
  });
} catch (err) {
  console.error(`Could not start: ${err.message}`);
  process.exit(1);
}

console.log(`[worker] ${engine.state.source} → ${engine.state.model} on ${engine.state.ep} → ${SERVER}`);
console.log('[worker] note: make sure the server-hosted engine and browser tabs are not also counting this camera.');

const timer = setInterval(() => {
  const s = engine.state;
  if (!s.running && opt('input', null)) {
    clearInterval(timer);
    engine.stop().then(() => {
      console.log(`\nfinished; counted ${s.counted} crossings.`);
      process.exit(s.error ? 1 : 0);
    });
    return;
  }
  process.stdout.write(
    `\r[worker] ${s.model}/${s.ep} · det ${s.detPerSec}/s · ${s.detMs} ms · counted ${s.counted}${s.error ? ` · ${s.error}` : ''}   `
  );
}, 2000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await engine.stop();
    process.exit(0);
  });
}
