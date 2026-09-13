# MercuriL — the map that sees the flood

Live prototype for the MercuriL flood road-safety network (UNSW Peter Farrell Cup 2026).

A Google-Maps-style web app (desktop + mobile) with one switch:

- **Today** — a comparison route on the real road network with sensor avoidance disabled. Government records remain visible; this does not reproduce another navigation app.
- **With MercuriL** — instrument closures and labelled demonstration floods trigger avoidance routing. Satellite latency follows the unit’s configured report cadence.

## What's real vs simulated

| Layer | Status |
|---|---|
| Government closures (grey dots) | **Real** — the federal [Roadworks and Road Closures](https://catalogue.data.infrastructure.gov.au/dataset/harmonised-national-roadworks-and-road-closures) dataset (Dept of Infrastructure, CC-BY 4.0), NSW slice (~103k records), synced daily into Postgres |
| Road network + routing | **Real** — OSM road graph via FOSSGIS Valhalla (`exclude_polygons` for flood avoidance), OSRM fallback |
| Search | **Real** — Photon geocoding, AU-biased |
| Installed device pins / red double-ring closures | **Real instrument reports** — provisioned `device_id`, `deployment=installed`, confirmed location note. Separate `sensor_closures` table and `/api/sensor-closures`; never mixed into government records |
| Bench device pins | **Real hardware, bench only** — labelled display position, no road closure or routing effect; install coordinates remain unconfirmed |
| Brass-outline pins / `bench-*` devices | **Simulated** — `/admin` drives unprovisioned pins; simulated telemetry devices stay labelled. Their floods affect demonstration routing and route warnings say so |
| Telemetry console | Raw device class and measurements, with explicit real/bench/simulated/unverified identity and a separate server-derived closure flag |
| Closure provenance (dot shading, feed counter, About panel figures) | **Real** — computed live from date fields in the same government records |

## Stack

Express + Neon Postgres · MapLibre GL + OpenFreeMap tiles (restyled toward the Google palette in `public/map-style.js`) · no build step, no frontend framework.

```
lib/db.js       schema + pool + demo-sensor seed (closures/sensors/readings/inquiries/etl_runs)
lib/etl.js      ArcGIS -> Postgres sync (boot-if-stale + daily)
lib/routing.js  Valhalla/OSRM proxy, flood buffers, verified avoidance geometry
lib/sensor-state.js ordered projection, closure decisions and provenance
server.js       API: /api/closures /api/closures/stats /api/sensor-closures /api/sensors /api/devices
                     /api/ingest /api/series /api/telemetry/devices /api/rock7
                     /api/route /api/geocode /api/etl/* /api/inquire
public/         the app (index.html) + mission control (admin.html)
                + the telemetry console (telemetry.html)
hardware/       sensor design brief + the device wire contract (INGEST.md)
```

## Hardware ingest

Real units post the v0.5 firmware payload to `POST /api/ingest` with a shared
Bearer token (`DEVICE_TOKEN` env); satellite reports arrive via the Rock7
webhook on `/api/rock7` and land in the same table. `GET /api/series` reads it
back, and `/telemetry` plots it — depth/velocity/d×v against receive time with
the device's class as a coloured band, battery below, reboots marked. See
[`hardware/INGEST.md`](hardware/INGEST.md) for both wire contracts, and
`node hardware/fake-telemetry.js` to drive a full flood cycle without hardware.

Only a newer positive OPEN (`dry` on the legacy contract) can reopen a closure,
and D×V ≥ 0.30 m²/s overrides OPEN. UNCAL, NO_TARGET and low-D×V UNCLASSED
reports hold the closure. Raw telemetry remains append-only. Projection completes
before ingest acknowledges success; failure returns 500 so delivery can retry.
Per-device row locks and observation/decision timestamps handle concurrent and
late reports. An old OPEN cannot erase newer evidence, and a blind report does
not suppress a delayed hazard after the last positive decision.

Missing channels are NULL in the latest sample. Closure-trigger time, report ID,
class, depth, velocity and D×V persist independently in `sensor_closures` until
positive reopening; historical readings and the instrument record remain intact.
The latest sample is never padded with old values presented as current readings.

Provisioning defaults to **bench**. Field provisioning requires
`deployment: "installed"` and a `location_note` describing confirmed coordinates.
Use `report_interval_s` for expected transmission cadence (M2 `dt_s` is sample
spacing, not proof of transmission cadence), and `rock7_imei` for explicit device
mapping. Reprovisioning preserves the existing credential. Installed units cannot
silently become bench units through an omitted field. Device-controlled pins cannot
be flooded, cleared, dragged or deleted by the simulation controls.

`stale` remains true once sample age exceeds 15 minutes. An hourly satellite sample
58 minutes old is presented as awaiting its configured report, with age visible.
A stale flooded unit stays excluded from routes; a stale clear unit is neutral and
reports unknown present conditions. Bench hardware never excludes a public road.

A successful HTTP routing response is checked against every flooded sensor within
120 m before claiming avoidance. If avoidance fails, the baseline keeps its hazard
warning. Cached geometry receives current sensor evidence without extra community
routing calls. The UI shows an explicit warning if a new route request fails.

## The closure-provenance layer

`/api/closures` tags every government record `dated` / `open_ended` /
`abandoned`, derived **from date fields only**, and `/api/closures/stats`
returns the statewide counts shown in the About panel and the map counter.

Do not add a bucket based on the source's `status` column. Its two values
('Open'/'Closed') do not describe whether the road is trafficable — the set
contains 'Closed' records that are single-lane crash reports and 'Open' records
that are scheduled roadworks ending in 2029. It appears to track the source
system's own record lifecycle, it is undocumented in the payload, and a claim
built on it would not survive one informed question. Dates are unambiguous;
build the argument on those.

## Pilot trigger and scientific limits

The server’s single derived decision is closure at D×V ≥ 0.30 m²/s, including
when the product computed from measured depth and velocity reaches the trigger.
It does not derive OPEN or WARNING. The threshold is an application trigger,
not a complete H1–H6 implementation or a guarantee about crossing conditions.
[Smith, Modra, Tucker & Cox (2017), WRL TR 2017/07, Table ES-1](https://www.unsw.edu.au/content/dam/pdfs/engineering/civil-environmental/water-research-laboratory/publications/WRL-TR2017-07-Vehicle-Stability-Testing-for-Flood-Flows.pdf)
discusses a small-passenger-vehicle product criterion of 0.3 alongside independent
depth and velocity limits. This prototype does not implement all those limits.
Do not describe a low product as permission to enter floodwater.

## Verification

`npm test` runs offline decision and display checks. `npm run test:integration`
explicitly creates a temporary schema on the configured Neon database, runs the
real Express handlers and SQL, then drops only that schema. It never writes test
reports to public tables or `mercuril-01`. External routing responses are fixtures,
so these tests verify avoidance requests, route geometry checks and UI behavior;
they do not prove a particular crossing has a viable live detour.

`node tests/integration.cjs --isolated-neon --browser` also checks desktop/mobile
WebGL rendering and admin controls using the droplet’s existing Playwright install.
Screenshots are saved outside this repository in `/tmp`. `node tests/live-routing.cjs`
checks the real routing service with an in-memory obstacle and no database writes.

## Run

```bash
npm install
cp .env.example .env   # fill DATABASE_URL (Neon pooled connection) + ADMIN_KEY
node server.js         # first boot ingests ~103k NSW records (~40 s)
```

- App: `http://localhost:3000` — pitch scenario: `http://localhost:3000/?scenario=pitch`
- Mission control: `http://localhost:3000/admin` (asks for `ADMIN_KEY`; flood/clear sensors live — the public app reacts within 5 s)

## Deploy (Railway)

1. Push to `main` — Railway auto-deploys (nixpacks, `npm start`).
2. Variables: `DATABASE_URL` (Neon pooled connection string), `ADMIN_KEY`.
3. `postinstall` vendors MapLibre into `public/vendor/`. Schema auto-creates on boot.
4. Health probe: `GET /healthz`.

## Copy doctrine

Site copy stays impersonal and factual. Katya's personal story lives in the
stage pitch only — never on the website (decided 2026-07-06: putting it in
marketing copy cheapens it). Keep her bio to credentials. The About panel's
integrity note (real vs simulated) stays — judges will click this site.

## Compliance guardrails (Peter Farrell Cup rubric — David Burt)

Do not add to the site pre-finals:

- Pricing / "Buy" / "Get started" CTAs
- Revenue framing (ARR, MRR, "customers")
- ABN or company registration details
- Press releases, "launch" language, funding announcements

The current framing — "we're building this, prototype phase, talk to us" — is the ceiling. See `dashboards/data/reports/2026-06-29-pfc-evidence-ladder-v2.md` for the full rubric note.

## Attribution

Road-closure data © Commonwealth of Australia (DITRDCA), CC-BY 4.0 · Map data © OpenStreetMap contributors via OpenFreeMap · Routing by Valhalla (FOSSGIS) / OSRM demo — community services, be gentle.
