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

/**
 * Two-tier non-maximum suppression on [{bbox, classId, score}], tuned for
 * vehicle counting:
 *
 *  - same class: suppress above `iouThreshold` (0.5) — ordinary duplicate
 *    removal, permissive because side-view traffic genuinely overlaps;
 *  - different classes: suppress only above `crossClassThreshold` (0.7) —
 *    near-identical boxes with different labels are one physical vehicle
 *    the model hedged between car/truck, and counting both would double-
 *    count it; moderate cross-class overlap (a car partly behind a truck)
 *    stays two objects.
 */
export function nms(dets, iouThreshold = 0.5, crossClassThreshold = 0.7, iomThreshold = 0.85) {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const d of sorted) {
    let suppressed = false;
    for (const k of kept) {
      const sameClass = k.classId === d.classId;
      const overlap = iou(d.bbox, k.bbox);
      // IoU misses containment: a small box nested inside a big one has low
      // IoU but is usually a fragment of the same vehicle (frame-edge
      // entries produce a stretched box plus a tight one; large vehicles
      // shed "motorcycle" pieces). Intersection-over-min catches it —
      // same-class at 0.85, cross-class only when almost fully nested
      // (0.95), trading the rare car-hidden-in-front-of-truck for immunity
      // to constant fragment double-counts.
      const containment = iom(d.bbox, k.bbox);
      const nested = containment > (sameClass ? iomThreshold : 0.95);
      if (nested || overlap > (sameClass ? iouThreshold : crossClassThreshold)) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(d);
  }
  return kept;
}

function intersectionArea(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

/** Intersection over the smaller box's area: 1 = fully nested. */
function iom(a, b) {
  const minArea = Math.min(a[2] * a[3], b[2] * b[3]);
  return minArea > 0 ? intersectionArea(a, b) / minArea : 0;
}

function iou(a, b) {
  const inter = intersectionArea(a, b);
  return inter === 0 ? 0 : inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

/**
 * Plan horizontal tile windows over a scaled region so a wide road band is
 * inspected at full model resolution instead of being letterboxed (and
 * mostly wasted) into one square. Windows are `inputSize` wide with
 * `overlap` px shared between neighbours (so a vehicle on a seam appears
 * whole in at least one tile); the last window is right-aligned. Pure.
 *
 * @returns [{x}] window origins in scaled-region pixels
 */
export function planTiles(regionW, inputSize, overlap = Math.round(inputSize * 0.25)) {
  if (regionW <= inputSize) return [{ x: 0 }];
  const step = inputSize - overlap;
  const tiles = [];
  for (let x = 0; x + inputSize < regionW; x += step) tiles.push({ x });
  tiles.push({ x: regionW - inputSize });
  return tiles;
}

/**
 * Choose the single ffmpeg scale factor for a detection region: upscale
 * small regions (cap ×1.6), downscale huge ones so at most `maxTiles`
 * windows cover the width and the height fits the model input.
 */
export function regionScale(regionW, regionH, inputSize, maxTiles = 4) {
  const overlap = Math.round(inputSize * 0.25);
  const maxWidth = maxTiles * (inputSize - overlap) + overlap;
  return Math.min(1.6, inputSize / regionH, maxWidth / regionW);
}

/**
 * Tag whether a tile-local detection is clipped at the tile's inner edges
 * (it continues into the neighbouring tile).
 */
export function clipFlags(bbox, tileHasLeft, tileHasRight, inputSize, margin = 6) {
  return {
    clipLeft: tileHasLeft && bbox[0] <= margin,
    clipRight: tileHasRight && bbox[0] + bbox[2] >= inputSize - margin,
  };
}

/**
 * Reconstruct vehicles that straddle tile seams: a right-clipped fragment
 * from one tile and a left-clipped fragment from the next, same class and
 * vertically aligned, are two halves of ONE vehicle — replace them with
 * their union. Runs to fixpoint so a truck spanning three tiles chains.
 * Boxes are in scaled-region coordinates (tile offsets already applied).
 */
export function mergeSeamFragments(dets) {
  const out = [...dets];
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < out.length; j++) {
        if (i === j) continue;
        const a = out[i];
        const b = out[j];
        if (!a.clipRight || !b.clipLeft || a.classId !== b.classId) continue;
        const [ax, ay, aw, ah] = a.bbox;
        const [bx, by, bw, bh] = b.bbox;
        if (bx > ax + aw + 4 || bx < ax) continue; // not horizontally adjacent
        const vOverlap = Math.min(ay + ah, by + bh) - Math.max(ay, by);
        if (vOverlap < 0.5 * Math.min(ah, bh)) continue; // different lanes
        const x = Math.min(ax, bx);
        const y = Math.min(ay, by);
        out[i] = {
          bbox: [x, y, Math.max(ax + aw, bx + bw) - x, Math.max(ay + ah, by + bh) - y],
          classId: a.classId,
          score: Math.max(a.score, b.score),
          clipLeft: a.clipLeft,
          clipRight: b.clipRight,
        };
        out.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return out;
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
