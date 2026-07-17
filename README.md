# Car Counter

A self-hosted web app + PWA that turns any webcam into a traffic counter.
Point a camera at a road, draw a counting line across it, and get live and
historical counts of cars (and trucks, buses, motorcycles) per direction.

Detection and tracking run **entirely in the browser** with TensorFlow.js —
video never leaves the device. A small zero-dependency Bun server stores
crossing events in SQLite and serves aggregated statistics.

## Features

- **In-browser vehicle detection** with selectable models: YOLOX
  nano/tiny/s on ONNX Runtime Web (**WebGPU**, threaded-WASM fallback) or
  the lightweight TF.js COCO-SSD — all self-hosted
- **ByteTrack-style multi-object tracking** with constant-velocity motion
  prediction, stable IDs and motion trails — weak detections (blur,
  partial occlusion) keep tracks alive but can't create ghosts
- **Multiple directional counting lines** — two clicks each; every line counts
  both directions independently and events record which line fired
- **Multiple detection zones** — polygons that restrict where detection looks
- **Full shape editing** — click to select, drag to move, drag handles to
  reshape/rotate, Delete to remove, flip a line's direction
- **Lane mode** — draw one line across the road, say how many lanes: it
  splits into per-lane counting lines
- **Auto-detect road** — watches passing traffic for a few seconds, then
  suggests the road zone and a counting line automatically
- **Speed measurement** — two gate lines a known distance apart give
  per-vehicle speeds (perspective-robust timing method); set a speed limit
  and see over-limit counts in the stats and an average-speed chart
- **Digital zoom up to 10×** with drag-to-pan — detection runs on the zoomed
  crop, so zooming genuinely improves recall on distant traffic
- **Named presets** (stored server-side) plus config **export/import** as JSON
- **Session restore** — lines, zones, zoom, camera and view come back on
  reload; if it was counting, it resumes automatically
- **Live stats** — cars/min (last 60 s), 5-minute average, last hour, today, all-time
- **History** — minute/hour/day buckets with charts and a table view
- **Installable PWA** that keeps working offline and self-updates when online
- **Video-file mode** — analyze recorded footage instead of a live camera
- **Server-hosted counting engine** — the server itself captures the camera
  (ffmpeg) and counts (CoreML/CPU via ONNX Runtime), **24/7, with every
  browser closed**; the web UI is a live window onto it (server preview
  stream + live tracks). Browser-side detection remains as a fallback mode.
- **Zero npm dependencies** in the app — [Bun](https://bun.sh) built-ins only
  (`Bun.serve`, `bun:sqlite`); the optional engine keeps its one dependency
  isolated in `worker/`

## Quickstart

Requires Bun ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash` or `brew install bun`).

```sh
bun i        # installs everything: engine deps + ML runtimes + models (~45 MB)
bun dev      # ONE server: dashboard + storage + counting engine (hot reload)
bun start    # same, without hot reload
bun test     # run the unit + integration test suite
```

(`brew install ffmpeg` if you don't have it — it's the camera capture for
server-side counting. `bun run setup --model s` fetches the most accurate
YOLOX-s model.) Killing the server stops everything, capture included.

Open <http://localhost:3000>, click **Start server counting**, then
**Add line** and click two points across the road (you're drawing on the
server's own preview). The arrow shows which crossing direction counts as
*forward*. Close the browser — counting continues; the page is just a
window onto the server. Counts persist across restarts, and the engine
auto-starts with the server once enabled.

`PORT` and `HOST` environment variables override the defaults. Skipping
`bun run setup` also works — the app then loads the model from CDN.

## Documentation

| Doc | Contents |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | Setup, drawing lines/zones, stats, PWA install, HTTPS, troubleshooting |
| [docs/architecture.md](docs/architecture.md) | System design, data flow, security & privacy |
| [docs/detection-and-tracking.md](docs/detection-and-tracking.md) | The CV pipeline: model, tracker, counting algorithm, tuning |
| [docs/api.md](docs/api.md) | REST API reference |
| [docs/development.md](docs/development.md) | Repo layout, tests, scripts, release notes |

## License

MIT
