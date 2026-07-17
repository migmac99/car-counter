/**
 * YOLOX ONNX backend helpers (Apache-2.0 models from Megvii-BaseDetection).
 * Preprocessing and decoding follow the official ONNX demo: letterbox pad
 * with 114, BGR channel order, raw 0-255 floats (no normalization), CHW; the
 * output is a [1, N, 85] tensor of per-anchor predictions that we decode
 * against stride grids (8/16/32) and prune with class-agnostic NMS.
 *
 * The decode/NMS functions are pure so they run under bun:test.
 */

// COCO class indices for the classes this app can count.
export const YOLOX_CLASSES = { 2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck' };

export const YOLOX_VARIANTS = {
  'yolox-nano': { file: 'yolox_nano.onnx', size: 416 },
  'yolox-tiny': { file: 'yolox_tiny.onnx', size: 416 },
  'yolox-s': { file: 'yolox_s.onnx', size: 640 },
};

/** Build the stride grid table for a square input size. */
export function buildGrids(inputSize, strides = [8, 16, 32]) {
  const grids = [];
  for (const stride of strides) {
    const n = inputSize / stride;
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++) grids.push({ gx, gy, stride });
    }
  }
  return grids;
}

/**
 * Decode the raw output tensor into boxes in letterboxed-input pixels.
 * @param {Float32Array} data flat [N, 85] predictions
 * @param {Array} grids from buildGrids(inputSize)
 * @param {number} minScore objectness × class score floor
 * @returns [{bbox: [x, y, w, h], classId, score}]
 */
export function decode(data, grids, minScore) {
  const out = [];
  const stride85 = 85;
  for (let i = 0; i < grids.length; i++) {
    const o = i * stride85;
    const objectness = data[o + 4];
    if (objectness * 1 < minScore) continue; // cheap early reject
    let best = 0;
    let bestId = -1;
    for (const id of [2, 3, 5, 7]) {
      const s = data[o + 5 + id];
      if (s > best) {
        best = s;
        bestId = id;
      }
    }
    const score = objectness * best;
    if (bestId === -1 || score < minScore) continue;
    const { gx, gy, stride } = grids[i];
    const cx = (data[o] + gx) * stride;
    const cy = (data[o + 1] + gy) * stride;
    const w = Math.exp(data[o + 2]) * stride;
    const h = Math.exp(data[o + 3]) * stride;
    out.push({ bbox: [cx - w / 2, cy - h / 2, w, h], classId: bestId, score });
  }
  return out;
}

/** Class-agnostic non-maximum suppression on [{bbox, score}]. */
export function nms(dets, iouThreshold = 0.45) {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const d of sorted) {
    let suppressed = false;
    for (const k of kept) {
      if (iou(d.bbox, k.bbox) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(d);
  }
  return kept;
}

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter === 0 ? 0 : inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

/**
 * Draw `source` letterboxed into a square canvas and return the CHW BGR
 * float tensor data plus the scale used (for mapping boxes back).
 */
export function preprocess(source, sw, sh, inputSize, work) {
  const scale = Math.min(inputSize / sw, inputSize / sh);
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);
  const ctx = work.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, inputSize, inputSize);
  ctx.drawImage(source, 0, 0, sw, sh, 0, 0, dw, dh);
  const { data } = ctx.getImageData(0, 0, inputSize, inputSize);
  const plane = inputSize * inputSize;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    chw[i] = data[p + 2]; // B
    chw[plane + i] = data[p + 1]; // G
    chw[2 * plane + i] = data[p]; // R
  }
  return { chw, scale };
}
