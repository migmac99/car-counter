# Detection, tracking and counting

The computer-vision pipeline runs per frame — server-side in the engine
worker (the normal mode; see `architecture.md`) or in the browser as a
fallback. Both share the same modules (`yolox.js`, `tracker.js`,
`counter.js`), so behavior is identical:

```
frame → region crop (zones) → tile → detect (YOLOX) → seam-merge + NMS
      → filter (class, confidence, zone) → track → count (line crossings) → event
```

## 0. Region capture & tiled inference — *the model sees your zones*

The single biggest accuracy lever: **pixels outside your zones are never
sent to the model.** The engine computes the union bounding box of all
drawn zones (plus a small margin: 4 % horizontally, 20 % of the band
height vertically, so vehicles entering the band are seen early), crops
that region in ffmpeg, and scales it by a factor chosen to balance three
constraints (`regionScale`): upscale at most 1.6× (beyond that is
interpolation, not information), keep the region height within the model
input (416 px), and fit the width within a 4-tile budget.

A road band wider than one model input is covered by **overlapping tiles**
(`planTiles`, 25 % overlap, right-aligned tail). Tiling creates a seam
problem — a vehicle straddling two tiles appears as a clipped fragment in
each — solved by *reconstruction, not suppression*: each detection is
tagged with `clipLeft`/`clipRight` flags when it touches an inner tile
edge (`clipFlags`), and `mergeSeamFragments` unions horizontally-adjacent
clipped fragments of the same class (requiring ≥ 50 % vertical overlap so
different lanes never merge) back into one full-width vehicle before NMS.

Measured effect on a 1080p side-view road band (zone 22 % of frame
height): effective resolution on the road ~2.5–3× versus full-frame
letterboxing, and a distant-car recall that full-frame processing simply
does not have. The engine restarts automatically (1.2 s debounce) when
zones change, and the status chip reports `regionBox` and tile count.

Without zones the region is the visible view crop (digital zoom), else
the full frame — so drawing a tight road zone is both an accuracy *and* a
performance feature.

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
  square, BGR CHW floats, stride-grid decode) and is unit-tested in
  isolation. NMS is **two-tier**, tuned for counting: same-class duplicates
  suppress at IoU 0.5, but different-class boxes only merge above IoU 0.7 —
  so a car partly hidden behind a truck survives as two vehicles, while one
  vehicle the model hedges between "car" and "truck" stays a single
  detection instead of double-counting. A third tier handles **nesting by
  containment** (intersection ÷ smaller area): a same-class box ≥ 85 %
  inside a bigger one is the same vehicle seen twice (stretched
  frame-edge interpretation + tight interpretation), and a *different*-class
  box ≥ 95 % swallowed is a fragment (a "truck" cabin inside the car's
  box) — plain IoU misses both because the areas differ so much.
- The detection crop is capped at the **model's own input size** (416/640),
  so 1080p → model input is a single resample.
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
  can recover. If the server sees ~5 fps at 1080p in daylight, that is the
  USB-2 uncompressed cap — the native capture helper (see
  `architecture.md`) exists precisely to reach the camera's MJPEG 30 fps
  modes; make sure `worker/.bin/cc-capture` built during `bun i`. In real
  darkness, long exposure can still genuinely lower fps. The engine paces
  to real frames (`-fps_mode passthrough` for direct-ffmpeg cameras;
  AVFoundation otherwise pads to a constant rate with duplicates, measured
  115 fps of identical frames from a 30 fps camera).

**Known limitation:** COCO-SSD is trained on natural photos and performs
poorly on **steep top-down/overhead views** — a camera looking straight down
at a road may detect almost nothing. Mount the camera with a street-level or
moderately elevated side view. (Verified empirically: an overhead parking-lot
video yielded no detections while a side-view car was detected at 0.9+.)

## 2. Zone filter & plausibility gate

If a detection zone (polygon) is drawn, detections whose box **overlaps** it
are kept for tracking; those entirely outside are discarded. (This was a
strict *center-in-polygon* test, which silently dropped cars whose center
fell just outside a thin zone band while their body straddled it —
`boxOverlapsPolygon` fixed a real recall loss.) Use the zone to exclude a
parking lane, sidewalk, or the far carriageway.

Zones also feed a **size-sanity gate**: no real vehicle is taller or wider
than the road region you drew, so detections exceeding the zone's bounding
dimensions (+10 % slack) are rejected as detector hallucinations — dark or
low-texture scenes love producing huge phantom boxes over scattered lights.
Without zones, anything covering more than half the visible view is
rejected. Drawing an accurate road zone is the single best thing you can do
for night reliability.

## 2b. Scene mode (day / night)

Settings → Scene (default **auto**). The measured state combines three
defenses, each earned from a real failure:

1. **Hysteresis** (enter < 45, exit > 70 mean luma) so dusk doesn't flap.
   Thresholds are calibrated against a real road band: overcast daylight
   with heavy bridge shadow measures 68–76; real night sits below 40.
2. **Dwell** (`SceneState`, 10 s): a flipped reading must persist before
   the mode changes. Plain hysteresis is not enough when luma is sampled
   over the road band — at night every passing car's headlights spike the
   mean into "day" for a couple of seconds, and each spike would retune
   tracking mid-vehicle. Dusk and dawn are gradual, so real transitions
   always outlast the dwell.
3. **Boot warmup** (2.5 s): auto-exposure starts dark; judging the scene
   before it converges latches night mode in daylight.

At night the pipeline retunes (association threshold relaxes, `minHits`
3 → 4, deeper smoothing, longer track memory, wider crossing dead-band)
**and the detection feed gets a shadow lift** (`eq=gamma=1.5` in the
capture chain — the preview keeps showing reality). Night state survives
engine restarts so the filter doesn't cold-start wrong. The active mode
shows in the perf chip (`· night`).

## 2c. Focus watchdog

Webcams hunt and stick out of focus in low light. The engine samples the
detection region's **variance of Laplacian** (`sharpness` in `scene.js`,
~1 Hz) against a slowly-decaying peak baseline; sustained softness (< 40 %
of baseline for 6 s) sends a `refocus` command to the capture helper,
which kicks the camera through a one-shot autofocus scan back to
continuous AF (rate-limited to one nudge per 30 s; `refocused` in the
engine status counts them). Textureless scenes (deep night, fog) stay
below the arm floor so autofocus never hunts on nothing. File inputs skip
the watchdog entirely.

### Recall on distant / low-contrast roads

Small, soft, low-contrast vehicles (a far road seen through glass, or under
flat/back-lit conditions) sit near YOLOX's detection floor: per-frame recall
becomes sporadic (a real car is caught in perhaps 40 % of frames) and it
**varies with the light** — the same road detects far better at a high-sun,
high-contrast hour than under haze or glare. Findings from tuning against a
real distant highway feed:

- **Model:** yolox-**tiny** matched or beat yolox-s on these tiny boxes *and*
  runs at twice the frame rate. More frames beat a heavier per-frame model,
  because tracking depends on frame rate. yolox-s is the right pick only when
  vehicles are reasonably large.
- **Upscale:** pushing the region past ~1.6× does **not** help — interpolated
  pixels add no information the detector can use, and the extra tiles cut the
  frame rate. (Large, close vehicles are a different story; the cap still
  applies.)
- **Contrast/gamma enhancement HURTS in daylight.** A washed-out frame has
  low signal-to-noise; boosting contrast amplifies the noise too and
  *collapsed* detection in testing (6 → 0). The detection feed is left
  untouched by day. (Night is a separate regime — see §2c.)
- **Bridge the gaps, don't fake the pixels.** Since detection is sporadic but
  the *tracker* holds identity, a confirmed track is displayed for up to
  450 ms after its last real detection with its box motion-predicted forward
  (§3), so a car reads as one steady box instead of flickering in and out.
  This changes what you see, never the counts (counting runs on raw tracks).

The single biggest lever remains **image quality at the source**: a sharper,
higher-contrast view (better light, cleaner glass, a longer physical lens)
helps more than any software knob. The perf chip's live detection rate and
the engine's `detCount` show how many vehicles are actually being found each
frame.

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
   Two anti-duplication rules keep one physical vehicle to one track:
   a new detection **substantially inside a confirmed track's box**
   (containment > 0.8, any class) cannot spawn a track — it is a fragment
   of that vehicle; and if twin same-class tracks end up nested
   (containment > 0.75, e.g. after a tile-seam flap), the
   better-established one survives (`#pruneNestedTracks`). Temporal
   identity catches what per-frame NMS can miss across frames.
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
4. **Trajectory gate** — the crossing direction must agree with the
   track's *physical displacement* over the last 700 ms of history
   (`historyDirection`). Smoothed instantaneous velocity flips sign under
   a single teleporting association; 700 ms of accumulated displacement
   does not. A track with too little history (< 250 ms span) or genuinely
   ambiguous motion is given the benefit of the doubt.
5. **Cooldown** (2 s per track) absorbs oscillation right after a count while
   still allowing a genuine return trip to count as `rev`.
6. **Duplicate guard** — per-track cooldowns can't stop a *fragment track*
   (different id) crossing right behind its vehicle, which is exactly what
   night tuning surfaced in E2E (5 counts on a 4-crossing video). A
   same-direction crossing of the same line within 800 ms at nearly the
   same spot is one car; "same spot" is scoped to the vehicle's own box
   size, so adjacent lanes are never suppressed and a genuine tailgater
   past the window still counts.

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
46.8 km/h vehicle: measured 46.1 km/h (−1.5 %); on the tiled 1080p region
path, 48.6/46.9 km/h (within 4 %).

**Velocity for every vehicle.** The gate separation also calibrates a
pixels-per-meter scale (`gateCalibration`), giving EVERY confirmed track a
continuous km/h estimate — shown as `~52 km/h` on its label and recorded on
crossing events with an `est` flag when no exact gate-pair measurement
exists. The estimator is the **median of per-step speeds** over the last
~0.9 s of the track's smoothed path (`historyKmh`): detector box flapping
teleports the centroid for a frame, which made a velocity-EMA estimate read
126 km/h on a ground-truth 46.8 km/h car; the median discards spike frames
and reads within ~8 % (measured 49.8–51.1). Estimates are indicative — a
single global scale ignores perspective — while gate-pair timing remains
the accurate record (±2 %).

Only velocities are stored; **`over` is evaluated against the limit at
query time**, so changing the speed limit reclassifies all history within
the retention window.

**Known limitation:** exact speed pairing requires the *same track id* at
both gates. On zones wide enough to need several tiles, a vehicle
occasionally hands identity to a new track mid-pass (a seam flap at the
wrong moment) — the count is unaffected, and since every crossing now
records the calibrated estimate, the pass still contributes speed data
(flagged `est`) instead of vanishing from the statistics.

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
| `DIRECTION_WINDOW_MS` | 700 | `counter.js` | Longer trajectory memory for the direction gate |
| Region margin | 4 % / 20 % band | `engine.js` (`computeRegion`) | More context around zones, fewer pixels on the road |
| Upscale cap | 1.6× | `yolox.js` (`regionScale`) | Interpolation past ~1.6× adds no information |
| Tile overlap | 25 % of input | `yolox.js` (`planTiles`) | Fewer seam fragments, more tiles |
| Seam-merge vertical overlap | 0.5 | `yolox.js` (`mergeSeamFragments`) | Stricter lane separation at seams |
| Spawn containment | 0.8 | `tracker.js` (`#nestedInConfirmed`) | Stricter = fewer fragment tracks, risks missing a real nested vehicle |

## Practical accuracy tips

- Draw the line **perpendicular to travel**, roughly mid-frame, where
  vehicles are large and unoccluded.
- Prefer a viewpoint where vehicles stay visible ≥ 1 s (≥ 3 detections).
- Occlusion-heavy scenes (dense queues) undercount: two overlapping cars can
  merge into one detection. A zone that limits counting to a clear stretch
  helps.
- Night/IR footage lowers detector recall; lower the confidence threshold
  cautiously and verify against the overlay.
