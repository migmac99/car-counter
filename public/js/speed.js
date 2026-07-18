/**
 * Average-speed measurement between two counting lines ("gates") a known
 * real-world distance apart: speed = distance / time-between-crossings.
 * Timing-based measurement is robust to camera perspective, unlike
 * pixels-per-frame estimates.
 */

const MIN_DT_MS = 150; // faster than this between gates is a tracking glitch
const MAX_DT_MS = 120_000;

/**
 * Pixels-per-meter scale derived from the two gate lines: their midpoints
 * are a known real-world distance apart. This turns EVERY track's pixel
 * velocity into a continuous km/h estimate — approximate (a single global
 * scale ignores perspective) but live for all vehicles, not only those that
 * complete both gates. Gate-pair timing remains the accurate measurement.
 * Lines are in pixel space: [{id, a: {x, y}, b: {x, y}}].
 */
export function gateCalibration(lines, { gateA, gateB, meters } = {}) {
  const m = Number(meters);
  if (!gateA || !gateB || gateA === gateB || !(m > 0)) return 0;
  const a = lines.find((l) => l.id === gateA);
  const b = lines.find((l) => l.id === gateB);
  if (!a || !b) return 0;
  const mid = (l) => ({ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 });
  const ma = mid(a);
  const mb = mid(b);
  const dist = Math.hypot(mb.x - ma.x, mb.y - ma.y);
  return dist > 0 ? dist / m : 0;
}

/**
 * Robust km/h estimate from a track's recent path: the MEDIAN of per-step
 * speeds over the last `windowMs`. Detector box flapping (stretched↔tight
 * interpretations at region edges) teleports the centroid for a frame or
 * two, which doubles any velocity-EMA estimate; a median over ~20 steps
 * discards those spike frames outright. History: [{x, y, t}].
 */
export function historyKmh(history, pxPerMeter, windowMs = 900, minSpanMs = 350) {
  if (!(pxPerMeter > 0) || !history || history.length < 2) return null;
  const end = history[history.length - 1];
  const steps = [];
  for (let i = history.length - 1; i > 0; i--) {
    const b = history[i];
    const a = history[i - 1];
    if (end.t - a.t > windowMs) break;
    const dt = b.t - a.t;
    if (dt > 0) steps.push(Math.hypot(b.x - a.x, b.y - a.y) / dt); // px/ms
  }
  if (steps.length < 5) return null;
  const first = history[history.length - 1 - steps.length];
  if (end.t - first.t < minSpanMs) return null;
  steps.sort((p, q) => p - q);
  const median = steps[Math.floor(steps.length / 2)];
  const kmh = ((median * 1000) / pxPerMeter) * 3.6;
  return kmh < 400 ? kmh : null;
}

export class SpeedMatcher {
  #gateA = null;
  #gateB = null;
  #meters = 0;
  #limitKmh = 0;
  #crossings = new Map(); // trackId -> { [lineId]: ts }

  configure({ gateA, gateB, meters, limitKmh } = {}) {
    const nextA = gateA || null;
    const nextB = gateB || null;
    const nextMeters = Number(meters) || 0;
    // Reconfiguring with identical gates must NOT clear pending half-pairs —
    // callers may re-apply config periodically while a vehicle is between
    // the gates. (A limit change alone doesn't invalidate timing either.)
    const changed = nextA !== this.#gateA || nextB !== this.#gateB || nextMeters !== this.#meters;
    this.#gateA = nextA;
    this.#gateB = nextB;
    this.#meters = nextMeters;
    this.#limitKmh = Number(limitKmh) || 0;
    if (changed) this.#crossings.clear();
  }

  get active() {
    return Boolean(this.#gateA && this.#gateB && this.#gateA !== this.#gateB && this.#meters > 0);
  }

  get limitKmh() {
    return this.#limitKmh;
  }

  /**
   * Feed a line crossing; returns { kmh, over } when this crossing completes
   * the pair of gates for the track, else null.
   */
  observe(trackId, lineId, ts) {
    if (!this.active || (lineId !== this.#gateA && lineId !== this.#gateB)) return null;
    const seen = this.#crossings.get(trackId) ?? {};
    seen[lineId] = ts;
    this.#crossings.set(trackId, seen);
    const tA = seen[this.#gateA];
    const tB = seen[this.#gateB];
    if (tA == null || tB == null) return null;
    this.#crossings.delete(trackId);
    const dt = Math.abs(tB - tA);
    if (dt < MIN_DT_MS || dt > MAX_DT_MS) return null;
    const kmh = Math.round(((this.#meters / (dt / 1000)) * 3.6) * 10) / 10;
    return { kmh, over: this.#limitKmh > 0 && kmh > this.#limitKmh };
  }

  prune(liveTrackIds) {
    for (const id of this.#crossings.keys()) {
      if (!liveTrackIds.has(id)) this.#crossings.delete(id);
    }
  }
}
