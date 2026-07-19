/**
 * Pure 2D geometry helpers shared by the tracker, counter and zone editor.
 * Screen coordinates (y grows downward). All functions are side-effect free
 * so they run both in the browser and under node:test.
 */

/**
 * Signed area cross product of (b-a) x (p-a).
 * Positive means p lies on the side the line's direction arrow points to
 * (below/right of a->b in screen coordinates).
 */
export function sideOfLine(p, a, b) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/** Perpendicular distance from p to the infinite line through a, b (signed). */
export function signedDistance(p, a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return len === 0 ? 0 : sideOfLine(p, a, b) / len;
}

/** Unit normal of a->b pointing toward the positive (sideOfLine > 0) side. */
export function positiveNormal(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

/**
 * Intersection of segments p0->p1 and a->b as parameters {t, s} where
 * t is the fraction along p0->p1 and s along a->b. Null if parallel.
 */
export function intersectionParams(p0, p1, a, b) {
  const d1x = p1.x - p0.x;
  const d1y = p1.y - p0.y;
  const d2x = b.x - a.x;
  const d2y = b.y - a.y;
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return null;
  const ex = a.x - p0.x;
  const ey = a.y - p0.y;
  return {
    t: (ex * d2y - ey * d2x) / denom,
    s: (ex * d1y - ey * d1x) / denom,
  };
}

/** Ray-casting point-in-polygon test. poly: [{x,y}, ...] with >= 3 vertices. */
export function pointInPolygon(p, poly) {
  if (!poly || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Does an [x,y,w,h] box overlap a polygon at all? True if the box center or
 * any corner is inside the polygon, or any polygon vertex is inside the box.
 * Looser than a center-point test: a vehicle whose center falls just outside
 * a thin zone band but whose body straddles it still counts as in-zone —
 * the strict center test was silently dropping edge detections.
 */
export function boxOverlapsPolygon(bbox, poly) {
  if (!poly || poly.length < 3) return false;
  const [x, y, w, h] = bbox;
  const pts = [
    { x: x + w / 2, y: y + h / 2 },
    { x, y },
    { x: x + w, y },
    { x, y: y + h },
    { x: x + w, y: y + h },
  ];
  for (const p of pts) if (pointInPolygon(p, poly)) return true;
  for (const v of poly) if (v.x >= x && v.x <= x + w && v.y >= y && v.y <= y + h) return true;
  return false;
}

/** Intersection-over-union of two [x, y, w, h] boxes. */
export function iou(boxA, boxB) {
  const [ax, ay, aw, ah] = boxA;
  const [bx, by, bw, bh] = boxB;
  const x0 = Math.max(ax, bx);
  const y0 = Math.max(ay, by);
  const x1 = Math.min(ax + aw, bx + bw);
  const y1 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (inter === 0) return 0;
  return inter / (aw * ah + bw * bh - inter);
}

/** Center point of an [x, y, w, h] box. */
export function boxCenter([x, y, w, h]) {
  return { x: x + w / 2, y: y + h / 2 };
}

/**
 * Bounding-box dimensions that a plausible vehicle detection may not
 * exceed, derived from the detection zones the user drew: no real vehicle
 * is taller or wider than the road region itself. Null when no zones exist.
 */
export function zoneMaxDims(zonePolys) {
  let w = 0;
  let h = 0;
  for (const poly of zonePolys) {
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    w = Math.max(w, Math.max(...xs) - Math.min(...xs));
    h = Math.max(h, Math.max(...ys) - Math.min(...ys));
  }
  return w > 0 ? { w, h } : null;
}

/**
 * Detector-hallucination gate: dark or low-texture scenes can produce huge
 * low-confidence boxes spanning half the frame. A detection larger than the
 * drawn road region (with 10% slack), or covering more than half the
 * visible view, is not a vehicle.
 */
export function plausibleVehicle(bbox, viewArea, maxDims) {
  const [, , w, h] = bbox;
  if (maxDims && (w > maxDims.w * 1.1 || h > maxDims.h * 1.1)) return false;
  if (viewArea && w * h > viewArea * 0.5) return false;
  return true;
}
