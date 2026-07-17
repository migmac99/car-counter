# Car Counter — documentation

| Doc | Read this when you want to… |
|---|---|
| [user-guide.md](user-guide.md) | Run the app, draw counting lines and zones, read the stats, install it as a PWA, use it from a phone |
| [architecture.md](architecture.md) | Understand how the pieces fit together, what runs where, and the security/privacy model |
| [detection-and-tracking.md](detection-and-tracking.md) | Understand or tune the computer-vision pipeline (detector, tracker, counting algorithm) |
| [api.md](api.md) | Integrate with the REST API (events, stats, config) |
| [development.md](development.md) | Hack on the code: repo layout, tests, scripts, how releases/caching work |

**TL;DR of the system**: the browser does the computer vision (TensorFlow.js
COCO-SSD + a small IoU tracker + a line-crossing counter) and POSTs one tiny
JSON event per car crossing to a zero-dependency Bun server, which stores
events in SQLite and serves aggregated statistics back to the dashboard.
