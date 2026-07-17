# REST API reference

Base URL: the server origin (default `http://localhost:3000`). All bodies are
JSON. Errors return `{"error": "<message>"}` with an appropriate 4xx/5xx
status. There is no authentication — see the security note in
[architecture.md](architecture.md#security).

## `GET /api/health`

```json
{ "ok": true, "uptime": 12.3 }
```

## `POST /api/events`

Record crossing events (the frontend batches up to 200; hard cap 500 per
request, body limit 512 KB).

```json
{
  "events": [
    {
      "ts": 1784292960000,        // required — epoch ms of the crossing
      "direction": "fwd",         // required — "fwd" | "rev"
      "class": "car",             // optional — detector class (≤ 32 chars)
      "confidence": 0.91,         // optional — 0..1
      "trackId": 17,              // optional — integer, for debugging
      "source": "default"         // optional — camera/site label (≤ 64 chars)
    }
  ]
}
```

Validation: `ts` must not be more than 2 minutes in the future or 30 days in
the past. Response: `{ "inserted": 1 }`. Any invalid event rejects the whole
batch with 400 (the frontend drops batches rejected as malformed rather than
retrying them forever).

## `GET /api/stats/summary`

Live counters, each split by direction:

```json
{
  "now": 1784293000000,
  "perMinute": { "total": 3, "fwd": 2, "rev": 1 },
  "per5Min":   { "total": 9, "fwd": 6, "rev": 3, "ratePerMin": 1.8 },
  "lastHour":  { "total": 40, "fwd": 22, "rev": 18 },
  "today":     { "total": 310, "fwd": 160, "rev": 150 },
  "allTime":   { "total": 51234, "fwd": 26410, "rev": 24824 },
  "firstEventTs": 1780000000000,
  "lastEventTs": 1784292999000,
  "totalEvents": 51234
}
```

`today` starts at server-local midnight.

## `GET /api/stats/history?bucket=minute|hour|day&from=<ms>&to=<ms>`

Zero-filled, time-bucketed counts (server-local time). Defaults and caps:

| bucket | default range | maximum range |
|---|---|---|
| `minute` | last 60 min | 24 h |
| `hour` | last 60 h | 60 days |
| `day` | last 60 days | 400 days |

```json
{
  "bucket": "minute",
  "from": 1784289400000,
  "to": 1784293000000,
  "buckets": [
    { "key": "2026-07-17T13:56", "ts": 1784292960000, "fwd": 2, "rev": 1, "total": 3 }
  ]
}
```

`ts` is the bucket's start (epoch ms); `key` is its local-time label.

## `GET /api/config` / `PUT /api/config`

Arbitrary JSON object (≤ 32 KB) holding the app configuration. The frontend
stores:

```json
{
  "line": { "a": { "x": 0.08, "y": 0.55 }, "b": { "x": 0.92, "y": 0.55 } },
  "roi":  [ { "x": 0.1, "y": 0.2 }, "…" ],
  "minScore": 0.5,
  "classes": ["car", "truck", "bus", "motorcycle"],
  "countMode": "both"
}
```

Coordinates are normalized (0..1) relative to the video frame. `GET` returns
`{}` when nothing is stored; `PUT` responds `{ "ok": true }`.

## `DELETE /api/events?confirm=yes`

Deletes **all** recorded events. Returns 400 without `confirm=yes`.
