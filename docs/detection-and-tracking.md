# Detection, tracking and counting

The computer-vision pipeline runs per frame in the browser:

```
video frame → detect (COCO-SSD) → filter (class, confidence, zone)
            → track (IoU tracker) → count (line crossings) → event
```

## 1. Detection — `detector.js`

- Model: **COCO-SSD, `lite_mobilenet_v2` base** via TensorFlow.js. Small
  (~14 MB), fast (10–70 ms/frame on a laptop GPU via WebGL), good enough for
  street-level traffic scenes.
- Loading order: self-hosted `/vendor/` files (populated by `bun run setup`),
  falling back to jsDelivr + Google-hosted model when absent.
- Kept classes: `car`, `truck`, `bus`, `motorcycle` (user-filterable in
  Settings). Detections below the confidence threshold (default 0.5,
  range 0.3–0.8) are dropped.
- A `busy` flag skips frames while the previous inference is still running,
  so slow devices degrade to a lower detection rate instead of queueing.

**Known limitation:** COCO-SSD is trained on natural photos and performs
poorly on **steep top-down/overhead views** — a camera looking straight down
at a road may detect almost nothing. Mount the camera with a street-level or
moderately elevated side view. (Verified empirically: an overhead parking-lot
video yielded no detections while a side-view car was detected at 0.9+.)

## 2. Zone filter

If a detection zone (polygon) is drawn, detections whose **box center** falls
outside it are discarded before tracking. Use it to exclude a parking lane,
sidewalk, or the far carriageway.

## 3. Tracking — `tracker.js`

A pragmatic IoU tracker (SORT-style association without the Kalman filter,
which the counting task doesn't need):

1. **Greedy IoU matching** — all track×detection pairs with IoU ≥ 0.15 are
   sorted best-first; each track/detection is claimed at most once.
2. **Distance fallback** — unmatched pairs closer than one detection-box
   diagonal are matched by centroid distance, catching fast vehicles that
   moved past bbox overlap between frames.
3. **Lifecycle** — new detections open *tentative* tracks; a track is
   **confirmed** after `minHits = 3` matches (suppresses one-frame false
   positives) and dropped after `maxAgeMs = 1500` without a match.
4. **Smoothing** — the track centroid is an EMA (α = 0.6 toward the new
   position), damping detector jitter before it reaches the counter. The
   last 40 positions are kept as the trail drawn in the overlay.

## 4. Counting — `counter.js`

The counting line is a directed segment **A→B**; its on-screen arrow is the
normal pointing to the *positive* side. Crossing **onto the arrow side is
`fwd`**, the opposite is `rev` ("Flip direction" swaps A and B).

Per confirmed track, per frame:

1. Compute the signed perpendicular distance of the (smoothed) centroid to
   the line.
2. **Hysteresis band** (max(6 px, 1.2 % of frame height)): positions inside
   the band never change the track's remembered side, so jitter around the
   line cannot double-count. The remembered position only updates outside
   the band.
3. When the remembered side flips, the movement segment (last
   outside-the-band position → current position) must actually **intersect
   the drawn segment** (±8 % extent margin) — vehicles crossing the line's
   *extension* beyond its endpoints don't count.
4. **Cooldown** (2 s per track) absorbs oscillation right after a count while
   still allowing a genuine return trip to count as `rev`.

Each crossing emits `{ts, direction, class, confidence, trackId, line}` —
queued in localStorage and POSTed in batches; the queue survives reloads and
offline periods.

## 5. Speed — `speed.js`

When two lines are configured as **speed gates** with a known real-world
separation, a vehicle's speed is `distance ÷ (t₂ − t₁)` between its two gate
crossings. Timing-based measurement is deliberately chosen over
pixels-per-frame velocity: it needs no camera calibration and is unaffected
by perspective foreshortening. Systematic latencies (detector lag, centroid
smoothing) hit both gate timestamps equally and cancel; the residual error
is crossing-detection granularity (~1 frame per gate), so accuracy improves
with gate separation — aim for ≥ 1.5 s of travel between gates. Implausible
intervals (< 150 ms or > 2 min) are discarded. Verified against a synthetic
46.8 km/h vehicle: measured 46.1 km/h (−1.5 %).

## Auto-detected roads

"Auto-detect road" builds its suggestion from observed motion, not image
segmentation: confirmed track trajectories vote on a dominant travel axis
(double-angle circular mean, so opposing directions reinforce rather than
cancel), and the trajectory band — expanded by 20 % — becomes the road zone,
with a counting line placed across the middle. It needs ≥ 3 vehicles with
meaningful displacement and gives up after 30 s of quiet road.

## Tuning reference

| Parameter | Default | Where | Effect of raising |
|---|---|---|---|
| Confidence threshold | 0.5 | Settings UI | Fewer false detections, more misses |
| `iouThreshold` | 0.15 | `tracker.js` | Stricter association, more ID switches |
| `minHits` | 3 | `tracker.js` | Fewer ghost tracks, slower confirmation |
| `maxAgeMs` | 1500 | `tracker.js` | Survives longer occlusion, risks ID reuse across cars |
| `smoothing` α | 0.6 | `tracker.js` | Higher = snappier, noisier centroid |
| Hysteresis | 1.2 % of height | `main.js` (`syncCounterLine`) | Wider dead band around the line |
| `cooldownMs` | 2000 | `counter.js` | Longer immunity after each count |
| `extentMargin` | 0.08 | `counter.js` | Wider effective line ends |

## Practical accuracy tips

- Draw the line **perpendicular to travel**, roughly mid-frame, where
  vehicles are large and unoccluded.
- Prefer a viewpoint where vehicles stay visible ≥ 1 s (≥ 3 detections).
- Occlusion-heavy scenes (dense queues) undercount: two overlapping cars can
  merge into one detection. A zone that limits counting to a clear stretch
  helps.
- Night/IR footage lowers detector recall; lower the confidence threshold
  cautiously and verify against the overlay.
