import { signedDistance, intersectionParams, positiveNormal } from './geometry.js';

const DIRECTION_WINDOW_MS = 700;
const DIRECTION_MIN_SPAN_MS = 250;

/**
 * Sustained travel direction along a line's normal, from trajectory history:
 * displacement over the last ~700 ms divided by elapsed time (px/ms).
 * Null when the track is too young to judge.
 */
function historyDirection(history, n) {
  if (!history || history.length < 2) return null;
  const nowPt = history[history.length - 1];
  let past = history[0];
  for (let i = history.length - 2; i >= 0; i--) {
    past = history[i];
    if (nowPt.t - history[i].t >= DIRECTION_WINDOW_MS) break;
  }
  const dt = nowPt.t - past.t;
  if (dt < DIRECTION_MIN_SPAN_MS) return null;
  return ((nowPt.x - past.x) * n.x + (nowPt.y - past.y) * n.y) / dt;
}

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
  #lastByDir = new Map(); // direction -> { ts, pos, radius } (duplicate guard)

  constructor({ hysteresis = 8, cooldownMs = 2000, extentMargin = 0.08, duplicateMs = 800 } = {}) {
    this.hysteresis = hysteresis;
    this.cooldownMs = cooldownMs;
    this.extentMargin = extentMargin;
    this.duplicateMs = duplicateMs;
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
          this.#state.set(track.id, { side: Math.sign(dist), pos, lastCross: -Infinity });
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
        // Physics gate: the track's sustained direction of travel must agree
        // with the crossing direction. Detector box snaps (tight box ↔
        // motion-smear box) teleport the centroid backwards across a line
        // for a frame — and even smoothed velocity flips under a large
        // jump — so direction comes from ~700 ms of trajectory history,
        // which no single-frame artifact can outvote.
        const n = positiveNormal(a, b);
        const motion = historyDirection(track.history, n);
        const velocityAgrees =
          motion === null || Math.abs(motion) < 0.005 || Math.sign(motion) === side;
        // Duplicate guard: per-track cooldowns can't stop a FRAGMENT track
        // (different id) crossing right behind its vehicle. A same-direction
        // crossing within duplicateMs at nearly the same spot is one car —
        // "same spot" is scoped to the vehicle's own box size, so adjacent
        // lanes (different y) are never suppressed.
        const direction = side > 0 ? 'fwd' : 'rev';
        const last = this.#lastByDir.get(direction);
        const radius = Math.max(track.bbox?.[2] ?? 0, track.bbox?.[3] ?? 0, 4 * this.hysteresis);
        const duplicate =
          last &&
          now - last.ts < this.duplicateMs &&
          Math.hypot(pos.x - last.pos.x, pos.y - last.pos.y) < Math.max(radius, last.radius);
        if (track.confirmed && withinExtent && cooled && velocityAgrees && !duplicate) {
          events.push({
            trackId: track.id,
            direction,
            class: track.class,
            confidence: track.score,
            ts: now,
          });
          state.lastCross = now;
          this.#lastByDir.set(direction, { ts: now, pos, radius });
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
