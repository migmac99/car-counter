import { listCameras, openCamera, openFile, stopSource, cameraSettings } from './camera.js';
import { Detector, VEHICLE_CLASSES, MODELS, availableModels } from './detector.js';
import { Tracker } from './tracker.js';
import { LineCounter } from './counter.js';
import { Overlay } from './overlay.js';
import { ShapeEditor } from './zones.js';
import {
  EventSink,
  fetchConfig,
  saveConfig,
  resetHistory,
  fetchPresets,
  fetchPreset,
  savePreset,
  deletePreset,
  fetchEngine,
  setEngine,
} from './api.js';
import { StatsUi } from './stats-ui.js';
import { SpeedMatcher } from './speed.js';
import { pointInPolygon, boxCenter, zoneMaxDims, plausibleVehicle } from './geometry.js';
import { nightFromLuma, effectiveNight, trackingTuning, meanLuma } from './scene.js';

const $ = (id) => document.getElementById(id);

const refs = {
  status: $('status'),
  perf: $('perf'),
  video: $('video'),
  videoWrap: $('video-wrap'),
  videoStage: $('video-stage'),
  videoHint: $('video-hint'),
  overlay: $('overlay'),
  preview: $('preview'),
  engineBtn: $('engine-btn'),
  engineSettings: $('engine-settings'),
  engineDevice: $('engine-device'),
  cameraSelect: $('camera-select'),
  startBtn: $('start-btn'),
  stopBtn: $('stop-btn'),
  fileInput: $('file-input'),
  drawLineBtn: $('draw-line-btn'),
  addLanesBtn: $('add-lanes-btn'),
  flipBtn: $('flip-btn'),
  drawRoiBtn: $('draw-roi-btn'),
  autoRoadBtn: $('auto-road-btn'),
  deleteShapeBtn: $('delete-shape-btn'),
  engineSize: $('engine-size'),
  gateA: $('gate-a'),
  gateB: $('gate-b'),
  gateMeters: $('gate-meters'),
  speedLimit: $('speed-limit'),
  zoom: $('zoom'),
  zoomValue: $('zoom-value'),
  minScore: $('min-score'),
  minScoreValue: $('min-score-value'),
  modelSelect: $('model-select'),
  sceneMode: $('scene-mode'),
  classFilters: $('class-filters'),
  countModeSel: $('count-mode'),
  presetSelect: $('preset-select'),
  presetSave: $('preset-save'),
  presetDelete: $('preset-delete'),
  exportConfig: $('export-config'),
  importConfig: $('import-config'),
  resetData: $('reset-data'),
  reloadBtn: $('reload-btn'),
  installBtn: $('install-btn'),
  // stats
  tileCpm: $('tile-cpm'),
  tileRate5: $('tile-rate5'),
  tileHour: $('tile-hour'),
  tileToday: $('tile-today'),
  tileTotal: $('tile-total'),
  tileSpeed: $('tile-speed'),
  tileSpeedWrap: $('tile-speed-wrap'),
  tileOver: $('tile-over'),
  tileOverWrap: $('tile-over-wrap'),
  speedHistory: $('speed-history'),
  speedChart: $('speed-chart'),
  dirFwd: $('dir-fwd'),
  dirRev: $('dir-rev'),
  sparkline: $('sparkline'),
  bucketSeg: $('bucket-seg'),
  rangeSelect: $('range-select'),
  historyChart: $('history-chart'),
  historyTable: $('history-table'),
};

// Shapes are stored normalized (0..1) so they survive resolution changes.
const state = {
  running: false,
  lines: [], // [{id, a: {x,y}, b: {x,y}}] normalized
  zones: [], // [{id, points: [{x,y}, ...]}] normalized
  minScore: 0.5,
  classes: [...VEHICLE_CLASSES],
  countMode: 'both',
  view: { z: 1, cx: 0.5, cy: 0.5 }, // digital zoom + pan center, normalized
  cameraId: '',
  wasRunning: false, // camera was live when the page last closed
  historyView: null, // {bucket, rangeMs}
  speed: { gateA: '', gateB: '', meters: 0, limitKmh: 0 },
  model: 'yolox-tiny',
  sceneMode: 'auto', // 'auto' | 'day' | 'night'
};
let measuredNight = false;

const detector = new Detector();
const tracker = new Tracker();
const counters = new Map(); // line id -> LineCounter
const overlay = new Overlay(refs.overlay);
const sink = new EventSink();
const speedMatcher = new SpeedMatcher();
let statsUi = null; // constructed in boot, after the saved config is loaded

function setStatus(text, running = state.running) {
  refs.status.textContent = text;
  refs.status.classList.toggle('running', running);
}

// --- server engine state (the UI is a window onto the server when it runs) ---
let engineStatus = null; // last /api/engine payload
const engineRunning = () => Boolean(engineStatus?.running);

// --- coordinate helpers ---
const videoSize = () => ({ w: refs.video.videoWidth, h: refs.video.videoHeight });

/** Working frame dimensions: the engine's source when it counts, else the local video. */
function frameSize() {
  if (engineRunning() && engineStatus.frame) return engineStatus.frame;
  return videoSize();
}

function toPixels(norm) {
  const { w, h } = frameSize();
  if (!w) return null;
  return { x: norm.x * w, y: norm.y * h };
}

function toNorm(p) {
  const { w, h } = frameSize();
  return { x: p.x / w, y: p.y / h };
}

function shapesToPixels() {
  const { w } = frameSize();
  if (!w) return { lines: [], zones: [] };
  return {
    lines: state.lines.map((l) => ({ id: l.id, a: toPixels(l.a), b: toPixels(l.b) })),
    zones: state.zones.map((z) => ({ id: z.id, points: z.points.map(toPixels) })),
  };
}

/** Adopt the editor's pixel-space shapes as the new normalized truth. */
function adoptShapes(px) {
  const { w } = frameSize();
  if (!w) return;
  state.lines = px.lines.map((l) => ({ id: l.id, a: toNorm(l.a), b: toNorm(l.b) }));
  state.zones = px.zones.map((z) => ({ id: z.id, points: z.points.map(toNorm) }));
  syncCounters();
  refreshGateOptions();
  persistConfig();
  setStatus(state.running ? (state.lines.length ? 'counting' : 'running — add a counting line') : refs.status.textContent);
}

// --- speed gates ---
function refreshGateOptions() {
  for (const [sel, chosen] of [
    [refs.gateA, state.speed.gateA],
    [refs.gateB, state.speed.gateB],
  ]) {
    sel.innerHTML =
      '<option value="">—</option>' +
      state.lines.map((l, i) => `<option value="${l.id}">L${i + 1}</option>`).join('');
    sel.value = state.lines.some((l) => l.id === chosen) ? chosen : '';
  }
}

function applySpeedConfig() {
  speedMatcher.configure(state.speed);
  refs.gateMeters.value = state.speed.meters || '';
  refs.speedLimit.value = state.speed.limitKmh || '';
  refreshGateOptions();
}

function onSpeedSettingsChange() {
  state.speed = {
    gateA: refs.gateA.value,
    gateB: refs.gateB.value,
    meters: Number(refs.gateMeters.value) || 0,
    limitKmh: Number(refs.speedLimit.value) || 0,
  };
  speedMatcher.configure(state.speed);
  persistConfig();
  statsUi?.refreshSummary();
}
for (const el of ['gateA', 'gateB', 'gateMeters', 'speedLimit']) {
  refs[el].addEventListener('change', onSpeedSettingsChange);
}

const nightActive = () => effectiveNight(state.sceneMode, measuredNight);

/** Apply scene-appropriate tracking parameters (day vs night blobs). */
function applySceneTuning() {
  const t = trackingTuning(nightActive());
  tracker.minHits = t.minHits;
  tracker.smoothing = t.smoothing;
  tracker.maxAgeMs = t.maxAgeMs;
  tracker.highThresh = state.minScore * t.threshScale;
  syncCounters();
}

/** Keep one LineCounter per line; reset crossing state only when geometry moves. */
function syncCounters() {
  const { h } = videoSize();
  const hysteresis = Math.max(6, (h || 720) * 0.012) * trackingTuning(nightActive()).hysteresisScale;
  const seen = new Set();
  for (const l of state.lines) {
    seen.add(l.id);
    let counter = counters.get(l.id);
    if (!counter) {
      counter = new LineCounter();
      counters.set(l.id, counter);
    }
    counter.hysteresis = hysteresis;
    const a = toPixels(l.a);
    const b = toPixels(l.b);
    const line = a && b ? { a, b } : null;
    const prev = counter.line;
    const same =
      prev && line &&
      prev.a.x === line.a.x && prev.a.y === line.a.y &&
      prev.b.x === line.b.x && prev.b.y === line.b.y;
    if (!same) counter.setLine(line);
  }
  for (const id of [...counters.keys()]) if (!seen.has(id)) counters.delete(id);
}

// --- config persistence (server-side, mirrored locally for offline) ---
function currentConfig() {
  return {
    lines: state.lines,
    zones: state.zones,
    minScore: state.minScore,
    classes: state.classes,
    countMode: state.countMode,
    view: { ...state.view },
    cameraId: state.cameraId,
    wasRunning: state.wasRunning,
    historyView: state.historyView,
    speed: { ...state.speed },
    model: state.model,
    sceneMode: state.sceneMode,
  };
}

function persistConfig() {
  const config = currentConfig();
  saveConfig(config);
  try {
    localStorage.setItem('car-counter.config', JSON.stringify(config));
  } catch {}
}

function applyConfig(config) {
  if (!config) return;
  // Migrate the single-line/single-zone schema of earlier versions.
  state.lines = Array.isArray(config.lines)
    ? config.lines
    : config.line
      ? [{ id: 'line-legacy', ...config.line }]
      : [];
  state.zones = Array.isArray(config.zones)
    ? config.zones
    : Array.isArray(config.roi) && config.roi.length >= 3
      ? [{ id: 'zone-legacy', points: config.roi }]
      : [];
  state.minScore = config.minScore ?? 0.5;
  state.classes = Array.isArray(config.classes) && config.classes.length ? config.classes : [...VEHICLE_CLASSES];
  state.countMode = config.countMode ?? 'both';
  state.view = { z: 1, cx: 0.5, cy: 0.5, ...config.view };
  state.cameraId = config.cameraId ?? '';
  state.wasRunning = config.wasRunning ?? false;
  state.historyView = config.historyView ?? null;
  state.speed = { gateA: '', gateB: '', meters: 0, limitKmh: 0, ...config.speed };
  state.model = MODELS[config.model] ? config.model : 'yolox-tiny';
  state.sceneMode = ['auto', 'day', 'night'].includes(config.sceneMode) ? config.sceneMode : 'auto';
  applySpeedConfig();
  refs.minScore.value = state.minScore;
  refs.modelSelect.value = state.model;
  refs.sceneMode.value = state.sceneMode;
  applySceneTuning();
  refs.minScoreValue.textContent = state.minScore.toFixed(2);
  refs.countModeSel.value = state.countMode;
  for (const box of refs.classFilters.querySelectorAll('input')) {
    box.checked = state.classes.includes(box.value);
  }
  syncCounters();
  applyView();
  editor.setShapes(shapesToPixels());
}

async function loadConfig() {
  try {
    applyConfig(await fetchConfig());
  } catch {
    try {
      applyConfig(JSON.parse(localStorage.getItem('car-counter.config')));
    } catch {}
  }
}

// --- digital zoom + pan ---
// The view is a CSS scale on the video+overlay stage; detection runs on the
// visible crop only (see detectionSource), so what you see is exactly what
// the model sees — and zooming genuinely improves recall on small/far
// vehicles. Shape coordinates stay in full-frame space.

function applyView() {
  const view = state.view;
  view.z = Math.max(1, Math.min(10, view.z));
  const stage = refs.videoStage;
  if (engineRunning()) {
    // The server's preview already contains the zoomed view at full preview
    // resolution — CSS-zooming it again would double-apply the crop.
    stage.style.transform = '';
    stage.style.transformOrigin = '';
    refs.zoom.value = view.z;
    refs.zoomValue.textContent = `${view.z}×`;
    refs.videoWrap.classList.toggle('zoomed', false);
    return;
  }
  if (view.z === 1) {
    stage.style.transform = '';
    stage.style.transformOrigin = '';
  } else {
    const half = 1 / (2 * view.z);
    view.cx = Math.min(1 - half, Math.max(half, view.cx));
    view.cy = Math.min(1 - half, Math.max(half, view.cy));
    // transform-origin o such that the visible window is centered on (cx, cy)
    const ox = (view.cx - half) / (1 - 1 / view.z);
    const oy = (view.cy - half) / (1 - 1 / view.z);
    stage.style.transformOrigin = `${ox * 100}% ${oy * 100}%`;
    stage.style.transform = `scale(${view.z})`;
  }
  refs.zoom.value = view.z;
  refs.zoomValue.textContent = `${view.z}×`;
  refs.videoWrap.classList.toggle('zoomed', view.z > 1);
}

refs.zoom.addEventListener('input', () => {
  state.view.z = Number(refs.zoom.value);
  applyView();
  persistConfig();
});

/** Visible-region origin in video pixels (0,0 at 1×), zoom factor and frame size. */
function viewRect() {
  const { w, h } = frameSize();
  const { z, cx, cy } = state.view;
  if (z <= 1 || !w) return { z: 1, visX: 0, visY: 0, vw: w, vh: h };
  return {
    z,
    visX: (cx - 1 / (2 * z)) * w,
    visY: (cy - 1 / (2 * z)) * h,
    vw: w,
    vh: h,
  };
}

let cropCanvas = null;

// Cap the detection crop at the model's own input size: anything larger only
// costs upload/resample time, and matching it avoids a second resampling
// pass (1080p → cap → model input becomes one draw).
const detectCap = () => detector.inputSize;

/**
 * The frame source for the detector: the visible crop (what you see is what
 * the model sees), down-scaled to the detection budget. Returns the mapping
 * back to full-frame pixels: bboxFull = {x,y} + bboxDetected × invScale.
 */
function detectionSource() {
  const { z, cx, cy } = state.view;
  const { w, h } = videoSize();
  const zoomed = z > 1;
  const cw = zoomed ? Math.round(w / z) : w;
  const ch = zoomed ? Math.round(h / z) : h;
  const x = zoomed ? Math.round(Math.min(w - cw, Math.max(0, cx * w - cw / 2))) : 0;
  const y = zoomed ? Math.round(Math.min(h - ch, Math.max(0, cy * h - ch / 2))) : 0;
  const scale = Math.min(1, detectCap() / Math.max(cw, ch));
  if (!zoomed && scale === 1) return { source: refs.video, x: 0, y: 0, invScale: 1 };
  const dw = Math.max(1, Math.round(cw * scale));
  const dh = Math.max(1, Math.round(ch * scale));
  cropCanvas ??= document.createElement('canvas');
  if (cropCanvas.width !== dw || cropCanvas.height !== dh) {
    cropCanvas.width = dw;
    cropCanvas.height = dh;
  }
  cropCanvas.getContext('2d').drawImage(refs.video, x, y, cw, ch, 0, 0, dw, dh);
  return { source: cropCanvas, x, y, invScale: cw / dw };
}

// --- shape editing ---
const editor = new ShapeEditor(refs.overlay, {
  onChange: adoptShapes,
  onSelect(selection) {
    refs.deleteShapeBtn.disabled = !selection;
  },
  onModeChange(mode) {
    refs.videoWrap.classList.toggle('editing', mode !== null);
    refs.drawLineBtn.classList.toggle('active', mode === 'line');
    refs.drawRoiBtn.classList.toggle('active', mode === 'zone');
  },
  // Drags that hit no shape pan the zoomed view. The overlay is not CSS
  // -scaled, so screen px map to view px via rect size × zoom.
  onPan(dxPx, dyPx, rect) {
    if (state.view.z <= 1) return;
    state.view.cx += dxPx / (rect.width * state.view.z);
    state.view.cy += dyPx / (rect.height * state.view.z);
    applyView();
  },
  onPanEnd: persistConfig,
  getView: viewRect,
});

// --- auto-detect road ---
// Watches confirmed track trajectories for a few seconds, then derives the
// dominant travel axis (double-angle mean handles two-way traffic), a road
// zone around the observed motion band, and a counting line across it.
let autoRoad = null; // { paths: Map(trackId -> points), startedAt }

refs.autoRoadBtn.addEventListener('click', () => {
  if (autoRoad) {
    autoRoad = null;
    refs.autoRoadBtn.classList.remove('active');
    setStatus(state.running ? 'counting' : 'stopped');
    return;
  }
  if (!requireVideo() || !state.running) {
    setStatus('start a camera or video first', false);
    return;
  }
  autoRoad = { paths: new Map(), startedAt: Date.now() };
  refs.autoRoadBtn.classList.add('active');
  setStatus('mapping the road — let some traffic pass…');
});

function collectAutoRoad(tracks) {
  const { w, h } = videoSize();
  for (const t of tracks) {
    if (!t.confirmed) continue;
    // Track full lifetime displacement (the history buffer is a short window).
    const path = autoRoad.paths.get(t.id) ?? { first: { x: t.cx, y: t.cy }, pts: [] };
    path.last = { x: t.cx, y: t.cy };
    if (path.pts.length < 400) path.pts.push(path.last);
    autoRoad.paths.set(t.id, path);
  }
  const minTravel = Math.hypot(w, h) * 0.1;
  const moves = [...autoRoad.paths.values()]
    .map((p) => ({ dx: p.last.x - p.first.x, dy: p.last.y - p.first.y }))
    .filter((d) => Math.hypot(d.dx, d.dy) >= minTravel);
  const elapsed = Date.now() - autoRoad.startedAt;
  if (moves.length >= 3 && elapsed > 4000) {
    finishAutoRoad(moves);
  } else if (elapsed > 30_000) {
    autoRoad = null;
    refs.autoRoadBtn.classList.remove('active');
    setStatus('no traffic seen in 30 s — draw the road manually');
  }
}

function finishAutoRoad(moves) {
  const { w, h } = videoSize();
  // Dominant travel axis via the double-angle trick (opposing directions agree).
  let c2 = 0;
  let s2 = 0;
  for (const m of moves) {
    const th = Math.atan2(m.dy, m.dx);
    c2 += Math.cos(2 * th);
    s2 += Math.sin(2 * th);
  }
  const axis = Math.atan2(s2, c2) / 2;
  const u = { x: Math.cos(axis), y: Math.sin(axis) };
  const v = { x: -u.y, y: u.x };
  const pts = [...autoRoad.paths.values()].flatMap((p) => p.pts);
  const us = pts.map((p) => p.x * u.x + p.y * u.y);
  const vs = pts.map((p) => p.x * v.x + p.y * v.y);
  const [u0, u1] = [Math.min(...us), Math.max(...us)];
  let [v0, v1] = [Math.min(...vs), Math.max(...vs)];
  const vm = Math.max(12, (v1 - v0) * 0.2);
  v0 -= vm;
  v1 += vm;
  const clamp = (p) => ({ x: Math.min(w, Math.max(0, p.x)), y: Math.min(h, Math.max(0, p.y)) });
  const at = (uu, vv) => clamp({ x: uu * u.x + vv * v.x, y: uu * u.y + vv * v.y });
  const id = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

  const px = shapesToPixels();
  px.zones.push({ id: id('zone'), points: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)] });
  const mid = (u0 + u1) / 2;
  px.lines.push({ id: id('line'), a: at(mid, v0), b: at(mid, v1) });
  editor.setShapes(px);
  adoptShapes(px);
  autoRoad = null;
  refs.autoRoadBtn.classList.remove('active');
  setStatus('road mapped — adjust the zone and line as needed');
}

// --- detection loop ---
let detecting = false;

// Rolling performance counters, reported in the header perf chip.
const perf = { detMs: 0, detCount: 0, camFrames: 0, windowStart: performance.now() };

async function step(now) {
  if (!state.running || refs.video.readyState < 2 || !detector.ready || detecting) return;
  detecting = true;
  try {
    const src = detectionSource();
    const t0 = performance.now();
    const detected = await detector.detect(src.source, { classes: state.classes });
    if (!detected) return;
    perf.detMs = perf.detMs * 0.9 + (performance.now() - t0) * 0.1;
    perf.detCount += 1;
    const detections =
      src.invScale !== 1 || src.x || src.y
        ? detected.map((d) => ({
            ...d,
            bbox: [
              src.x + d.bbox[0] * src.invScale,
              src.y + d.bbox[1] * src.invScale,
              d.bbox[2] * src.invScale,
              d.bbox[3] * src.invScale,
            ],
          }))
        : detected;
    const zonePolys = state.zones
      .map((z) => z.points.map(toPixels))
      .filter((pts) => pts.length >= 3 && pts.every(Boolean));
    const { w: fw, h: fh } = frameSize();
    const viewArea = (fw * fh) / (state.view.z * state.view.z);
    const maxDims = zoneMaxDims(zonePolys);
    const sane = detections.filter((d) => plausibleVehicle(d.bbox, viewArea, maxDims));
    const inZone = zonePolys.length
      ? sane.filter((d) => zonePolys.some((poly) => pointInPolygon(boxCenter(d.bbox), poly)))
      : sane;
    const tracks = tracker.update(inZone, now);
    const liveIds = new Set(tracks.map((t) => t.id));
    if (autoRoad) collectAutoRoad(tracks);
    for (const [lineId, counter] of counters) {
      const crossings = counter.update(tracks, now);
      counter.prune(liveIds);
      for (const c of crossings) {
        const track = tracks.find((t) => t.id === c.trackId);
        const measured = speedMatcher.observe(c.trackId, lineId, c.ts);
        if (measured && track) {
          track.kmh = measured.kmh;
          track.over = measured.over;
        }
        sink.record({
          ts: c.ts,
          direction: c.direction,
          class: c.class,
          confidence: Math.round(c.confidence * 1000) / 1000,
          trackId: c.trackId,
          line: lineId,
          ...(measured ? { speed: measured.kmh, over: measured.over } : {}),
        });
        statsUi?.bump(c.direction);
        if (track) overlay.addPulse(track.cx, track.cy, c.direction);
      }
    }
    speedMatcher.prune(liveIds);
  } finally {
    detecting = false;
  }
}

// Pace detection to actual video frames when the browser supports it — no
// wasted inference on duplicate frames, and camera fps becomes measurable.
const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
let rvfcToken = 0;

function startDetectionLoop() {
  if (!HAS_RVFC) return; // rAF fallback in frame()
  const token = ++rvfcToken;
  const onFrame = () => {
    if (token !== rvfcToken) return;
    perf.camFrames += 1;
    step(Date.now());
    refs.video.requestVideoFrameCallback(onFrame);
  };
  refs.video.requestVideoFrameCallback(onFrame);
}

// Hidden-tab backstop: rAF/rVFC stop when the tab is not visible, but the
// camera keeps capturing. A coarse timer keeps counting at the browser's
// throttled background rate (~1 tick/s) — reduced fidelity, not zero.
setInterval(() => {
  if (document.hidden && state.running) step(Date.now());
}, 500);

let lumaCanvas = null;

/** Sample the current frame's brightness (cheap 24×14 read, every chip tick). */
function sampleLuma() {
  if (!state.running || refs.video.readyState < 2) return;
  lumaCanvas ??= document.createElement('canvas');
  lumaCanvas.width = 24;
  lumaCanvas.height = 14;
  const ctx = lumaCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(refs.video, 0, 0, 24, 14);
  const { data } = ctx.getImageData(0, 0, 24, 14);
  const wasNight = nightActive();
  measuredNight = nightFromLuma(meanLuma(data, 4), measuredNight);
  if (nightActive() !== wasNight) applySceneTuning();
}

function updatePerfChip() {
  if (engineRunning()) {
    const s = engineStatus;
    const night = s.night ? ' · night' : '';
    const cam = s.camFps != null ? ` cam ${s.camFps}/s ·` : '';
    refs.perf.textContent = `${s.frame.w}×${s.frame.h} ·${cam} det ${s.detPerSec}/s · ${s.detMs} ms · ${s.ep} (server)${night}`;
    refs.perf.hidden = false;
    // Low camera fps at night is exposure physics; flag it only in daylight.
    refs.perf.classList.toggle('warn', !s.night && s.camFps > 0 && s.camFps < 15);
    return;
  }
  sampleLuma();
  const now = performance.now();
  const seconds = (now - perf.windowStart) / 1000;
  perf.windowStart = now;
  if (!state.running || seconds <= 0) {
    refs.perf.hidden = true;
    perf.detCount = 0;
    perf.camFrames = 0;
    return;
  }
  const camFps = HAS_RVFC ? Math.round(perf.camFrames / seconds) : null;
  const detPerSec = Math.round(perf.detCount / seconds);
  perf.detCount = 0;
  perf.camFrames = 0;
  const cam = cameraSettings(refs.video);
  const size = cam ? `${cam.width}×${cam.height}` : `${refs.video.videoWidth}×${refs.video.videoHeight}`;
  const fpsText = camFps != null ? ` @${camFps}` : '';
  const ep = detector.backendInfo ? ` · ${detector.backendInfo}` : '';
  const night = nightActive() ? ' · night' : '';
  refs.perf.textContent = `${size}${fpsText} · det ${detPerSec}/s · ${Math.max(1, Math.round(perf.detMs))} ms${ep}${night}`;
  refs.perf.hidden = false;
  // A camera below ~15 fps (long exposure in low light, USB bandwidth) blurs
  // motion and starves the tracker — flag it.
  refs.perf.classList.toggle('warn', camFps != null && camFps > 0 && camFps < 15);
}
setInterval(updatePerfChip, 2000);

// Engine tracks arrive a few hundred ms stale (poll + preview latency);
// dead-reckoning them with their server-computed velocities keeps the boxes
// glued to the cars at full display frame rate.
const ENGINE_DISPLAY_LAG_MS = 250;

function engineTracksNow() {
  const tracks = engineStatus.tracks ?? [];
  const ts = engineStatus.tracksTs;
  if (!ts) return tracks;
  const dt = Math.max(-500, Math.min(900, Date.now() - ts - ENGINE_DISPLAY_LAG_MS));
  return tracks.map((t) => ({
    ...t,
    bbox: [t.bbox[0] + (t.vx ?? 0) * dt, t.bbox[1] + (t.vy ?? 0) * dt, t.bbox[2], t.bbox[3]],
  }));
}

function frame() {
  overlay.resize();
  if (!HAS_RVFC) step(Date.now());
  overlay.draw({
    tracks: engineRunning() ? engineTracksNow() : state.running ? tracker.tracks : [],
    lines: editor.shapes.lines,
    zones: editor.shapes.zones,
    selection: editor.selection,
    view: viewRect(),
    editing: editor.mode
      ? { mode: editor.mode, points: editor.points, cursor: editor.cursor }
      : null,
  });
  requestAnimationFrame(frame);
}

// --- source control ---
async function refreshCameraList() {
  try {
    const cams = await listCameras();
    const current = refs.cameraSelect.value || state.cameraId;
    refs.cameraSelect.innerHTML =
      '<option value="">Default camera</option>' +
      cams
        .map((c, i) => `<option value="${c.deviceId}">${c.label || `Camera ${i + 1}`}</option>`)
        .join('');
    refs.cameraSelect.value = current;
    if (refs.cameraSelect.value !== current) refs.cameraSelect.value = ''; // saved camera unplugged
  } catch {}
}

function sourceStarted() {
  state.running = true;
  refs.videoHint.hidden = true;
  refs.stopBtn.disabled = false;
  syncCounters();
  editor.setShapes(shapesToPixels());
  startDetectionLoop();
  setStatus(state.lines.length ? 'counting' : 'running — add a counting line');
}

let reconnectTimer = null;

// Cameras drop after system sleep or a USB hiccup; track.stop() does NOT
// fire 'ended', so this only reacts to genuine external loss.
function scheduleCameraReconnect(attempt = 1) {
  clearTimeout(reconnectTimer);
  if (attempt > 40) {
    setStatus('camera lost — click Start camera', false);
    return;
  }
  setStatus(`camera lost — reconnecting (try ${attempt})…`, false);
  reconnectTimer = setTimeout(async () => {
    try {
      await startCamera();
    } catch {
      scheduleCameraReconnect(attempt + 1);
    }
    if (!state.running) scheduleCameraReconnect(attempt + 1);
  }, 3000);
}

async function startCamera() {
  try {
    setStatus('opening camera…');
    const stream = await openCamera(refs.video, refs.cameraSelect.value || undefined);
    sourceStarted();
    state.cameraId = refs.cameraSelect.value;
    state.wasRunning = true; // so the next visit resumes counting automatically
    persistConfig();
    refreshCameraList(); // labels become available after permission
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (!state.wasRunning) return;
      state.running = false;
      scheduleCameraReconnect();
    });
  } catch (err) {
    setStatus('camera unavailable', false);
    refs.videoHint.hidden = false;
    refs.videoHint.textContent =
      `Could not open the camera (${err.name ?? err.message}). ` +
      'Check permissions — camera access needs localhost or HTTPS.';
  }
}

refs.startBtn.addEventListener('click', startCamera);

refs.fileInput.addEventListener('change', async () => {
  const file = refs.fileInput.files?.[0];
  if (!file) return;
  await openFile(refs.video, file);
  sourceStarted();
});

refs.stopBtn.addEventListener('click', () => {
  state.running = false;
  state.wasRunning = false;
  clearTimeout(reconnectTimer);
  rvfcToken += 1; // end the frame-paced detection chain
  refs.perf.hidden = true;
  persistConfig();
  stopSource(refs.video);
  refs.stopBtn.disabled = true;
  refs.videoHint.hidden = false;
  refs.videoHint.textContent = 'Stopped. Start a camera or open a video file to continue counting.';
  setStatus('stopped', false);
  sink.flush();
});

// --- server engine control ---
let previewTimer = null;

function applyEngineUi() {
  const running = engineRunning();
  document.body.classList.toggle('engine-mode', running);
  refs.preview.hidden = !running;
  refs.engineBtn.textContent = running ? 'Stop server counting' : 'Start server counting';
  refs.engineBtn.classList.toggle('active', running);
  clearInterval(previewTimer);
  if (running) {
    // The engine owns the camera now — a still-running local pipeline would
    // double-count every car.
    if (state.running || refs.video.srcObject) {
      state.running = false;
      state.wasRunning = false;
      rvfcToken += 1;
      stopSource(refs.video);
      persistConfig();
    }
    refs.videoHint.hidden = true;
    setStatus(state.lines.length ? 'counting (server)' : 'server engine on — add a counting line', true);
    // Push stream (MJPEG) — much lower latency than polling. If the stream
    // errors (proxy stripping it, etc.), fall back to polling snapshots.
    refs.preview.onerror = () => {
      refs.preview.onerror = null;
      clearInterval(previewTimer);
      previewTimer = setInterval(() => {
        refs.preview.src = `/api/preview?t=${Date.now()}`;
      }, 250);
    };
    refs.preview.src = '/api/preview.mjpeg';
    editor.setShapes(shapesToPixels());
    applyView(); // preview arrives pre-zoomed; drop the CSS transform
  } else {
    refs.preview.onerror = null;
    refs.preview.removeAttribute('src'); // close the MJPEG stream
    if (!state.running) {
      refs.videoHint.hidden = false;
      setStatus('ready — start a camera', false);
      // The browser becomes the fallback counter; load its model if needed.
      if (!detector.ready) loadModel(state.model).catch(() => {});
    }
  }
}

let lastEngineError = null;

async function pollEngine() {
  try {
    const next = await fetchEngine();
    const changed = Boolean(next.running) !== engineRunning();
    engineStatus = next.available === false ? null : next;
    if (changed) applyEngineUi();
    // Engine problems must be VISIBLE — a silent retry loop reads as
    // "nothing works". Camera-permission failures get remediation text.
    const error = engineStatus?.error ?? null;
    if (error !== lastEngineError) {
      lastEngineError = error;
      if (error) {
        setStatus(`engine: ${error.slice(0, 80)}`, false);
        refs.status.classList.add('warn');
        if (/capture|camera|avfoundation|permission/i.test(error)) {
          refs.videoHint.hidden = false;
          refs.videoHint.textContent =
            'The server cannot read the camera. On macOS, grant camera access to the terminal ' +
            'that runs the server (System Settings → Privacy & Security → Camera), then try again. ' +
            'Check the camera choice under Settings → Engine camera.';
        }
      } else {
        refs.status.classList.remove('warn');
        if (engineRunning()) applyEngineUi();
      }
    }
  } catch {}
}

refs.engineBtn.addEventListener('click', async () => {
  refs.engineBtn.disabled = true;
  try {
    engineStatus = await setEngine({
      running: !engineRunning(),
      device: refs.engineDevice.value || '0',
      size: refs.engineSize.value || '1920x1080',
    });
    applyEngineUi();
  } catch (err) {
    alert(`Engine: ${err.message}`);
  } finally {
    refs.engineBtn.disabled = false;
  }
});

// --- toolbar ---
function requireVideo() {
  if (frameSize().w) return true;
  setStatus('start a camera or video first (or the server engine)', false);
  return false;
}

refs.drawLineBtn.addEventListener('click', () => {
  if (editor.mode === 'line') editor.cancel();
  else if (requireVideo()) editor.start('line');
});
refs.addLanesBtn.addEventListener('click', () => {
  if (editor.mode === 'line') {
    editor.cancel();
    return;
  }
  if (!requireVideo()) return;
  const n = Number(prompt('How many lanes? Draw ONE line across the whole road; it will be split into per-lane counting lines.', '2'));
  if (!Number.isInteger(n) || n < 2 || n > 12) return;
  editor.laneSplit = n;
  editor.start('line');
});
refs.drawRoiBtn.addEventListener('click', () => {
  if (editor.mode === 'zone') editor.cancel();
  else if (requireVideo()) editor.start('zone');
});
refs.deleteShapeBtn.addEventListener('click', () => editor.deleteSelection());
refs.flipBtn.addEventListener('click', () => editor.flipTargetLine());

// --- settings ---
refs.minScore.addEventListener('input', () => {
  state.minScore = Number(refs.minScore.value);
  refs.minScoreValue.textContent = state.minScore.toFixed(2);
  applySceneTuning(); // sets the ByteTrack stage-1 threshold scene-aware
  persistConfig();
});

refs.sceneMode.addEventListener('change', () => {
  state.sceneMode = refs.sceneMode.value;
  applySceneTuning();
  persistConfig();
});

// --- detection model selection ---
async function loadModel(name) {
  try {
    await detector.init(name, (text) => setStatus(text, false));
    setStatus(state.running ? (state.lines.length ? 'counting' : 'running — add a counting line') : 'ready — start a camera');
    return true;
  } catch (err) {
    console.error(err);
    setStatus(`could not load ${MODELS[name]?.label ?? name}`, false);
    return false;
  }
}

async function populateModelSelect() {
  const available = await availableModels();
  refs.modelSelect.innerHTML = Object.entries(MODELS)
    .map(([name, m]) => `<option value="${name}" ${available[name] ? '' : 'disabled'}>${m.label}${available[name] ? '' : ' — run setup'}</option>`)
    .join('');
  if (!available[state.model]) state.model = 'coco-ssd';
  refs.modelSelect.value = state.model;
}

refs.modelSelect.addEventListener('change', async () => {
  const previous = state.model;
  state.model = refs.modelSelect.value;
  persistConfig();
  if (!(await loadModel(state.model))) {
    state.model = previous;
    refs.modelSelect.value = previous;
    await loadModel(previous);
  }
});
refs.classFilters.addEventListener('change', () => {
  state.classes = [...refs.classFilters.querySelectorAll('input:checked')].map((b) => b.value);
  persistConfig();
});
refs.countModeSel.addEventListener('change', () => {
  state.countMode = refs.countModeSel.value;
  persistConfig();
  statsUi?.refreshSummary();
  statsUi?.refreshHistory();
});
refs.resetData.addEventListener('click', async () => {
  if (!confirm('Delete ALL recorded counts from the server? This cannot be undone.')) return;
  await resetHistory();
  statsUi?.refreshSummary();
  statsUi?.refreshHistory();
});

// --- presets (named configs stored on the server) ---
async function refreshPresets(selected = '') {
  try {
    const { presets } = await fetchPresets();
    refs.presetSelect.innerHTML =
      '<option value="">—</option>' +
      presets.map((p) => `<option value="${p.name}">${p.name}</option>`).join('');
    refs.presetSelect.value = selected;
  } catch {}
}

refs.presetSave.addEventListener('click', async () => {
  const name = prompt('Save current setup (lines, zones, zoom, settings) as:', refs.presetSelect.value || 'default');
  if (!name?.trim()) return;
  try {
    await savePreset(name.trim(), currentConfig());
    await refreshPresets(name.trim());
  } catch (err) {
    alert(`Could not save preset: ${err.message}`);
  }
});

refs.presetSelect.addEventListener('change', async () => {
  const name = refs.presetSelect.value;
  if (!name) return;
  try {
    applyConfig(await fetchPreset(name));
    persistConfig(); // the loaded preset becomes the active config
    if (state.historyView) statsUi?.setView(state.historyView.bucket, state.historyView.rangeMs);
  } catch {
    alert('Could not load that preset.');
  }
});

refs.presetDelete.addEventListener('click', async () => {
  const name = refs.presetSelect.value;
  if (!name || !confirm(`Delete preset "${name}"?`)) return;
  await deletePreset(name);
  refreshPresets();
});

// --- config export / import (file-based, alongside server presets) ---
refs.exportConfig.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(currentConfig(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'car-counter-config.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

refs.importConfig.addEventListener('change', async () => {
  const file = refs.importConfig.files?.[0];
  refs.importConfig.value = '';
  if (!file) return;
  try {
    applyConfig(JSON.parse(await file.text()));
    persistConfig();
    if (state.historyView) statsUi?.setView(state.historyView.bucket, state.historyView.rangeMs);
  } catch {
    alert('That file is not a valid car-counter config.');
  }
});

// Manual refresh: nudge the service worker to fetch a new version, then reload.
refs.reloadBtn.addEventListener('click', async () => {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {}
  location.reload();
});

// --- PWA install + always-up-to-date service worker ---
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  refs.installBtn.hidden = false;
});
refs.installBtn.addEventListener('click', async () => {
  await installPrompt?.prompt();
  installPrompt = null;
  refs.installBtn.hidden = true;
});
if ('serviceWorker' in navigator) {
  // updateViaCache: 'none' + hourly update() keeps long-lived (installed/kiosk)
  // windows current; when a new worker takes over, reload once onto it.
  navigator.serviceWorker
    .register('/sw.js', { updateViaCache: 'none' })
    .then((reg) => setInterval(() => reg.update().catch(() => {}), 60 * 60_000))
    .catch(() => {});
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) location.reload();
    hadController = true;
  });
}

// --- boot ---
(async () => {
  await loadConfig();
  statsUi = new StatsUi(refs, () => state.countMode, {
    initial: state.historyView,
    onViewChange(bucket, rangeMs) {
      state.historyView = { bucket, rangeMs };
      persistConfig();
    },
    speedInfo: () => ({ active: speedMatcher.active, limitKmh: speedMatcher.limitKmh }),
  });
  refreshPresets();
  refreshCameraList();
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshCameraList);
  requestAnimationFrame(frame);

  // Server engine first: when it's available the browser is a pure viewer.
  await pollEngine();
  if (engineStatus) {
    refs.engineBtn.hidden = false;
    refs.engineSettings.hidden = false;
    setInterval(pollEngine, 300);
    applyEngineUi();
    if (!engineRunning()) {
      refs.videoHint.textContent =
        'Click “Start server counting” — the server captures and counts by itself ' +
        '(keeps going with the browser closed). Or start a browser camera below.';
    }
    // Camera list as seen by the SERVER (the engine captures, not this page).
    try {
      const { devices } = await (await fetch('/api/engine/devices')).json();
      const savedEngine = (await fetchConfig())?.engine ?? {};
      const saved = String(savedEngine.device ?? '0');
      refs.engineDevice.innerHTML = devices
        .map((d) => `<option value="${d.index}">${d.index}: ${d.name}</option>`)
        .join('');
      refs.engineDevice.value = saved;
      if (refs.engineDevice.value !== saved) refs.engineDevice.selectedIndex = 0;
      if (savedEngine.size) refs.engineSize.value = savedEngine.size;
    } catch {}
  }

  await populateModelSelect();
  if (engineRunning()) {
    setStatus(state.lines.length ? 'counting (server)' : 'server engine on — add a counting line', true);
    return; // no browser detection needed; the model loads lazily if engine stops
  }
  let loaded = await loadModel(state.model);
  if (!loaded && state.model !== 'coco-ssd') {
    state.model = 'coco-ssd';
    refs.modelSelect.value = 'coco-ssd';
    loaded = await loadModel('coco-ssd');
  }
  if (loaded) {
    if (state.wasRunning) startCamera(); // resume counting where we left off
  } else {
    refs.videoHint.textContent =
      'The detection model could not be loaded. Run `bun run setup` on the server for offline use, or check your connection.';
  }
})();
