# Car Counter

A self-hosted web app + PWA that turns any webcam into a traffic counter.
Point a camera at a road, draw a counting line across it, and get live and
historical counts of cars (and trucks, buses, motorcycles) per direction.

Detection and tracking run **entirely in the browser** with TensorFlow.js —
video never leaves the device. A small zero-dependency Bun server stores
crossing events in SQLite and serves aggregated statistics.

## Features

- **In-browser vehicle detection** (COCO-SSD, self-hosted model, CDN fallback)
- **Multi-object tracking** with stable IDs and motion trails
- **Directional counting line** — draw it with two clicks, flip its direction;
  crossings are counted separately per direction
- **Optional detection zone** — restrict counting to a polygon you draw
- **Live stats** — cars/min (last 60 s), 5-minute average, last hour, today, all-time
- **History** — minute/hour/day buckets with charts and a table view
- **Installable PWA** that keeps working offline (model included)
- **Video-file mode** — analyze recorded footage instead of a live camera
- **Zero npm dependencies** — [Bun](https://bun.sh) built-ins only (`Bun.serve`, `bun:sqlite`)

## Quickstart

Requires Bun ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash` or `brew install bun`).

```sh
bun run setup   # one-time: download the ML runtime + model (~16 MB) for self-hosting
bun start       # serve on http://localhost:3000
bun test        # run the unit + integration test suite
```

Open <http://localhost:3000>, click **Start camera**, then **Set counting line**
and click two points across the road. The arrow shows which crossing direction
counts as *forward*. That's it — counts persist across restarts.

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
