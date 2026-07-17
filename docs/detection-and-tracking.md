# Detection, tracking and counting

The computer-vision pipeline runs per frame in the browser:

```
video frame → detect (COCO-SSD) → filter (class, confidence, zone)
            → track (IoU tracker) → count (line crossings) → event
```

## 1. Detection — `detector.js` (+ `yolox.js`)

Selectable backends (Settings → Model), all running locally in the browser:

| Model | Runtime | Input | COCO mAP | Measured latency* | Size |
|---|---|---|---|---|---|
| COCO-SSD (ssdlite_mobilenet_v2) | TF.js / WebGL | 300² | ~21 | 23 ms | 14 MB |
| YOLOX-nano | ONNX Runtime Web / WebGPU | 416² | 25.8 | ~8 ms | 3.6 MB |
| **YOLOX-tiny (recommended)** | ONNX Runtime Web / WebGPU | 416² | **32.8** | **12 ms** | 20 MB |
| YOLOX-s (`setup --model s`) | ONNX Runtime Web / WebGPU | 640² | 40.5 | ~25 ms | 36 MB |

\* Apple-silicon laptop. Without WebGPU, ONNX models fall back to
multithreaded WASM (the server sends COOP/COEP so threads are available) —
several times slower but functional.

The YOLOX family (Apache-2.0, official prebuilt ONNX) is dramatically better
than COCO-SSD on **small and distant vehicles** — the dominant failure mode
for road cameras. 2026's absolute-best detectors (RF-DETR, YOLOv12) score
higher still on paper, but ship without browser-ready ONNX exports or carry
AGPL licensing; the events API accepts any external producer if you ever
outgrow in-browser inference.

- YOLOX pre/post-processing lives in `yolox.js` (letterbox to the input
  square, BGR CHW floats, stride-grid decode, class-agnostic NMS) and is
  unit-tested in isolation.
- Kept classes: `car`, `truck`, `bus`, `motorcycle` (user-filterable).
- The detector returns **all candidates down to score 0.1** — the
  confidence slider decides what counts as a firm detection, while weaker
  ones feed the tracker's second-stage association (below).
- A `busy` flag skips frames while the previous inference is still running,
  so slow devices degrade to a lower detection rate instead of queueing.

### Real-time performance

- Detection is **paced to camera frames** (`requestVideoFrameCallback`), so
  every new frame is processed exactly once — no wasted inference on
  duplicate frames, no missed ones while the loop idles.
- The detector input is capped at **640 px** on the longer side: the network
  resizes to 300×300 internally, so anything larger only costs GPU texture
  upload (1080p → 640×360 cuts upload ~9× with no accuracy change). When
  zoomed, the visible crop is what gets scaled.
- Measured on an Apple-silicon laptop (WebGL backend): ~12–23 ms per
  inference — real-time headroom for 30 fps cameras. The header perf chip
  shows the live numbers.
- Cameras are asked for 1080p @ 30 fps; the chip warns below 15 fps, where
  motion blur (long exposures) starts hurting recall more than any software
  can recover.

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

SORT/ByteTrack-style tracking, tuned for the counting task:

1. **Motion prediction** — each track carries a smoothed velocity
   (constant-velocity model); association happens against the *predicted*
   box position, which keeps identities stable at low detection rates and
   for fast vehicles.
2. **Stage 1: greedy IoU matching** of confident detections
   (score ≥ the confidence slider) against predicted boxes, plus a
   centroid-distance fallback for movers beyond bbox overlap.
3. **Stage 2 (ByteTrack)** — tracks still unmatched get a second pass
   against **low-confidence detections** (0.1 ≤ score < slider). A blurred
   or half-occluded vehicle still produces a weak detection; that is enough
   to keep its track alive and its trajectory continuous. Weak detections
   never *create* tracks, so noise cannot conjure vehicles.
4. **Lifecycle** — new confident detections open *tentative* tracks; a track
   is **confirmed** after `minHits = 3` matches (suppresses one-frame false
   positives) and dropped after `maxAgeMs = 1500` without a match.
5. **Smoothing** — the track centroid is an EMA (α = 0.6 toward the new
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
| Confidence threshold | 0.5 (0.15–0.8) | Settings UI | Fewer false detections, more misses |
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
