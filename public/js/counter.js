import { signedDistance, intersectionParams, positiveNormal } from './geometry.js';

/**
 * Counts confirmed tracks crossing a directed counting line.
 *
 * Direction semantics: 'fwd' means the track crossed onto the line's positive
 * side — the side its on-screen arrow (positiveNormal) points to; 'rev' is the
 * opposite. A hysteresis band around the line ignores centroid jitter, and the
 * crossing segment must actually intersect the drawn line (with a small extent
 * margin) so cars passing beyond its endpoints are not counted.
 */
export class LineCounter {
  #line = null; // {a: {x,y}, b: {x,y}} in video pixel space
  #state = new Map(); // trackId -> { side, pos, lastCross }

  constructor({ hysteresis = 8, cooldownMs = 2000, extentMargin = 0.08 } = {}) {
    this.hysteresis = hysteresis;
    this.cooldownMs = cooldownMs;
    this.extentMargin = extentMargin;
  }

  get line() {
    return this.#line;
  }

  setLine(line) {
    this.#line = line;
    this.#state.clear();
  }

  arrow() {
    if (!this.#line) return null;
    return positiveNormal(this.#line.a, this.#line.b);
  }

  /**
   * @param {Array} tracks tracker output
   * @param {number} now timestamp (ms)
   * @returns crossing events [{ trackId, direction, class, confidence, ts }]
   */
  update(tracks, now) {
    if (!this.#line) return [];
    const { a, b } = this.#line;
    const events = [];

    for (const track of tracks) {
      const pos = { x: track.cx, y: track.cy };
      const dist = signedDistance(pos, a, b);
      const state = this.#state.get(track.id);

      if (!state) {
        // Seed on first sight, but only from a settled position outside the band.
        if (Math.abs(dist) > this.hysteresis) {
          this.#state.set(track.id, { side: Math.sign(dist), pos, lastCross: 0 });
        }
        continue;
      }
      if (Math.abs(dist) <= this.hysteresis) continue;

      const side = Math.sign(dist);
      if (side !== state.side) {
        const hit = intersectionParams(state.pos, pos, a, b);
        const withinExtent =
          hit && hit.s >= -this.extentMargin && hit.s <= 1 + this.extentMargin;
        const cooled = now - state.lastCross >= this.cooldownMs;
        if (track.confirmed && withinExtent && cooled) {
          events.push({
            trackId: track.id,
            direction: side > 0 ? 'fwd' : 'rev',
            class: track.class,
            confidence: track.score,
            ts: now,
          });
          state.lastCross = now;
        }
        state.side = side;
      }
      state.pos = pos;
    }
    return events;
  }

  /** Drop per-track state for tracks no longer alive. */
  prune(liveTrackIds) {
    for (const id of this.#state.keys()) {
      if (!liveTrackIds.has(id)) this.#state.delete(id);
    }
  }
}
