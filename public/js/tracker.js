import { iou, boxCenter } from './geometry.js';

/**
 * Multi-object tracker: constant-velocity motion prediction (SORT-style)
 * with ByteTrack-style two-stage association.
 *
 * Stage 1 matches confident detections (score >= highThresh) to motion-
 * predicted track boxes by IoU, with a centroid-distance fallback for fast
 * movers. Stage 2 matches the *remaining* tracks against low-confidence
 * detections — the ByteTrack insight: a blurred or half-occluded vehicle
 * still produces a weak detection, which is enough to keep its track alive
 * and its trajectory continuous. Low-confidence detections never create new
 * tracks, so noise cannot conjure vehicles.
 *
 * Detections: [{ bbox: [x, y, w, h], class, score }] in video pixel space,
 * including low-score candidates (the detector's LOW_FLOOR).
 */
export class Tracker {
  #nextId = 1;

  constructor({
    iouThreshold = 0.15,
    minHits = 3,
    maxAgeMs = 1500,
    historyLen = 40,
    smoothing = 0.6,
    highThresh = 0.5,
    velocityGain = 0.5,
  } = {}) {
    this.iouThreshold = iouThreshold;
    this.minHits = minHits;
    this.maxAgeMs = maxAgeMs;
    this.historyLen = historyLen;
    this.smoothing = smoothing;
    this.highThresh = highThresh;
    this.velocityGain = velocityGain;
    this.tracks = [];
  }

  update(detections, now) {
    const high = [];
    const low = [];
    for (const d of detections) (d.score >= this.highThresh ? high : low).push(d);

    // Motion-predicted boxes make IoU matching robust at low detection rates
    // and for fast vehicles.
    const predicted = this.tracks.map((t) => this.#predictBbox(t, now));

    const unmatchedTracks = new Set(this.tracks.keys());
    const unmatchedHigh = new Set(high.keys());
    this.#associate(high, predicted, unmatchedTracks, unmatchedHigh, now, true);

    // Stage 2: leftover tracks may continue through weak detections.
    const unmatchedLow = new Set(low.keys());
    this.#associate(low, predicted, unmatchedTracks, unmatchedLow, now, false);

    for (const ti of unmatchedTracks) this.tracks[ti].misses += 1;
    for (const di of unmatchedHigh) this.tracks.push(this.#newTrack(high[di], now));
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= this.maxAgeMs);
    return this.tracks;
  }

  #associate(dets, predicted, unmatchedTracks, unmatchedDets, now, allowDistance) {
    const pairs = [];
    for (const ti of unmatchedTracks) {
      for (const di of unmatchedDets) {
        const overlap = iou(predicted[ti], dets[di].bbox);
        if (overlap >= this.iouThreshold) pairs.push([overlap, ti, di]);
      }
    }
    pairs.sort((p, q) => q[0] - p[0]);
    for (const [, ti, di] of pairs) {
      if (!unmatchedTracks.has(ti) || !unmatchedDets.has(di)) continue;
      this.#applyMatch(this.tracks[ti], dets[di], now);
      unmatchedTracks.delete(ti);
      unmatchedDets.delete(di);
    }
    if (!allowDistance) return;

    // Distance fallback: a very fast vehicle can move past bbox overlap.
    const distPairs = [];
    for (const ti of unmatchedTracks) {
      const p = predicted[ti];
      const pc = boxCenter(p);
      for (const di of unmatchedDets) {
        const det = dets[di];
        const c = boxCenter(det.bbox);
        const dist = Math.hypot(c.x - pc.x, c.y - pc.y);
        const reach = Math.hypot(det.bbox[2], det.bbox[3]);
        if (dist <= reach) distPairs.push([dist, ti, di]);
      }
    }
    distPairs.sort((p, q) => p[0] - q[0]);
    for (const [, ti, di] of distPairs) {
      if (!unmatchedTracks.has(ti) || !unmatchedDets.has(di)) continue;
      this.#applyMatch(this.tracks[ti], dets[di], now);
      unmatchedTracks.delete(ti);
      unmatchedDets.delete(di);
    }
  }

  #predictBbox(t, now) {
    const dt = Math.max(0, now - t.lastSeen);
    const [x, y, w, h] = t.bbox;
    return [x + t.vx * dt, y + t.vy * dt, w, h];
  }

  #newTrack(det, now) {
    const c = boxCenter(det.bbox);
    return {
      id: this.#nextId++,
      bbox: det.bbox,
      class: det.class,
      score: det.score,
      cx: c.x,
      cy: c.y,
      vx: 0, // px per ms
      vy: 0,
      hits: 1,
      misses: 0,
      confirmed: this.minHits <= 1,
      firstSeen: now,
      lastSeen: now,
      history: [{ x: c.x, y: c.y, t: now }],
    };
  }

  #applyMatch(track, det, now) {
    const c = boxCenter(det.bbox);
    const a = this.smoothing;
    const dt = now - track.lastSeen;
    const prevX = track.cx;
    const prevY = track.cy;
    track.cx = a * c.x + (1 - a) * track.cx;
    track.cy = a * c.y + (1 - a) * track.cy;
    if (dt > 0) {
      const g = this.velocityGain;
      track.vx = g * ((track.cx - prevX) / dt) + (1 - g) * track.vx;
      track.vy = g * ((track.cy - prevY) / dt) + (1 - g) * track.vy;
    }
    track.bbox = det.bbox;
    track.class = det.class;
    track.score = det.score;
    track.hits += 1;
    track.misses = 0;
    track.lastSeen = now;
    if (track.hits >= this.minHits) track.confirmed = true;
    track.history.push({ x: track.cx, y: track.cy, t: now });
    if (track.history.length > this.historyLen) track.history.shift();
  }
}
