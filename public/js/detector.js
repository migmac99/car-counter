/**
 * COCO-SSD vehicle detector. Prefers the self-hosted runtime + model under
 * /vendor/ (populated by `npm run setup`); falls back to CDN + Google-hosted
 * model when vendor files are absent.
 */

const CDN_TF = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const CDN_COCO = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';

export const VEHICLE_CLASSES = ['car', 'truck', 'bus', 'motorcycle'];

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve(src);
    el.onerror = () => {
      el.remove();
      reject(new Error(`failed to load ${src}`));
    };
    document.head.append(el);
  });
}

async function hasVendorFile(path) {
  try {
    return (await fetch(path, { method: 'HEAD' })).ok;
  } catch {
    return false;
  }
}

export class Detector {
  #model = null;
  #busy = false;

  /** Loads scripts + model. onStatus(text) reports progress to the UI. */
  async init(onStatus = () => {}) {
    onStatus('loading ML runtime…');
    await injectScript('/vendor/tf.min.js').catch(() => injectScript(CDN_TF));
    await injectScript('/vendor/coco-ssd.min.js').catch(() => injectScript(CDN_COCO));

    onStatus('loading detection model…');
    if (await hasVendorFile('/vendor/model/model.json')) {
      this.#model = await cocoSsd.load({ modelUrl: '/vendor/model/model.json' });
    } else {
      onStatus('loading detection model from network…');
      this.#model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    }
    // Warm up so the first real frame isn't slow.
    const warm = document.createElement('canvas');
    warm.width = 300;
    warm.height = 300;
    await this.#model.detect(warm);
    onStatus('model ready');
  }

  get ready() {
    return this.#model !== null;
  }

  /**
   * Detect vehicles in the current video frame.
   * Returns [{ bbox: [x, y, w, h], class, score }] in video pixel space,
   * or null when a previous detect() is still running (frame skipped).
   */
  async detect(video, { minScore = 0.5, classes = VEHICLE_CLASSES } = {}) {
    if (!this.#model || this.#busy) return null;
    this.#busy = true;
    try {
      const predictions = await this.#model.detect(video, 20, Math.min(minScore, 0.3));
      return predictions
        .filter((p) => classes.includes(p.class) && p.score >= minScore)
        .map((p) => ({ bbox: p.bbox, class: p.class, score: p.score }));
    } finally {
      this.#busy = false;
    }
  }
}
