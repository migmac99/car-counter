/**
 * Average-speed measurement between two counting lines ("gates") a known
 * real-world distance apart: speed = distance / time-between-crossings.
 * Timing-based measurement is robust to camera perspective, unlike
 * pixels-per-frame estimates.
 */

const MIN_DT_MS = 150; // faster than this between gates is a tracking glitch
const MAX_DT_MS = 120_000;

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
