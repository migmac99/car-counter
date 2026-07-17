#!/usr/bin/env bun
/**
 * Headless counting worker — counts vehicles WITHOUT a browser.
 *
 * Captures frames with ffmpeg (webcam via AVFoundation, or any video file),
 * runs YOLOX on onnxruntime-node (CoreML on Apple silicon, CPU otherwise),
 * and reuses the exact same tracking / line-crossing / speed modules as the
 * web app. Configuration (lines, zones, zoom view, thresholds, speed gates)
 * is read from the running car-counter server, and crossing events are
 * POSTed back to it — so the dashboard, history and presets all keep
 * working, browser open or not.
 *
 * Usage:
 *   bun worker/index.js                     # default camera 0, server :3000
 *   bun worker/index.js --device 1          # pick a camera (see --list-devices)
 *   bun worker/index.js --input clip.webm   # process a recorded file (realtime)
 *   bun worker/index.js --list-devices
 * Options: --server URL  --size WxH  --fps N  --loop  --model yolox-tiny|s|nano
 *
 * Run EITHER the worker OR a browser tab with the camera — both at once
 * would double-count.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ort from 'onnxruntime-node';
import { YOLOX_CLASSES, YOLOX_VARIANTS, buildGrids, decode, nms } from '../public/js/yolox.js';
import { Tracker } from '../public/js/tracker.js';
import { LineCounter } from '../public/js/counter.js';
import { SpeedMatcher } from '../public/js/speed.js';
import { pointInPolygon, boxCenter } from '../public/js/geometry.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// --- CLI ---
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

if (has('list-devices')) {
  const res = spawnSync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    encoding: 'utf8',
  });
  console.log(res.stderr.split('\n').filter((l) => l.includes('AVFoundation')).join('\n'));
  process.exit(0);
}

const SERVER = opt('server', 'http://localhost:3000');
const INPUT_FILE = opt('input', null);
const DEVICE = opt('device', '0');
const CAM_SIZE = opt('size', '1920x1080');
const CAM_FPS = Number(opt('fps', 30));
const LOOP = has('loop');

// --- config from the server ---
async function fetchConfig() {
  const res = await fetch(`${SERVER}/api/config`);
  if (!res.ok) throw new Error(`GET /api/config -> ${res.status}`);
  return res.json();
}

let config;
try {
  config = await fetchConfig();
} catch (err) {
  console.error(`Cannot reach the car-counter server at ${SERVER} (${err.message}).`);
  console.error('Start it first: bun start');
  process.exit(1);
}
if (!config.lines?.length) {
  console.error('No counting lines configured — draw them in the web UI first (they are shared).');
  process.exit(1);
}

const modelName = opt('model', null) ?? (YOLOX_VARIANTS[config.model] ? config.model : 'yolox-tiny');
const variant = YOLOX_VARIANTS[modelName];
if (!variant) {
  console.error(`Unknown model '${modelName}'. Options: ${Object.keys(YOLOX_VARIANTS).join(', ')}`);
  process.exit(1);
}
const INPUT = variant.size;

// --- source geometry ---
function probeFile(file) {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  );
  const [w, h] = res.stdout.trim().split(',').map(Number);
  if (!w || !h) throw new Error(`ffprobe could not read ${file}`);
  return { w, h };
}

const source = INPUT_FILE ? probeFile(INPUT_FILE) : (() => {
  const [w, h] = CAM_SIZE.split('x').map(Number);
  return { w, h };
})();

// Same view semantics as the browser: detect on the zoomed crop only.
const view = { z: 1, cx: 0.5, cy: 0.5, ...config.view };
const crop = (() => {
  if (!(view.z > 1)) return { x: 0, y: 0, w: source.w, h: source.h };
  const cw = Math.round(source.w / view.z);
  const ch = Math.round(source.h / view.z);
  return {
    x: Math.round(Math.min(source.w - cw, Math.max(0, view.cx * source.w - cw / 2))),
    y: Math.round(Math.min(source.h - ch, Math.max(0, view.cy * source.h - ch / 2))),
    w: cw,
    h: ch,
  };
})();
const scale = INPUT / Math.max(crop.w, crop.h); // letterbox, corner-anchored like the web app
const contentW = Math.max(2, Math.round(crop.w * scale) & ~1); // even for ffmpeg
const contentH = Math.max(2, Math.round(crop.h * scale) & ~1);

// --- pipeline state (same modules as the browser) ---
const tracker = new Tracker({ highThresh: config.minScore ?? 0.5 });
const counters = new Map();
for (const line of config.lines) {
  const counter = new LineCounter({ hysteresis: Math.max(6, source.h * 0.012) });
  counter.setLine({
    a: { x: line.a.x * source.w, y: line.a.y * source.h },
    b: { x: line.b.x * source.w, y: line.b.y * source.h },
  });
  counters.set(line.id, counter);
}
const zones = (config.zones ?? [])
  .map((z) => z.points.map((p) => ({ x: p.x * source.w, y: p.y * source.h })))
  .filter((pts) => pts.length >= 3);
const speedMatcher = new SpeedMatcher();
speedMatcher.configure(config.speed ?? {});
const classes = new Set(config.classes ?? ['car', 'truck', 'bus', 'motorcycle']);
const grids = buildGrids(INPUT);

// --- ONNX session: CoreML (Apple silicon NPU/GPU) with CPU fallback ---
const modelPath = join(ROOT, 'public', 'vendor', 'models', variant.file);
let session;
let ep = 'coreml';
try {
  session = await ort.InferenceSession.create(modelPath, { executionProviders: ['coreml'] });
} catch {
  session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
  ep = 'cpu';
}
const inputName = session.inputNames[0];
const outputName = session.outputNames[0];

// --- event upload queue ---
let queue = [];
let counted = 0;
async function flush() {
  if (queue.length === 0) return;
  const batch = queue.splice(0, 200);
  try {
    const res = await fetch(`${SERVER}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    });
    if (!res.ok && res.status !== 400) queue.unshift(...batch); // retry later
  } catch {
    queue.unshift(...batch);
    if (queue.length > 5000) queue = queue.slice(-5000);
  }
}
setInterval(flush, 3000);

// --- frame processing ---
const frameBytes = INPUT * INPUT * 3;
const plane = INPUT * INPUT;
const chw = new Float32Array(3 * plane);
let busy = false;
let latest = null;
const perf = { n: 0, ms: 0, windowStart: Date.now() };

async function processFrame(rgb) {
  const t0 = performance.now();
  for (let i = 0; i < plane; i++) {
    const p = i * 3;
    chw[i] = rgb[p + 2]; // B
    chw[plane + i] = rgb[p + 1]; // G
    chw[2 * plane + i] = rgb[p]; // R
  }
  const tensor = new ort.Tensor('float32', chw, [1, 3, INPUT, INPUT]);
  const out = (await session.run({ [inputName]: tensor }))[outputName].data;
  perf.ms = perf.ms * 0.9 + (performance.now() - t0) * 0.1;
  perf.n += 1;

  const now = Date.now();
  const detections = nms(decode(out, grids, 0.1))
    .map((d) => ({
      bbox: [
        crop.x + d.bbox[0] / scale,
        crop.y + d.bbox[1] / scale,
        d.bbox[2] / scale,
        d.bbox[3] / scale,
      ],
      class: YOLOX_CLASSES[d.classId],
      score: Math.min(1, d.score),
    }))
    .filter((d) => classes.has(d.class));
  const inZone = zones.length
    ? detections.filter((d) => zones.some((poly) => pointInPolygon(boxCenter(d.bbox), poly)))
    : detections;
  const tracks = tracker.update(inZone, now);
  const liveIds = new Set(tracks.map((t) => t.id));
  for (const [lineId, counter] of counters) {
    for (const c of counter.update(tracks, now)) {
      const measured = speedMatcher.observe(c.trackId, lineId, c.ts);
      queue.push({
        ts: c.ts,
        direction: c.direction,
        class: c.class,
        confidence: Math.round(c.confidence * 1000) / 1000,
        trackId: c.trackId,
        line: lineId,
        source: 'headless',
        ...(measured ? { speed: measured.kmh, over: measured.over } : {}),
      });
      counted += 1;
    }
    counter.prune(liveIds);
  }
  speedMatcher.prune(liveIds);
}

// --- ffmpeg capture ---
const filter = [
  view.z > 1 ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}` : null,
  `scale=${contentW}:${contentH}`,
  `pad=${INPUT}:${INPUT}:0:0:color=0x727272`,
]
  .filter(Boolean)
  .join(',');

const inputArgs = INPUT_FILE
  ? ['-re', ...(LOOP ? ['-stream_loop', '-1'] : []), '-i', INPUT_FILE]
  : ['-f', 'avfoundation', '-framerate', String(CAM_FPS), '-video_size', CAM_SIZE, '-i', DEVICE];

const ffmpeg = spawn(
  'ffmpeg',
  ['-loglevel', 'error', ...inputArgs, '-vf', filter, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { stdio: ['ignore', 'pipe', 'inherit'] }
);

let buffer = Buffer.alloc(0);
ffmpeg.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= frameBytes) {
    latest = buffer.subarray(0, frameBytes); // newest complete frame wins
    buffer = buffer.subarray(frameBytes);
  }
  if (latest && !busy) {
    const frame = latest;
    latest = null;
    busy = true;
    processFrame(frame).finally(() => (busy = false));
  }
});

ffmpeg.on('close', async (code) => {
  clearInterval(statusTimer);
  await flush();
  console.log(`\nffmpeg ended (${code}); counted ${counted} crossings this run.`);
  process.exit(code === 0 || INPUT_FILE ? 0 : 1);
});

// --- status line + live threshold refresh ---
const statusTimer = setInterval(async () => {
  const seconds = (Date.now() - perf.windowStart) / 1000;
  const rate = (perf.n / seconds).toFixed(1);
  perf.n = 0;
  perf.windowStart = Date.now();
  process.stdout.write(
    `\r[worker] ${modelName}/${ep} · det ${rate}/s · ${Math.round(perf.ms)} ms · counted ${counted} · queue ${queue.length}   `
  );
  try {
    const fresh = await fetchConfig();
    tracker.highThresh = fresh.minScore ?? tracker.highThresh;
    speedMatcher.configure(fresh.speed ?? {});
  } catch {}
}, 2000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    ffmpeg.kill('SIGTERM');
    await flush();
    process.exit(0);
  });
}

console.log(
  `[worker] source ${INPUT_FILE ?? `camera ${DEVICE} (${CAM_SIZE}@${CAM_FPS})`} → crop ${crop.w}×${crop.h}` +
    ` → ${modelName} (${INPUT}²) on ${ep} · ${counters.size} line(s), ${zones.length} zone(s) · posting to ${SERVER}`
);
console.log('[worker] note: stop any browser tab using the same camera, or counts will double.');
