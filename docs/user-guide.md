# User guide

## Requirements

- [Bun](https://bun.sh) **≥ 1.1** (`curl -fsSL https://bun.sh/install | bash`
  or `brew install bun`)
- A browser with WebGL (any current Chrome/Edge/Safari/Firefox)
- A webcam with a view of the road — street-level or moderately elevated
  side views work best (avoid straight-down overhead angles; see
  [detection-and-tracking.md](detection-and-tracking.md))

## Install & run

```sh
bun run setup   # one-time, optional but recommended: self-host the ML model (~16 MB)
bun start       # http://localhost:3000   (PORT=8080 bun start to change)
```

Without `bun run setup` the browser loads the model from CDN instead — fine
online, but the PWA then needs connectivity on first use.

## Counting cars

1. **Start camera** (or **Open video…** to analyze a recorded clip — clips
   loop automatically). Pick a specific camera from the dropdown if you have
   several; the list gets labels after the first permission grant.
2. **Add line**, then click two points across the road. Cars are counted the
   moment their tracked center crosses a line. Add as many lines as you need
   (one per lane or per approach) — each counts independently, and every
   recorded event remembers which line fired.
   - The small arrow shows which crossing direction is **forward**;
     **Flip direction** reverses the selected line.
   - Draw lines perpendicular to traffic, roughly mid-frame.
3. Optional — **Add zone**: click vertices around an area to watch
   (double-click or Enter to close, Escape to cancel). Detections outside
   all zones are ignored — useful to exclude parked cars or a second road.
4. Watch the overlay: white boxes are tracked vehicles with IDs, blue trails
   show their paths, and a pulse marks each count.

While a source is running, the header shows a **performance chip**:
`1920×1080 @30 · det 30/s · 12 ms · webgpu` — camera resolution @ actual
camera fps, detections per second, inference latency, and which execution
provider is running (webgpu is the fast path; `wasm×N` is the CPU
fallback). Detection is paced one-to-one
with camera frames, so `det ≈ fps` means you are processing every frame in
real time. The chip turns red if the camera delivers under 15 fps (usually
low light forcing long exposures, or USB bandwidth) — fix lighting or lower
resolution, because low camera fps also means motion blur the detector
can't see through.

### Lanes and auto-detection

- **Add lanes…** asks how many lanes the road has, then lets you draw ONE
  line across the whole road — it is split into that many per-lane counting
  lines (with small gaps so one car can't fire two lanes). Flip individual
  lanes afterwards for two-way roads.
- **Auto-detect road** gets you started without drawing: it watches passing
  traffic for a few seconds (at least three vehicles), infers the dominant
  travel axis from their trajectories, and creates a road zone plus a
  counting line perpendicular to travel. Adjust the shapes afterwards —
  it's a starting point, not a survey.

### Measuring speed

Speed uses two **gate lines** a known real-world distance apart (the
distance between two road markings, lamp posts, etc. — measure it or read
it off satellite imagery). In **Settings → Speed gates** pick the two lines,
enter the distance in meters and optionally a speed limit:

- Each vehicle that crosses both gates gets a speed
  (distance ÷ time between crossings — robust to camera perspective) shown
  on its overlay label, red when over the limit.
- The Live panel gains **avg km/h** and **over limit today** tiles, and the
  History panel gains an average-speed chart with the limit drawn as a
  reference line and over-limit buckets marked.

Accuracy depends on the declared distance and on the gates being far enough
apart that timing granularity doesn't matter (aim for ≥ 1.5 s of travel
between gates; in verification a synthetic 46.8 km/h vehicle measured
46.8 km/h). When zoomed, keep both gates **well inside the visible view**
(≥ ~15 % from its edges) — vehicles entering the view are only partially
visible, which skews their position and therefore the crossing time.
Speeds are indicative — this is not a calibrated enforcement instrument.

### Editing shapes

Click any line or zone to select it (it highlights and shows handles):

- **Move** — drag the shape's body.
- **Reshape / rotate / scale** — drag a line endpoint or zone vertex.
- **Remove** — press Delete/Backspace or the **Remove selected** button.
- **Escape** deselects (or cancels an in-progress drawing).

### Zoom

The **Zoom** slider (1–10×) magnifies the view; drag the video to pan while
zoomed. This is not just cosmetic: **the detector sees exactly what you see**
— the zoomed crop is what gets analyzed — so zooming into a distant road
materially improves detection of far-away vehicles. Lines and zones stay
anchored to the road (full-frame coordinates) while the overlay stays crisp
at any zoom. For deep zooming, cameras are asked for 1080p.

### Presets and config files

Everything you configure (lines, zones, zoom, settings) is saved on the
server automatically and restored on every load — on any device on your
network. If the camera was running when you left, counting **resumes
automatically** on the next visit.

- **Save preset…** (in Settings) stores the current setup under a name on
  the server; pick it from the **Preset** dropdown to load it later —
  useful for multiple camera positions.
- **Export config** downloads the same setup as a JSON file;
  **Import config…** loads one — handy for backups or moving to another
  server.

### Settings

- **Model**: YOLOX-tiny (default) is the accuracy/speed sweet spot and far
  better than COCO-SSD on small, distant vehicles; YOLOX-s (fetch with
  `bun run setup --model s`) is the most accurate; COCO-SSD remains as the
  lightest option with a CDN fallback. Switching takes effect immediately.
- **Min confidence** (0.15–0.8): raise it if shadows/bushes get counted,
  lower it if cars are missed. Default 0.5. Distant/blurry cameras often
  need 0.2–0.3 — pair a low threshold with a detection zone over the road
  so foliage can't produce false counts. (Below the threshold, weak
  detections still help *keep tracking* already-confirmed vehicles — they
  just can't start a new count.)
- **Vehicle classes**: cars, trucks, buses, motorcycles.
- **Count**: both directions, forward only, or reverse only — affects the
  displayed totals; both directions are always recorded.
- **Delete all history…**: wipes every stored event (asks for confirmation).

## Reading the statistics

- **cars/min · last 60 s** — crossings in the last rolling minute.
- **avg cars/min · last 5 min** — smoother short-term rate.
- **last hour / today / all time** — running totals (server-local midnight).
- **forward / reverse** — today's split by direction.
- **Sparkline** — per-minute counts over the last 30 minutes.
- **History** — minute, hour or day buckets over a selectable range, as a
  stacked bar chart (blue = forward, green = reverse) with hover details and
  a table view underneath.

Counts survive restarts — they live in `data/car-counter.sqlite`.

## Installing as an app (PWA)

Click **Install app** in the header (or the browser's install icon in the
address bar). The installed app works offline: interface and model load from
cache, and crossings counted while the server is unreachable are queued in
the browser and uploaded automatically when it's back.

**Updates are automatic.** The app fetches the latest code from your server
on every online launch, checks hourly while it stays open, and reloads onto
new versions when they arrive — installed or not. The **↻ Reload** button in
the header forces a check right now.

## Running unattended (kiosk mode)

Counting happens **in the browser page** — the server only stores results.
For continuous counting:

- **Keep the page open.** Closing the tab stops the camera and the
  counting; the server keeps serving stats but records nothing new. The
  installed PWA in its own window is the most robust way to leave it
  running.
- **Hidden or minimized windows count at reduced rate.** Browsers throttle
  background pages to roughly one processing tick per second — enough for
  slow roads, but fast highway traffic will be undercounted. Keep the
  window visible (it can be small, or on a spare desktop/display) for full
  frame-rate counting.
- **Prevent system sleep.** Sleep pauses everything (server included);
  counting resumes on wake. On macOS: `caffeinate -dis` while it runs, or
  System Settings → prevent sleeping. The camera is re-acquired
  automatically after wake or a USB hiccup (the app retries for ~2
  minutes, then asks for a click).
- If it was counting when the page closed, it **auto-resumes** on the next
  visit — so an unattended machine that reboots into the browser recovers
  by itself.

## Using a phone or another device as the camera

Browsers only allow camera access on `localhost` or **HTTPS**. From another
device, `http://<your-ip>:3000` will load but the camera button will fail.
Options:

- **Port forward over SSH** from the viewing device:
  `ssh -L 3000:localhost:3000 user@server` → open `http://localhost:3000`.
- **Reverse proxy with TLS** (Caddy makes this a two-liner) in front of the
  server, which also lets you add authentication.

The dashboard itself (stats, history, configuration) works fine over plain
HTTP from any device — only the camera needs the secure context.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "camera unavailable" | Grant camera permission; make sure the page is on localhost or HTTPS; close other apps using the camera |
| "model failed to load" | Run `bun run setup` on the server, or check connectivity for the CDN fallback |
| Nothing gets detected | Check the viewpoint (avoid overhead angles), raise camera resolution, lower Min confidence, make sure vehicles are reasonably large in frame |
| Only some vehicles counted | Lower Min confidence (distant/blurry cars score low); switch to a stronger model (YOLOX-s); check the perf chip — `det/s` should match camera fps, and `webgpu` beats `wasm` |
| Cars counted twice | Raise Min confidence; draw the line where traffic doesn't stop on it; the built-in hysteresis+cooldown handles normal jitter |
| Counts missed | Line too close to the frame edge (tracks need ≥ 3 detections before counting); occlusion in dense traffic; try a cleaner stretch of road |
| Stats not updating | The event queue uploads every 3 s — check the server is running; offline events appear after reconnect |
