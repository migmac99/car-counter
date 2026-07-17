/**
 * CountingEngine — the server-side counting pipeline.
 *
 * Captures frames with ffmpeg (AVFoundation webcam or a video file), runs
 * YOLOX on onnxruntime-node (CoreML on Apple silicon → CPU fallback) and
 * counts with the exact same pure modules the browser uses (tracker,
 * counter, speed, yolox decode). It also has ffmpeg emit a rate-limited,
 * atomically-updated JPEG of the full frame, which the web UI uses as its
 * live preview — making the UI a pure window onto the server.
 *
 * The host supplies `getConfig()` (app config: lines/zones/view/model/…)
 * and `postEvents(events)`. In-process (the server) these hit the Store
 * directly; the standalone CLI wires them to HTTP.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ort from 'onnxruntime-node';
import { YOLOX_CLASSES, YOLOX_VARIANTS, buildGrids, decode, nms } from '../public/js/yolox.js';
import { Tracker } from '../public/js/tracker.js';
import { LineCounter } from '../public/js/counter.js';
import { SpeedMatcher } from '../public/js/speed.js';
import { pointInPolygon, boxCenter, zoneMaxDims, plausibleVehicle } from '../public/js/geometry.js';
import { nightFromLuma, effectiveNight, trackingTuning, meanLuma } from '../public/js/scene.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PREVIEW_FPS = 8;

export { checkRequirements, listDevices } from './devices.js';

export class CountingEngine {
  #getConfig;
  #postEvents;
  #ffmpeg = null;
  #session = null;
  #busy = false;
  #queue = [];
  #flushTimer = null;
  #retryTimer = null;
  #restartTimer = null;
  #configSnapshot = null;
  // Each boot gets a generation; async callbacks from superseded runs
  // (a killed ffmpeg's late 'close', stale timers) self-discard on mismatch.
  #generation = 0;

  constructor({ getConfig, postEvents }) {
    this.#getConfig = getConfig;
    this.#postEvents = postEvents;
    this.state = {
      running: false,
      error: null,
      source: null,
      model: null,
      ep: null,
      frame: null, // {w, h} full source frame
      counted: 0,
      detPerSec: 0,
      detMs: 0,
      startedAt: null,
    };
    this.tracks = [];
    this.previewPath = join(tmpdir(), `car-counter-preview-${process.pid}.jpg`);
  }

  get status() {
    // Never serve a frozen snapshot: if frames stopped flowing (capture
    // hiccup), stale tracks would paint ghost boxes in the UI.
    const fresh = this.state.tracksTs && Date.now() - this.state.tracksTs < 1500;
    return { available: true, ...this.state, tracks: fresh ? this.tracks : [] };
  }

  async preview() {
    try {
      return await readFile(this.previewPath);
    } catch {
      return null;
    }
  }

  /** Latest preview frame if newer than `afterSeq`: {jpeg, seq} | null. */
  async previewFrame(afterSeq = -1) {
    try {
      const info = await stat(this.previewPath);
      if (info.mtimeMs <= afterSeq) return null;
      return { jpeg: await readFile(this.previewPath), seq: info.mtimeMs };
    } catch {
      return null;
    }
  }

  /** source: { input?: filePath, device?: '0', size?: '1920x1080', fps?: 30, loop?: bool } */
  async start(source = {}) {
    await this.stop();
    this.state.error = null;
    this.state.counted = 0;
    this.state.startedAt = Date.now();
    this.sourceOpts = {
      input: source.input ?? null,
      device: String(source.device ?? '0'),
      size: source.size ?? '1920x1080',
      fps: Number(source.fps ?? 30),
      loop: Boolean(source.loop),
    };
    try {
      await this.#boot();
    } catch (err) {
      this.state.error = err.message;
      this.state.running = false;
      throw err;
    }
  }

  async #boot() {
    const gen = ++this.#generation;
    const config = (await this.#getConfig()) ?? {};
    this.#configSnapshot = JSON.stringify({ view: config.view, model: config.model });

    const modelName = YOLOX_VARIANTS[config.model] ? config.model : 'yolox-tiny';
    const variant = YOLOX_VARIANTS[modelName];
    this.inputSize = variant.size;
    this.grids = buildGrids(variant.size);
    const modelPath = join(ROOT, 'public', 'vendor', 'models', variant.file);
    try {
      this.#session = await ort.InferenceSession.create(modelPath, { executionProviders: ['coreml'] });
      this.state.ep = 'coreml';
    } catch {
      this.#session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
      this.state.ep = 'cpu';
    }
    this.state.model = modelName;

    const src = this.sourceOpts;
    const frame = src.input
      ? probeFile(src.input)
      : (() => {
          const [w, h] = src.size.split('x').map(Number);
          return { w, h };
        })();
    this.state.frame = frame;
    this.state.source = src.input ?? `camera ${src.device} (${src.size}@${src.fps})`;
    this.#applyCountingConfig(config); // needs frame dims for pixel-space shapes

    // Same view semantics as the browser: detect on the zoomed crop only.
    const view = { z: 1, cx: 0.5, cy: 0.5, ...config.view };
    const crop =
      view.z > 1
        ? (() => {
            const cw = Math.round(frame.w / view.z);
            const ch = Math.round(frame.h / view.z);
            return {
              x: Math.round(Math.min(frame.w - cw, Math.max(0, view.cx * frame.w - cw / 2))),
              y: Math.round(Math.min(frame.h - ch, Math.max(0, view.cy * frame.h - ch / 2))),
              w: cw,
              h: ch,
            };
          })()
        : { x: 0, y: 0, w: frame.w, h: frame.h };
    this.crop = crop;
    this.scale = variant.size / Math.max(crop.w, crop.h);
    const contentW = Math.max(2, Math.round(crop.w * this.scale) & ~1);
    const contentH = Math.max(2, Math.round(crop.h * this.scale) & ~1);
    // Brightness sampling must exclude the grey letterbox padding, which
    // would bias the day/night decision toward "day".
    this.contentBytes = contentH * variant.size * 3;

    const filter = [
      view.z > 1 ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}` : null,
      `scale=${contentW}:${contentH}`,
      `pad=${variant.size}:${variant.size}:0:0:color=0x727272`,
    ]
      .filter(Boolean)
      .join(',');
    const inputArgs = src.input
      ? ['-re', ...(src.loop ? ['-stream_loop', '-1'] : []), '-i', src.input]
      : ['-f', 'avfoundation', '-framerate', String(src.fps), '-video_size', src.size, '-i', src.device];

    // The preview mirrors THE VIEW: when zoomed, it is the zoomed crop at
    // full preview resolution (sharp), not a scaled full frame. The UI
    // renders it without any CSS zoom of its own.
    const previewFilter = [
      view.z > 1 ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}` : null,
      'scale=960:-2',
    ]
      .filter(Boolean)
      .join(',');
    this.#ffmpeg = spawn(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error',
        ...inputArgs,
        // Cameras only — passthrough: one output frame per REAL camera frame.
        // Without it, AVFoundation's odd timestamps make ffmpeg duplicate
        // frames to a constant rate (measured 115 fps from a 30 fps camera),
        // wasting inference on identical images. File sources keep default
        // pacing (their timestamps are clean; passthrough halved them).
        '-vf', filter, ...(src.input ? [] : ['-fps_mode', 'passthrough']),
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
        '-vf', previewFilter, '-r', String(PREVIEW_FPS), '-q:v', '5',
        '-update', '1', '-atomic_writing', '1', '-f', 'image2', this.previewPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderrTail = '';
    this.#ffmpeg.stderr.on('data', (d) => (stderrTail = (stderrTail + d).slice(-400)));

    // Zero-churn frame assembly: chunks copy into a fixed accumulator (no
    // Buffer.concat — at 1080p that was hundreds of multi-MB copies per
    // second on the server's event loop). Completed frames swap into a
    // second fixed buffer; if inference is busy, newer frames overwrite it
    // (drop-oldest). Inference chains directly to the next pending frame
    // instead of waiting for another pipe chunk.
    const frameBytes = variant.size * variant.size * 3;
    this.chw = new Float32Array(3 * variant.size * variant.size);
    const assembling = Buffer.alloc(frameBytes);
    const latest = Buffer.alloc(frameBytes);
    let filled = 0;
    let pending = false;
    const maybeProcess = () => {
      if (this.#busy || !pending || gen !== this.#generation) return;
      pending = false;
      this.#busy = true;
      this.#processFrame(latest)
        .catch((err) => (this.state.error = err.message))
        .finally(() => {
          this.#busy = false;
          maybeProcess();
        });
    };
    this.#ffmpeg.stdout.on('data', (chunk) => {
      if (gen !== this.#generation) return;
      let offset = 0;
      while (offset < chunk.length) {
        const n = Math.min(frameBytes - filled, chunk.length - offset);
        chunk.copy(assembling, filled, offset, offset + n);
        filled += n;
        offset += n;
        if (filled === frameBytes) {
          filled = 0;
          assembling.copy(latest); // one bounded memcpy per frame
          pending = true;
        }
      }
      maybeProcess();
    });

    this.#ffmpeg.on('close', (code) => {
      if (gen !== this.#generation) return; // a newer run owns the state now
      this.state.running = false;
      this.tracks = [];
      if (this.sourceOpts.input) {
        this.state.error = code === 0 ? null : `ffmpeg exited (${code}): ${stderrTail.trim()}`;
        return; // file finished
      }
      // Camera loss (sleep/unplug): retry until stopped explicitly.
      this.state.error = `capture ended (${code}): ${stderrTail.trim() || 'camera lost'} — retrying`;
      clearTimeout(this.#retryTimer);
      this.#retryTimer = setTimeout(() => {
        if (gen === this.#generation) this.#boot().catch((err) => (this.state.error = err.message));
      }, 5000);
    });

    clearInterval(this.#flushTimer);
    this.#flushTimer = setInterval(() => {
      this.#flush();
      this.#refreshConfig(gen);
      const seconds = (Date.now() - (this.perfStart ?? Date.now())) / 1000 || 1;
      this.state.detPerSec = Math.round((this.perfCount ?? 0) / seconds);
      this.perfCount = 0;
      this.perfStart = Date.now();
    }, 2000);

    this.state.running = true;
  }

  #applyCountingConfig(config) {
    this.lastConfig = config;
    const frame = this.state.frame ?? { w: 1, h: 1 };
    const night = effectiveNight(config.sceneMode ?? 'auto', this.state.night ?? false);
    const tuning = trackingTuning(night);
    this.tracker ??= new Tracker();
    this.tracker.highThresh = (config.minScore ?? 0.5) * tuning.threshScale;
    this.tracker.minHits = tuning.minHits;
    this.tracker.smoothing = tuning.smoothing;
    this.tracker.maxAgeMs = tuning.maxAgeMs;
    this.classes = new Set(config.classes ?? ['car', 'truck', 'bus', 'motorcycle']);
    this.speedMatcher ??= new SpeedMatcher();
    this.speedMatcher.configure(config.speed ?? {});
    this.counters ??= new Map();
    const seen = new Set();
    for (const line of config.lines ?? []) {
      seen.add(line.id);
      let counter = this.counters.get(line.id);
      if (!counter) {
        counter = new LineCounter();
        this.counters.set(line.id, counter);
      }
      counter.hysteresis = Math.max(6, frame.h * 0.012) * tuning.hysteresisScale;
      const a = { x: line.a.x * frame.w, y: line.a.y * frame.h };
      const b = { x: line.b.x * frame.w, y: line.b.y * frame.h };
      const prev = counter.line;
      const same =
        prev && prev.a.x === a.x && prev.a.y === a.y && prev.b.x === b.x && prev.b.y === b.y;
      if (!same) counter.setLine({ a, b });
    }
    for (const id of [...this.counters.keys()]) if (!seen.has(id)) this.counters.delete(id);
    this.zones = (config.zones ?? [])
      .map((z) => z.points.map((p) => ({ x: p.x * frame.w, y: p.y * frame.h })))
      .filter((pts) => pts.length >= 3);
    this.zoneDims = zoneMaxDims(this.zones);
  }

  async #refreshConfig(gen = this.#generation) {
    try {
      const config = (await this.#getConfig()) ?? {};
      if (gen !== this.#generation) return;
      this.#applyCountingConfig(config);
      // View or model changes need a capture restart (crop/input geometry).
      const snapshot = JSON.stringify({ view: config.view, model: config.model });
      const changed = this.#configSnapshot !== null && snapshot !== this.#configSnapshot;
      this.#configSnapshot = snapshot;
      if (changed && this.state.running) {
        clearTimeout(this.#restartTimer);
        this.#restartTimer = setTimeout(() => {
          if (gen === this.#generation && this.state.running) {
            this.#ffmpeg?.kill('SIGTERM');
            this.#boot().catch((err) => (this.state.error = err.message));
          }
        }, 1200);
      }
    } catch {}
  }

  applyConfig() {
    // Public nudge from the server on PUT /api/config; cheap and debounced.
    this.#refreshConfig();
  }

  async #processFrame(rgb) {
    const t0 = performance.now();
    const size = this.inputSize;
    const plane = size * size;
    const chw = this.chw;
    // Scene brightness → night mode (with hysteresis; re-tunes on flip).
    const luma = meanLuma(rgb.subarray(0, this.contentBytes || rgb.length), 3);
    const wasNight = this.state.night ?? false;
    const night = effectiveNight(
      this.lastConfig?.sceneMode ?? 'auto',
      nightFromLuma(luma, wasNight)
    );
    if (night !== wasNight) {
      this.state.night = night;
      if (this.lastConfig) this.#applyCountingConfig(this.lastConfig);
    }
    this.state.night = night;
    for (let i = 0; i < plane; i++) {
      const p = i * 3;
      chw[i] = rgb[p + 2];
      chw[plane + i] = rgb[p + 1];
      chw[2 * plane + i] = rgb[p];
    }
    const tensor = new ort.Tensor('float32', chw, [1, 3, size, size]);
    const out = (await this.#session.run({ [this.inputName ?? (this.inputName = this.#session.inputNames[0])]: tensor }))[
      this.outputName ?? (this.outputName = this.#session.outputNames[0])
    ].data;
    this.state.detMs = Math.round(this.state.detMs * 0.9 + (performance.now() - t0) * 0.1);
    this.perfCount = (this.perfCount ?? 0) + 1;

    const now = Date.now();
    const viewArea = this.crop.w * this.crop.h;
    const detections = nms(decode(out, this.grids, 0.1))
      .map((d) => ({
        bbox: [
          this.crop.x + d.bbox[0] / this.scale,
          this.crop.y + d.bbox[1] / this.scale,
          d.bbox[2] / this.scale,
          d.bbox[3] / this.scale,
        ],
        class: YOLOX_CLASSES[d.classId],
        score: Math.min(1, d.score),
      }))
      .filter((d) => this.classes.has(d.class) && plausibleVehicle(d.bbox, viewArea, this.zoneDims));
    const inZone = this.zones.length
      ? detections.filter((d) => this.zones.some((poly) => pointInPolygon(boxCenter(d.bbox), poly)))
      : detections;
    const tracks = this.tracker.update(inZone, now);
    const liveIds = new Set(tracks.map((t) => t.id));
    for (const [lineId, counter] of this.counters) {
      for (const c of counter.update(tracks, now)) {
        const measured = this.speedMatcher.observe(c.trackId, lineId, c.ts);
        const track = tracks.find((t) => t.id === c.trackId);
        if (measured && track) {
          track.kmh = measured.kmh;
          track.over = measured.over;
        }
        this.#queue.push({
          ts: c.ts,
          direction: c.direction,
          class: c.class,
          confidence: Math.round(c.confidence * 1000) / 1000,
          trackId: c.trackId,
          line: lineId,
          source: 'engine',
          ...(measured ? { speed: measured.kmh, over: measured.over } : {}),
        });
        this.state.counted += 1;
      }
      counter.prune(liveIds);
    }
    this.speedMatcher.prune(liveIds);
    // Publish a lightweight track snapshot for the UI overlay. Velocities
    // (px/ms) let the client dead-reckon smooth motion between polls.
    // Tracks in their miss grace-period stay alive for re-association but
    // are NOT displayed — they would render as ghost boxes trailing cars.
    this.state.tracksTs = now;
    this.tracks = tracks.filter((t) => t.misses <= 2).map((t) => ({
      id: t.id,
      bbox: t.bbox,
      class: t.class,
      confirmed: t.confirmed,
      kmh: t.kmh,
      over: t.over,
      vx: t.vx,
      vy: t.vy,
      history: t.history.slice(-15).map((p) => ({ x: p.x, y: p.y })),
    }));
  }

  async #flush() {
    if (this.#queue.length === 0) return;
    const batch = this.#queue.splice(0, 200);
    try {
      await this.#postEvents(batch);
    } catch {
      this.#queue.unshift(...batch);
      if (this.#queue.length > 5000) this.#queue = this.#queue.slice(-5000);
    }
  }

  async stop() {
    this.#generation += 1; // invalidate every callback of the previous run
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#restartTimer);
    clearInterval(this.#flushTimer);
    this.#flushTimer = null;
    if (this.#ffmpeg) {
      this.#ffmpeg.kill('SIGTERM');
      this.#ffmpeg = null;
    }
    this.state.running = false;
    this.tracks = [];
    await this.#flush();
  }
}

function probeFile(file) {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  );
  const [w, h] = (res.stdout ?? '').trim().split(',').map(Number);
  if (!w || !h) throw new Error(`ffprobe could not read ${file}`);
  return { w, h };
}
