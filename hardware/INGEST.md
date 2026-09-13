# Sensor → Map: the wire contract

What the firmware talks to. Two contracts live side by side on `/api/ingest`:

- **v0.5 (current, 2026-09-10)** — the schema the real firmware ships. Bearer
  auth with one shared fleet token. This section.
- **Legacy (2026-08-08)** — the per-device-token contract from
  `SENSOR-DESIGN.md` §6, still served for `fake-device.js`. Sections 1–5 below.

---

## The v0.5 contract (what mercuril-01 actually sends)

```
POST /api/ingest
Content-Type: application/json
Authorization: Bearer <shared token>     # DEVICE_TOKEN env on the server
```

```json
{
  "device": "mercuril-01", "fw": "0.5", "uptime_s": 12345,
  "class": "OPEN", "depth": 0.123, "vel": 0.45, "dv": 0.0554,
  "range": 1.234, "dry": 1.357, "echo_pct": 100,
  "batV": 11.85, "batPct": 62, "src": "wifi"
}
```

Server behaviour, all deliberate:

- **Returns 200 fast** — insert, respond, then project onto the map afterwards.
- **`received_at` is stamped server-side.** The device has no clock; `uptime_s`
  is stored only so the plot can mark reboots (uptime going backwards).
- **`class`** ∈ `OPEN | WARNING | CLOSED | UNCAL | NO_TARGET` (case-folded).
- **Under `UNCAL`/`NO_TARGET`, `depth`/`vel`/`dv` are stored as NULL**, not the
  0.0 the firmware sends — zero is a measurement, null is an admission, and the
  plot must never draw a confident 0.0 the radar didn't take.
- Rows land in the `telemetry` table verbatim (full payload kept in `raw`).
- **Map projection:** if a map pin was provisioned with this `device_id`
  (POST `/api/devices` — the token it returns is unused on this path), the pin
  follows: `OPEN`→clear, `WARNING`/`CLOSED`→flooded, `UNCAL`/`NO_TARGET` hold
  the previous state. Measured D×V ≥ 0.30 overrides OPEN; only a newer
  positive OPEN below that trigger can reopen. Projection completes before 200.
- 401 = wrong token · 503 = `DEVICE_TOKEN` not configured on the server.

**Read it back:** `GET /api/series?device=mercuril-01&hours=24` returns the
array of records, oldest first (hours ≤ 336). `GET /api/telemetry/devices`
lists every device ever heard with its last report.

**See it:** `/telemetry` — depth/vel/dv against time with the class as a
coloured band, battery on its own strip, reboot markers, satellite points
ringed. Live-refreshes every 15 s.

**Bench-test it:** `TOKEN=<token> BASE=http://localhost:3000 node
hardware/fake-telemetry.js` walks a full flood cycle (UNCAL boot → rise →
CLOSED peak → recession → NO_TARGET dropout → a reboot) in this schema.

### Satellite (Rock7 / RockBLOCK)

Point the Rock7 delivery webhook at `POST /api/rock7?secret=<ROCK7_SECRET>`.
It takes the standard form-encoded delivery, hex-decodes `data`, and parses
two ASCII CSV formats:

**M2 — batched (current):**

```
M2,<seq>,<batV_cV>,<batPct>,<echo>,<n>,<dt_s>,<d0>,<v0>,<d1>,<v1>,...
```

Oldest sample first; depths in mm, velocities in cm/s, `-1` = missing.
Sample *i* is timestamped `transmit_time − (n−1−i)·dt` — Iridium's clock is
real even though the device's isn't. Each sample becomes its own telemetry
row (`src: "sat"`): `-1` lands as NULL, both-missing samples are `NO_TARGET`,
a d×v ≥ 0.30 is derived `CLOSED` (the AR&R stability threshold, and the only
class the server will ever invent), everything else is `UNCLASSED` — the plot
shows the measurements under a grey band because the device didn't judge and
the server won't pretend it did. Battery/echo describe the message, so they
attach to the newest sample only. ~70 bytes for 6 samples = 2 credits.

**M,1 — single sample (legacy):**

```
M,1,cls,depth_mm,vel_cms,n,dmin_mm,dmax_mm,echo_pct,seq,reason,flags
```

`cls` 0/1/2 → OPEN/WARNING/CLOSED (unknown code → UNCAL, which nulls the
numbers).

**Anything else is kept anyway** — a payload matching neither format goes
into the raw net (`raw_hooks`, tagged `rock7-unparsed`) with the decoded text
and all the Rock7 delivery fields. Catch first, decode later; nothing that
reaches the server is ever dropped. Device is resolved from `ROCK7_DEVICES`
env (`imei=device,imei=device`) or the `rock7_imei` set when provisioning.
Unmapped identifiers are retained in the net and never attributed to another unit. The endpoint
answers 200 once authorised even when parsing fails — Rock7 retries non-200s
for 24 h and a bad payload won't improve with retrying.

### The raw net — when the payload shape isn't settled yet

`POST /api/raw` accepts **anything** — any content-type, any encoding,
malformed JSON included — and remembers it verbatim with a server timestamp.
No schema, no validation, answers 200. Use it for firmware experiments whose
wire format doesn't exist yet: point the device at it, capture first, decide
what the fields mean later, then graduate the settled shape to `/api/ingest`.

- Auth is **recorded, not required**: send the same `Authorization: Bearer
  <DEVICE_TOKEN>` and the row is marked `authed=true`, separable from
  internet noise. No header still lands.
- Stored per row: `received_at`, content-type, source IP, headers (minus
  secrets), byte count, and the body three ways — verbatim text, parsed JSON
  when it parses, hex when it's binary. Up to 256 KB.
- Read back (admin only): `GET /api/raw?hours=24&limit=100` with
  `x-admin-key`. Newest first.

### Env summary (Railway)

| Var | Purpose |
|---|---|
| `DEVICE_TOKEN` | the shared Bearer token — ingest is OFF until set |
| `ROCK7_SECRET` | optional; if set, `/api/rock7` requires `?secret=` |
| `ROCK7_DEVICES` | optional `imei=device` map for multi-unit satellite |

---

## 1. Provision a device with confirmed deployment metadata

```bash
curl -X POST https://<host>/api/devices \
  -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"device_id":"bench-example","name":"Simulated bench example",
       "lon":151.5,"lat":-32.5,"deployment":"bench","simulated":true}'
```

Returns a `device_token`. **It is shown once.** That token goes in the firmware.

Units never carry `ADMIN_KEY` — that key also authorises deleting sensors and
triggering the ETL, so it must not exist inside a box bolted to a public post.
A leaked device token can only ever report readings for its own sensor.

Re-running the command preserves the token and updates location metadata; it does
not return the existing credential. New units have NULL depth, battery and last
observation until a device reports. The map labels the unobserved condition.

For a real crossing, supply `deployment: "installed"`, install-day `lon` and `lat`,
and a `location_note` recording their confirmation. Do not substitute a candidate
site for an actual install position. Reprovisioning an installed unit requires the
same explicit metadata. Otherwise provisioning defaults to a bench display pin,
which cannot create road closures or affect routing. Device IDs starting `bench-`
are always simulated. An existing simulated device cannot be relabelled as real.

Optional `rock7_imei` records the unit’s 15-digit satellite identifier in the
private database. Optional `report_interval_s` sets expected report cadence;
3600 means hourly reports. Set it from the firmware configuration, not just the
M2 sample spacing. Configure the Rock7 delivery URL as `/api/rock7` with the
configured secret; `/api/raw` captures bytes but does not decode or project them.

## 2. Post readings

```
POST /api/ingest
x-device-token: <the token>
content-type: application/json
```

```json
{
  "sensor_id": "MRC-001",
  "ts": "2026-08-17T04:12:33Z",
  "depth_mm": 187,
  "velocity_ms": 1.42,
  "dv_product": 0.27,
  "hazard_class": "H2",
  "rise_rate_mm_min": 4.1,
  "state": "wet",
  "confidence": 0.86,
  "batt_v": 7.9,
  "temp_c": 14.8,
  "tilt_deg": 44.2
}
```

Everything except `sensor_id` is optional. Send what works; add fields as they
come up. `depth_p95_mm`, `depth_p5_mm`, `velocity_spread`, `wet_50mm`,
`wet_150mm` are all accepted and stored even though the map doesn't draw them
yet.

Responds `{"ok":true,"sensor_id":8,"state":"flooded","depth_m":0.187}` —
`state` is what the public map is now showing, so the device can log whether it
was believed.

**Rate limit:** 240 requests/min. Hazard mode at 10 s intervals is well inside it.

### Field notes

| Field | Notes |
|---|---|
| `sensor_id` | The `device_id` string from provisioning. Required. |
| `ts` | ISO 8601. **Send it.** If omitted, the server stamps arrival time — a unit that buffered while offline would backdate everything to the moment it reconnected. |
| `depth_mm` | Integer millimetres. `depth_m` (float metres) also accepted. |
| `state` | One of `dry` / `wet` / `hazard` / `unknown`. Anything else is read as `unknown`. |
| `dv_product` | Depth × velocity, m²/s. **≥ 0.30 forces the road closed** regardless of `state` — the vehicle-stability threshold from AR&R. Confirm the exact figure against Book 6 Ch.7 before it goes on a slide; the server constant is easy to change. |
| `hazard_class` | `H1`–`H6`. **H2 or above forces the road closed.** |
| `batt_v` | Volts. Converted to a percentage assuming 2×18650 in series (6.0 V empty, 8.4 V full) — adjust `server.js` if the pack changes. |

### The two rules the server enforces

**1. It fails toward closed, never toward safe.** `unknown` does *not* clear a
flooded crossing — the previous state holds. A false "flooded" annoys a driver;
a false "clear" kills one. So a dead radar, a lost lock, or a confidence
collapse leaves the road shut until the device positively reports `dry`.

**2. Missing measurements stay missing.** Omitted channels are NULL in the latest
sample; earlier readings and closure-trigger evidence remain in history. Battery
and optional diagnostic metadata retain their previous values when absent.
An explicit legacy D×V ≥ 0.30 still closes even if `state` was omitted.

The map projection is transactional and completes before 200. Late OPEN and
same-time conflicting OPEN cannot reopen newer closures. A newer blind sample
cannot suppress a late hazard after the last positive decision. Active closure
evidence is available separately at `/api/sensor-closures`; government records
and counts remain government-only.

## 3. Heartbeat even when nothing changes

Every accepted post records contact; `last_seen` / `observed_at` follow the
latest sample time, so replayed satellite packets cannot appear freshly measured. A unit silent for **15 minutes** is flagged `stale` in the API — that
is how the map distinguishes *dry* from *dead*. On the dry-mode 6 h cadence
from §4, configure `report_interval_s` so sample age between scheduled reports
is presented as expected. Staleness never clears a closure.

## 4. Minimum viable ESP32 client

```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* INGEST = "https://<host>/api/ingest";
const char* TOKEN  = "<device_token>";

void report(int depth_mm, float vel, const char* state) {
  HTTPClient http;
  http.begin(INGEST);
  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-token", TOKEN);

  char body[256];
  snprintf(body, sizeof(body),
    "{\"sensor_id\":\"MRC-001\",\"depth_mm\":%d,\"velocity_ms\":%.2f,"
    "\"dv_product\":%.3f,\"state\":\"%s\",\"batt_v\":%.2f}",
    depth_mm, vel, (depth_mm / 1000.0) * vel, state, batteryVolts());

  int code = http.POST(body);   // 200 = accepted, 401 = bad token
  http.end();
}
```

Add `ts` once you have NTP or an RTC. Until then the server timestamp is fine
for bench work.

## 5. Test without hardware

`node hardware/fake-device.js` walks a crossing from dry to hazard and back,
posting real payloads. Use it to prove the pipeline, and to rehearse the
filming beat before the box exists.

```bash
ADMIN_KEY=... BASE=http://localhost:3000 node hardware/fake-device.js
```

---

## Gate 1, restated in terms of this document

> ESP32 + HC-SR04 + tub of water → `POST /api/ingest` returns 200 → the dot on
> the public map goes red inside 5 seconds → the route redraws around it.

The map half of that sentence is done and tested. What's left is the device half.
