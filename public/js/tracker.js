import { iou, boxCenter } from './geometry.js';

/**
 * Multi-object tracker using greedy IoU association with a centroid-distance
 * fallback for fast movers. Tracks become `confirmed` after `minHits`
 * consecutive-ish detections and are dropped after `maxAgeMs` unseen.
 *
 * Detections: [{ bbox: [x, y, w, h], class, score }] in video pixel space.
 */
export class Tracker {
  #nextId = 1;

  constructor({ iouThreshold = 0.15, minHits = 3, maxAgeMs = 1500, historyLen = 40, smoothing = 0.6 } = {}) {
    this.iouThreshold = iouThreshold;
    this.minHits = minHits;
    this.maxAgeMs = maxAgeMs;
    this.historyLen = historyLen;
    this.smoothing = smoothing;
    this.tracks = [];
  }

  update(detections, now) {
    const unmatchedDets = new Set(detections.keys());
    const unmatchedTracks = new Set(this.tracks.keys());

    // Greedy IoU matching: best overlaps claim their pair first.
    const pairs = [];
    for (const ti of unmatchedTracks) {
      for (const di of unmatchedDets) {
        const overlap = iou(this.tracks[ti].bbox, detections[di].bbox);
        if (overlap >= this.iouThreshold) pairs.push([overlap, ti, di]);
      }
    }
    pairs.sort((p, q) => q[0] - p[0]);
    for (const [, ti, di] of pairs) {
      if (!unmatchedTracks.has(ti) || !unmatchedDets.has(di)) continue;
      this.#applyMatch(this.tracks[ti], detections[di], now);
      unmatchedTracks.delete(ti);
      unmatchedDets.delete(di);
    }

    // Distance fallback: a fast car can move past IoU overlap between frames.
    const distPairs = [];
    for (const ti of unmatchedTracks) {
      const t = this.tracks[ti];
      for (const di of unmatchedDets) {
        const det = detections[di];
        const c = boxCenter(det.bbox);
        const dist = Math.hypot(c.x - t.cx, c.y - t.cy);
        const reach = Math.hypot(det.bbox[2], det.bbox[3]); // one box diagonal
        if (dist <= reach) distPairs.push([dist, ti, di]);
      }
    }
    distPairs.sort((p, q) => p[0] - q[0]);
    for (const [, ti, di] of distPairs) {
      if (!unmatchedTracks.has(ti) || !unmatchedDets.has(di)) continue;
      this.#applyMatch(this.tracks[ti], detections[di], now);
      unmatchedTracks.delete(ti);
      unmatchedDets.delete(di);
    }

    for (const ti of unmatchedTracks) this.tracks[ti].misses += 1;
    for (const di of unmatchedDets) this.tracks.push(this.#newTrack(detections[di], now));
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= this.maxAgeMs);
    return this.tracks;
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
    track.cx = a * c.x + (1 - a) * track.cx;
    track.cy = a * c.y + (1 - a) * track.cy;
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
