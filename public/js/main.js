import { listCameras, openCamera, openFile, stopSource } from './camera.js';
import { Detector, VEHICLE_CLASSES } from './detector.js';
import { Tracker } from './tracker.js';
import { LineCounter } from './counter.js';
import { Overlay } from './overlay.js';
import { ZoneEditor } from './zones.js';
import { EventSink, fetchConfig, saveConfig, resetHistory } from './api.js';
import { StatsUi } from './stats-ui.js';
import { pointInPolygon, boxCenter } from './geometry.js';

const $ = (id) => document.getElementById(id);

const refs = {
  status: $('status'),
  video: $('video'),
  videoWrap: $('video-wrap'),
  videoHint: $('video-hint'),
  overlay: $('overlay'),
  cameraSelect: $('camera-select'),
  startBtn: $('start-btn'),
  stopBtn: $('stop-btn'),
  fileInput: $('file-input'),
  drawLineBtn: $('draw-line-btn'),
  flipBtn: $('flip-btn'),
  drawRoiBtn: $('draw-roi-btn'),
  clearRoiBtn: $('clear-roi-btn'),
  minScore: $('min-score'),
  minScoreValue: $('min-score-value'),
  classFilters: $('class-filters'),
  countModeSel: $('count-mode'),
  resetData: $('reset-data'),
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

// Line and ROI are stored normalized (0..1) so they survive resolution changes.
const state = {
  running: false,
  lineNorm: null, // {a: {x,y}, b: {x,y}} normalized
  roiNorm: null, // [{x,y}, ...] normalized
  minScore: 0.5,
  classes: [...VEHICLE_CLASSES],
  countMode: 'both',
};

const detector = new Detector();
const tracker = new Tracker();
const counter = new LineCounter();
const overlay = new Overlay(refs.overlay);
const sink = new EventSink();
const statsUi = new StatsUi(refs, () => state.countMode);

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

function linePixels() {
  if (!state.lineNorm) return null;
  const a = toPixels(state.lineNorm.a);
  const b = toPixels(state.lineNorm.b);
  return a && b ? { a, b } : null;
}

function roiPixels() {
  if (!state.roiNorm) return null;
  const pts = state.roiNorm.map(toPixels);
  return pts.every(Boolean) ? pts : null;
}

function syncCounterLine() {
  const line = linePixels();
  const { h } = videoSize();
  if (line) counter.hysteresis = Math.max(6, (h || 720) * 0.012);
  counter.setLine(line);
}

// --- config persistence (server-side, mirrored locally for offline) ---
function persistConfig() {
  const config = {
    line: state.lineNorm,
    roi: state.roiNorm,
    minScore: state.minScore,
    classes: state.classes,
    countMode: state.countMode,
  };
  saveConfig(config);
  try {
    localStorage.setItem('car-counter.config', JSON.stringify(config));
  } catch {}
}

function applyConfig(config) {
  if (!config) return;
  state.lineNorm = config.line ?? null;
  state.roiNorm = config.roi ?? null;
  state.minScore = config.minScore ?? 0.5;
  state.classes = Array.isArray(config.classes) && config.classes.length ? config.classes : [...VEHICLE_CLASSES];
  state.countMode = config.countMode ?? 'both';
  refs.minScore.value = state.minScore;
  refs.minScoreValue.textContent = state.minScore.toFixed(2);
  refs.countModeSel.value = state.countMode;
  for (const box of refs.classFilters.querySelectorAll('input')) {
    box.checked = state.classes.includes(box.value);
  }
  syncCounterLine();
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

// --- zone editing ---
const editor = new ZoneEditor(refs.overlay, {
  onLine(line) {
    state.lineNorm = { a: toNorm(line.a), b: toNorm(line.b) };
    syncCounterLine();
    persistConfig();
  },
  onRoi(roi) {
    state.roiNorm = roi ? roi.map(toNorm) : null;
    persistConfig();
  },
  onModeChange(mode) {
    refs.videoWrap.classList.toggle('editing', mode !== null);
    refs.drawLineBtn.classList.toggle('active', mode === 'line');
    refs.drawRoiBtn.classList.toggle('active', mode === 'roi');
  },
});

// --- detection loop ---
let detecting = false;

async function step(now) {
  if (!state.running || refs.video.readyState < 2 || !detector.ready || detecting) return;
  detecting = true;
  try {
    const detections = await detector.detect(refs.video, {
      minScore: state.minScore,
      classes: state.classes,
    });
    if (!detections) return;
    const roi = roiPixels();
    const inZone = roi
      ? detections.filter((d) => pointInPolygon(boxCenter(d.bbox), roi))
      : detections;
    const tracks = tracker.update(inZone, now);
    const crossings = counter.update(tracks, now);
    counter.prune(new Set(tracks.map((t) => t.id)));
    for (const c of crossings) {
      sink.record({
        ts: c.ts,
        direction: c.direction,
        class: c.class,
        confidence: Math.round(c.confidence * 1000) / 1000,
        trackId: c.trackId,
      });
      statsUi.bump(c.direction);
      const track = tracks.find((t) => t.id === c.trackId);
      if (track) overlay.addPulse(track.cx, track.cy, c.direction);
    }
  } finally {
    detecting = false;
  }
}

function frame() {
  const { w, h } = videoSize();
  overlay.resize(w, h);
  step(Date.now());
  overlay.draw({
    tracks: state.running ? tracker.tracks : [],
    line: linePixels(),
    roi: roiPixels(),
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
    const current = refs.cameraSelect.value;
    refs.cameraSelect.innerHTML =
      '<option value="">Default camera</option>' +
      cams
        .map((c, i) => `<option value="${c.deviceId}">${c.label || `Camera ${i + 1}`}</option>`)
        .join('');
    refs.cameraSelect.value = current;
  } catch {}
}

function sourceStarted() {
  state.running = true;
  refs.videoHint.hidden = true;
  refs.stopBtn.disabled = false;
  syncCounterLine();
  setStatus(state.lineNorm ? 'counting' : 'running — draw a counting line');
}

refs.startBtn.addEventListener('click', async () => {
  try {
    setStatus('opening camera…');
    await openCamera(refs.video, refs.cameraSelect.value || undefined);
    sourceStarted();
    refreshCameraList(); // labels become available after permission
  } catch (err) {
    setStatus('camera unavailable', false);
    refs.videoHint.hidden = false;
    refs.videoHint.textContent =
      `Could not open the camera (${err.name ?? err.message}). ` +
      'Check permissions — camera access needs localhost or HTTPS.';
  }
});

refs.fileInput.addEventListener('change', async () => {
  const file = refs.fileInput.files?.[0];
  if (!file) return;
  await openFile(refs.video, file);
  sourceStarted();
});

refs.stopBtn.addEventListener('click', () => {
  state.running = false;
  stopSource(refs.video);
  refs.stopBtn.disabled = true;
  refs.videoHint.hidden = false;
  refs.videoHint.textContent = 'Stopped. Start a camera or open a video file to continue counting.';
  setStatus('stopped', false);
  sink.flush();
});

// --- toolbar ---
refs.drawLineBtn.addEventListener('click', () =>
  editor.mode === 'line' ? editor.cancel() : editor.start('line')
);
refs.drawRoiBtn.addEventListener('click', () =>
  editor.mode === 'roi' ? editor.cancel() : editor.start('roi')
);
refs.clearRoiBtn.addEventListener('click', () => {
  state.roiNorm = null;
  persistConfig();
});
refs.flipBtn.addEventListener('click', () => {
  if (!state.lineNorm) return;
  state.lineNorm = { a: state.lineNorm.b, b: state.lineNorm.a };
  syncCounterLine();
  persistConfig();
});

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
  statsUi.refreshSummary();
  statsUi.refreshHistory();
});
refs.resetData.addEventListener('click', async () => {
  if (!confirm('Delete ALL recorded counts from the server? This cannot be undone.')) return;
  await resetHistory();
  statsUi.refreshSummary();
  statsUi.refreshHistory();
});

// --- PWA install + service worker ---
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
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// --- boot ---
(async () => {
  await loadConfig();
  refreshCameraList();
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshCameraList);
  requestAnimationFrame(frame);
  try {
    await detector.init((text) => setStatus(text, false));
    setStatus('ready — start a camera', false);
  } catch (err) {
    console.error(err);
    setStatus('model failed to load', false);
    refs.videoHint.textContent =
      'The detection model could not be loaded. Run `npm run setup` on the server for offline use, or check your connection.';
  }
})();
