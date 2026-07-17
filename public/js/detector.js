/**
 * Vehicle detector with selectable backends:
 *
 *  - 'coco-ssd'   — TF.js ssdlite_mobilenet_v2 (2018): smallest, fastest to
 *                   load, weakest on small/distant vehicles. CDN fallback.
 *  - 'yolox-nano' — ONNX Runtime Web (WebGPU, WASM fallback): tiny model.
 *  - 'yolox-tiny' — the recommended accuracy/speed balance (~+10 mAP over
 *                   coco-ssd, dramatically better on small objects).
 *  - 'yolox-s'    — most accurate; fetch with `bun run setup --model s`.
 *
 * All backends return [{ bbox: [x,y,w,h], class, score }] in source pixels.
 * detect() also returns low-confidence candidates (>= LOW_FLOOR) so the
 * tracker can run ByteTrack-style second-stage association; the caller's
 * minScore decides what counts as a "high" detection.
 */
import { YOLOX_CLASSES, YOLOX_VARIANTS, buildGrids, decode, nms, preprocess } from './yolox.js';

const CDN_TF = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const CDN_COCO = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';

export const VEHICLE_CLASSES = ['car', 'truck', 'bus', 'motorcycle'];
export const LOW_FLOOR = 0.1; // candidates below this are noise even for ByteTrack

export const MODELS = {
  'coco-ssd': { label: 'Fast · COCO-SSD' },
  'yolox-nano': { label: 'Light · YOLOX-nano' },
  'yolox-tiny': { label: 'Balanced · YOLOX-tiny (recommended)' },
  'yolox-s': { label: 'Accurate · YOLOX-s' },
};

function injectScript(src, crossorigin = false) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    if (crossorigin) el.crossOrigin = 'anonymous';
    el.onload = () => resolve(src);
    el.onerror = () => {
      el.remove();
      reject(new Error(`failed to load ${src}`));
    };
    document.head.append(el);
  });
}

async function vendorFileExists(path) {
  try {
    return (await fetch(path, { method: 'HEAD' })).ok;
  } catch {
    return false;
  }
}

/** Which models are actually usable right now (vendored or CDN-fallback). */
export async function availableModels() {
  const out = { 'coco-ssd': true }; // always: vendor or CDN
  for (const name of Object.keys(YOLOX_VARIANTS)) {
    out[name] = await vendorFileExists(`/vendor/models/${YOLOX_VARIANTS[name].file}`);
  }
  return out;
}

class CocoSsdBackend {
  inputSize = 640; // its own graph resizes to 300²; 640 keeps resampling cheap
  ep = 'tfjs-webgl';

  async init(onStatus) {
    onStatus('loading TF.js runtime…');
    await injectScript('/vendor/tf.min.js').catch(() => injectScript(CDN_TF, true));
    await injectScript('/vendor/coco-ssd.min.js').catch(() => injectScript(CDN_COCO, true));
    onStatus('loading COCO-SSD model…');
    if (await vendorFileExists('/vendor/model/model.json')) {
      this.model = await cocoSsd.load({ modelUrl: '/vendor/model/model.json' });
    } else {
      onStatus('loading COCO-SSD from network…');
      this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    }
    const warm = document.createElement('canvas');
    warm.width = 300;
    warm.height = 300;
    await this.model.detect(warm);
  }

  async detect(source) {
    const predictions = await this.model.detect(source, 30, LOW_FLOOR);
    return predictions
      .filter((p) => VEHICLE_CLASSES.includes(p.class))
      .map((p) => ({ bbox: p.bbox, class: p.class, score: p.score }));
  }
}

class YoloxBackend {
  constructor(variant) {
    this.variant = YOLOX_VARIANTS[variant];
    this.name = variant;
    this.inputSize = this.variant.size;
  }

  async init(onStatus) {
    onStatus('loading ONNX runtime…');
    if (!globalThis.ort) await injectScript('/vendor/ort/ort.min.js');
    ort.env.wasm.wasmPaths = '/vendor/ort/';
    // Threads need cross-origin isolation (the server sends COOP/COEP).
    const threads = crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
    ort.env.wasm.numThreads = threads;
    const { size, file } = this.variant;
    onStatus(`loading ${this.name} model…`);
    const create = (providers) =>
      ort.InferenceSession.create(`/vendor/models/${file}`, {
        executionProviders: providers,
        graphOptimizationLevel: 'all',
      });
    // Try WebGPU explicitly so we KNOW which provider is running — a silent
    // fallback hides an order-of-magnitude performance difference.
    if ('gpu' in navigator) {
      try {
        this.session = await create(['webgpu']);
        this.ep = 'webgpu';
      } catch {
        this.session = null;
      }
    }
    if (!this.session) {
      this.session = await create(['wasm']);
      this.ep = `wasm×${threads}${crossOriginIsolated ? '' : ' (restart server for threads)'}`;
    }
    this.inputName = this.session.inputNames[0];
    this.outputName = this.session.outputNames[0];
    this.grids = buildGrids(size);
    this.work = document.createElement('canvas');
    this.work.width = size;
    this.work.height = size;
    onStatus('warming up…');
    await this.#run(this.work, size, size); // warm-up compiles kernels
  }

  async #run(source, sw, sh) {
    const { size } = this.variant;
    const { chw, scale } = preprocess(source, sw, sh, size, this.work);
    const input = new ort.Tensor('float32', chw, [1, 3, size, size]);
    const results = await this.session.run({ [this.inputName]: input });
    return { output: results[this.outputName].data, scale };
  }

  async detect(source) {
    const sw = source.videoWidth ?? source.width;
    const sh = source.videoHeight ?? source.height;
    if (!sw || !sh) return [];
    const { output, scale } = await this.#run(source, sw, sh);
    const decoded = decode(output, this.grids, LOW_FLOOR);
    return nms(decoded).map((d) => ({
      bbox: d.bbox.map((v) => v / scale),
      class: YOLOX_CLASSES[d.classId],
      score: Math.min(1, d.score),
    }));
  }
}

export class Detector {
  #backend = null;
  #busy = false;
  modelName = null;

  /** Load (or switch to) a model. onStatus(text) reports progress. */
  async init(modelName, onStatus = () => {}) {
    this.#backend = null;
    const backend = modelName.startsWith('yolox') ? new YoloxBackend(modelName) : new CocoSsdBackend();
    await backend.init(onStatus);
    this.#backend = backend;
    this.modelName = modelName;
    onStatus('model ready');
  }

  get ready() {
    return this.#backend !== null;
  }

  /** The model's native input square — the ideal detection-crop budget. */
  get inputSize() {
    return this.#backend?.inputSize ?? 640;
  }

  /** Which execution provider is actually running (for the perf chip). */
  get backendInfo() {
    return this.#backend?.ep ?? '';
  }

  /**
   * Detect vehicles in the frame. Returns ALL candidates with score >=
   * LOW_FLOOR, filtered to `classes`, in source pixel space — or null when a
   * previous detect() is still in flight (frame skipped).
   */
  async detect(source, { classes = VEHICLE_CLASSES } = {}) {
    if (!this.#backend || this.#busy) return null;
    this.#busy = true;
    try {
      const detections = await this.#backend.detect(source);
      return detections.filter((d) => classes.includes(d.class));
    } finally {
      this.#busy = false;
    }
  }
}
