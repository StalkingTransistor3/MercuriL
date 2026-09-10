# MercuriL — the map that sees the flood

Live prototype for the MercuriL flood road-safety network (UNSW Peter Farrell Cup 2026).

A Google-Maps-style web app (desktop + mobile) with one switch:

- **Today** — the map as it exists: real routing, real government closure data, and no idea the causeway ahead is under water.
- **With MercuriL** — the same map with the sensor network: flooded crossings detected in minutes, verified closures on the map, and the route quietly re-planned around the water.

## What's real vs simulated

| Layer | Status |
|---|---|
| Government closures (grey dots) | **Real** — the federal [Roadworks and Road Closures](https://catalogue.data.infrastructure.gov.au/dataset/harmonised-national-roadworks-and-road-closures) dataset (Dept of Infrastructure, CC-BY 4.0), NSW slice (~103k records), synced daily into Postgres |
| Road network + routing | **Real** — OSM road graph via FOSSGIS Valhalla (`exclude_polygons` for flood avoidance), OSRM fallback |
| Search | **Real** — Photon geocoding, AU-biased |
| Sensors (green/red dots) | **Simulated** — hardware in prototyping; states are driven live from `/admin`, or from a real unit via `/api/ingest` (see `hardware/INGEST.md`) |
| Closure provenance (dot shading, feed counter, About panel figures) | **Real** — computed live from date fields in the same government records |

## Stack

Express + Neon Postgres · MapLibre GL + OpenFreeMap tiles (restyled toward the Google palette in `public/map-style.js`) · no build step, no frontend framework.

```
lib/db.js       schema + pool + demo-sensor seed (closures/sensors/readings/inquiries/etl_runs)
lib/etl.js      ArcGIS -> Postgres sync (boot-if-stale + daily)
lib/routing.js  Valhalla/OSRM proxy, flood buffers, hazard detection
server.js       API: /api/closures /api/closures/stats /api/sensors /api/devices
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

Two rules the server enforces, both deliberate: an `unknown` reading never
clears a flooded crossing (fails toward closed, never toward safe), and a
partial payload never erases the last known reading.

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
