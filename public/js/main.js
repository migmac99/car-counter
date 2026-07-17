import { listCameras, openCamera, openFile, stopSource } from './camera.js';
import { Detector, VEHICLE_CLASSES } from './detector.js';
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
} from './api.js';
import { StatsUi } from './stats-ui.js';
import { pointInPolygon, boxCenter } from './geometry.js';

const $ = (id) => document.getElementById(id);

const refs = {
  status: $('status'),
  video: $('video'),
  videoWrap: $('video-wrap'),
  videoStage: $('video-stage'),
  videoHint: $('video-hint'),
  overlay: $('overlay'),
  cameraSelect: $('camera-select'),
  startBtn: $('start-btn'),
  stopBtn: $('stop-btn'),
  fileInput: $('file-input'),
  drawLineBtn: $('draw-line-btn'),
  flipBtn: $('flip-btn'),
  drawRoiBtn: $('draw-roi-btn'),
  deleteShapeBtn: $('delete-shape-btn'),
  zoom: $('zoom'),
  zoomValue: $('zoom-value'),
  minScore: $('min-score'),
  minScoreValue: $('min-score-value'),
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
};

const detector = new Detector();
const tracker = new Tracker();
const counters = new Map(); // line id -> LineCounter
const overlay = new Overlay(refs.overlay);
const sink = new EventSink();
let statsUi = null; // constructed in boot, after the saved config is loaded

function setStatus(text, running = state.running) {
  refs.status.textContent = text;
  refs.status.classList.toggle('running', running);
}

// --- coordinate helpers ---
const videoSize = () => ({ w: refs.video.videoWidth, h: refs.video.videoHeight });

function toPixels(norm) {
  const { w, h } = videoSize();
  if (!w) return null;
  return { x: norm.x * w, y: norm.y * h };
}

function toNorm(p) {
  const { w, h } = videoSize();
  return { x: p.x / w, y: p.y / h };
}

function shapesToPixels() {
  const { w } = videoSize();
  if (!w) return { lines: [], zones: [] };
  return {
    lines: state.lines.map((l) => ({ id: l.id, a: toPixels(l.a), b: toPixels(l.b) })),
    zones: state.zones.map((z) => ({ id: z.id, points: z.points.map(toPixels) })),
  };
}

/** Adopt the editor's pixel-space shapes as the new normalized truth. */
function adoptShapes(px) {
  const { w } = videoSize();
  if (!w) return;
  state.lines = px.lines.map((l) => ({ id: l.id, a: toNorm(l.a), b: toNorm(l.b) }));
  state.zones = px.zones.map((z) => ({ id: z.id, points: z.points.map(toNorm) }));
  syncCounters();
  persistConfig();
  setStatus(state.running ? (state.lines.length ? 'counting' : 'running — add a counting line') : refs.status.textContent);
}

/** Keep one LineCounter per line; reset crossing state only when geometry moves. */
function syncCounters() {
  const { h } = videoSize();
  const hysteresis = Math.max(6, (h || 720) * 0.012);
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
  refs.minScore.value = state.minScore;
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
  const { w, h } = videoSize();
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

/** The frame source for the detector: full video at 1×, the visible crop when zoomed. */
function detectionSource() {
  const { z, cx, cy } = state.view;
  if (z <= 1) return { source: refs.video, offsetX: 0, offsetY: 0 };
  const { w, h } = videoSize();
  const cw = Math.round(w / z);
  const ch = Math.round(h / z);
  const x = Math.round(Math.min(w - cw, Math.max(0, cx * w - cw / 2)));
  const y = Math.round(Math.min(h - ch, Math.max(0, cy * h - ch / 2)));
  cropCanvas ??= document.createElement('canvas');
  if (cropCanvas.width !== cw || cropCanvas.height !== ch) {
    cropCanvas.width = cw;
    cropCanvas.height = ch;
  }
  cropCanvas.getContext('2d').drawImage(refs.video, x, y, cw, ch, 0, 0, cw, ch);
  return { source: cropCanvas, offsetX: x, offsetY: y };
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

// --- detection loop ---
let detecting = false;

async function step(now) {
  if (!state.running || refs.video.readyState < 2 || !detector.ready || detecting) return;
  detecting = true;
  try {
    const { source, offsetX, offsetY } = detectionSource();
    const detected = await detector.detect(source, {
      minScore: state.minScore,
      classes: state.classes,
    });
    if (!detected) return;
    const detections =
      offsetX || offsetY
        ? detected.map((d) => ({
            ...d,
            bbox: [d.bbox[0] + offsetX, d.bbox[1] + offsetY, d.bbox[2], d.bbox[3]],
          }))
        : detected;
    const zonePolys = state.zones
      .map((z) => z.points.map(toPixels))
      .filter((pts) => pts.length >= 3 && pts.every(Boolean));
    const inZone = zonePolys.length
      ? detections.filter((d) => zonePolys.some((poly) => pointInPolygon(boxCenter(d.bbox), poly)))
      : detections;
    const tracks = tracker.update(inZone, now);
    const liveIds = new Set(tracks.map((t) => t.id));
    for (const [lineId, counter] of counters) {
      const crossings = counter.update(tracks, now);
      counter.prune(liveIds);
      for (const c of crossings) {
        sink.record({
          ts: c.ts,
          direction: c.direction,
          class: c.class,
          confidence: Math.round(c.confidence * 1000) / 1000,
          trackId: c.trackId,
          line: lineId,
        });
        statsUi?.bump(c.direction);
        const track = tracks.find((t) => t.id === c.trackId);
        if (track) overlay.addPulse(track.cx, track.cy, c.direction);
      }
    }
  } finally {
    detecting = false;
  }
}

function frame() {
  overlay.resize();
  step(Date.now());
  overlay.draw({
    tracks: state.running ? tracker.tracks : [],
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
  setStatus(state.lines.length ? 'counting' : 'running — add a counting line');
}

async function startCamera() {
  try {
    setStatus('opening camera…');
    await openCamera(refs.video, refs.cameraSelect.value || undefined);
    sourceStarted();
    state.cameraId = refs.cameraSelect.value;
    state.wasRunning = true; // so the next visit resumes counting automatically
    persistConfig();
    refreshCameraList(); // labels become available after permission
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
  persistConfig();
  stopSource(refs.video);
  refs.stopBtn.disabled = true;
  refs.videoHint.hidden = false;
  refs.videoHint.textContent = 'Stopped. Start a camera or open a video file to continue counting.';
  setStatus('stopped', false);
  sink.flush();
});

// --- toolbar ---
function requireVideo() {
  if (videoSize().w) return true;
  setStatus('start a camera or video first', false);
  return false;
}

refs.drawLineBtn.addEventListener('click', () => {
  if (editor.mode === 'line') editor.cancel();
  else if (requireVideo()) editor.start('line');
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
  persistConfig();
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
  });
  refreshPresets();
  refreshCameraList();
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshCameraList);
  requestAnimationFrame(frame);
  try {
    await detector.init((text) => setStatus(text, false));
    setStatus('ready — start a camera', false);
    if (state.wasRunning) startCamera(); // resume counting where we left off
  } catch (err) {
    console.error(err);
    setStatus('model failed to load', false);
    refs.videoHint.textContent =
      'The detection model could not be loaded. Run `bun run setup` on the server for offline use, or check your connection.';
  }
})();
