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
2. **Set counting line**, then click two points across the road. Cars are
   counted the moment their tracked center crosses this line.
   - The small arrow shows which crossing direction is **forward**;
     **Flip direction** reverses it.
   - Draw the line perpendicular to traffic, roughly mid-frame.
3. Optional — **Draw zone**: click vertices around the area to watch
   (double-click or Enter to close, Escape to cancel). Detections outside
   the zone are ignored — useful to exclude parked cars or a second road.
   **Clear zone** removes it.
4. Watch the overlay: white boxes are tracked vehicles with IDs, blue trails
   show their paths, and a pulse marks each count.

Everything you configure (line, zone, settings) is saved on the server
automatically and restored on every load — on any device on your network.

### Settings

- **Min confidence** (0.3–0.8): raise it if shadows/bushes get counted,
  lower it if cars are missed. Default 0.5.
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
| Cars counted twice | Raise Min confidence; draw the line where traffic doesn't stop on it; the built-in hysteresis+cooldown handles normal jitter |
| Counts missed | Line too close to the frame edge (tracks need ≥ 3 detections before counting); occlusion in dense traffic; try a cleaner stretch of road |
| Stats not updating | The event queue uploads every 3 s — check the server is running; offline events appear after reconnect |
