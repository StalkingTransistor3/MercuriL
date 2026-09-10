const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
    // Neon requires SSL; rejectUnauthorized:false avoids CA-chain friction on
    // serverless hosts (adopted from the July landing-page rework).
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) => console.error('pg pool error', err.message));
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS closures (
  uid            text PRIMARY KEY,
  source_oid     bigint,
  state          text,
  status         text,
  category       text,
  updated_category text,
  type           text,
  description    text,
  street_name    text,
  direction      text,
  from_date      timestamptz,
  to_date        timestamptz,
  source_url     text,
  lon            double precision NOT NULL,
  lat            double precision NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS closures_lon_lat_idx ON closures (lon, lat);
CREATE INDEX IF NOT EXISTS closures_category_idx ON closures (category);
CREATE INDEX IF NOT EXISTS closures_to_date_idx ON closures (to_date);

CREATE TABLE IF NOT EXISTS sensors (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  lon          double precision NOT NULL,
  lat          double precision NOT NULL,
  state        text NOT NULL DEFAULT 'clear' CHECK (state IN ('clear','flooded')),
  depth_m      double precision NOT NULL DEFAULT 0,
  battery_pct  integer NOT NULL DEFAULT 100,
  installed_at timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensor_readings (
  id        bigserial PRIMARY KEY,
  sensor_id integer NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  ts        timestamptz NOT NULL DEFAULT now(),
  depth_m   double precision NOT NULL,
  state     text NOT NULL
);
CREATE INDEX IF NOT EXISTS sensor_readings_sensor_ts_idx ON sensor_readings (sensor_id, ts DESC);

CREATE TABLE IF NOT EXISTS inquiries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inquiry_type  text NOT NULL,
  name          text NOT NULL,
  email         text NOT NULL,
  organisation  text,
  role          text,
  message       text NOT NULL,
  source        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS etl_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  records     integer,
  ok          boolean,
  error       text
);

-- Raw device telemetry, one row per report, exactly as the firmware said it
-- (v0.5 wire schema, 2026-09-10). Append-only. received_at is server-stamped
-- because the device has no clock — uptime_s is only good for spotting
-- reboots. depth/vel/dv are NULL (not 0) when class is UNCAL/NO_TARGET; the
-- firmware sends 0.0 there and 0.0 is a lie you can plot. The sensors table
-- stays the map-facing projection; this table is the instrument record.
CREATE TABLE IF NOT EXISTS telemetry (
  id          bigserial PRIMARY KEY,
  device      text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  src         text NOT NULL DEFAULT 'wifi',
  fw          text,
  uptime_s    bigint,
  class       text NOT NULL,
  depth       double precision,
  vel         double precision,
  dv          double precision,
  range_m     double precision,
  dry_m       double precision,
  echo_pct    integer,
  bat_v       double precision,
  bat_pct     integer,
  raw         jsonb
);
CREATE INDEX IF NOT EXISTS telemetry_device_received_idx
  ON telemetry (device, received_at DESC);

-- The catch-all net under the typed pipeline. POST /api/raw accepts ANY body
-- in ANY encoding — including invalid JSON that would 400 off the normal
-- parsers — and remembers it verbatim. For firmware payloads that don't have
-- a settled shape yet: capture first, build around it later. Append-only.
CREATE TABLE IF NOT EXISTS raw_hooks (
  id           bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  content_type text,
  authed       boolean NOT NULL DEFAULT false,
  ip           text,
  headers      jsonb,
  bytes        integer,
  body_text    text,
  body_json    jsonb,
  body_hex     text
);
CREATE INDEX IF NOT EXISTS raw_hooks_received_idx ON raw_hooks (received_at DESC);
`;

// Additive migrations for real hardware ingest (2026-08-08). The map-facing
// columns (state/depth_m) are unchanged and stay the projection the frontend
// reads — everything the device sends lands alongside them, so the UI keeps
// working while the firmware is still in flux.
//
// `state` stays clear|flooded. The device's own four-state view (dry/wet/
// hazard/unknown) lives in device_state; see mapState() in server.js for the
// projection, which fails toward flooded and never toward clear.
const MIGRATIONS = `
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS device_id        text;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS device_token     text;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS source           text NOT NULL DEFAULT 'sim';
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS device_state     text;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS velocity_ms      double precision;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS dv_product       double precision;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS hazard_class     text;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS rise_rate_mm_min double precision;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS confidence       double precision;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS batt_v           double precision;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS temp_c           double precision;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS tilt_deg         double precision;
CREATE UNIQUE INDEX IF NOT EXISTS sensors_device_id_idx
  ON sensors (device_id) WHERE device_id IS NOT NULL;

ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS velocity_ms  double precision;
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS dv_product   double precision;
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS confidence   double precision;
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS device_state text;
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS raw          jsonb;
`;

// Real Northern Rivers flood-prone crossings (demo network).
const SEED_SENSORS = [
  { name: 'Tabulam Causeway, Bruxner Hwy', lon: 152.575, lat: -28.885 },
  { name: 'Fawcetts Bridge, Kyogle', lon: 152.99, lat: -28.62 },
  { name: 'Richmond River crossing, Coraki', lon: 153.285, lat: -28.995 },
  { name: 'Pacific flood plain, Woodburn', lon: 153.34, lat: -29.07 },
  { name: 'Bungawalbin Creek causeway', lon: 153.16, lat: -28.94 },
  { name: 'Wilsons River low crossing, Lismore', lon: 153.277, lat: -28.814 },
];

// Dungog Shire proposed pilot network (2026-08-20 council conversation).
//
// Coordinates are REAL, resolved from OpenStreetMap: every entry is either a
// node tagged ford=yes or a way tagged bridge=yes, on a trafficable road class
// (secondary/tertiary/unclassified). Recreational fords were deliberately
// excluded — the Dungog Common MTB trails and the Wangat/Jerusalem Creek
// walking tracks carry ~60 more ford nodes that are not road crossings, and
// pinning those in front of a council that knows every crossing by name would
// cost more credibility than the map earns.
//
// Spread across the three catchments the council named as the whole question
// (Williams / Paterson / Hunter) because their stated need is knowing WHICH
// catchment took the water, not just which road is shut.
//
// VERIFY BEFORE THIS GOES TO THE CUSTOMER. Two entries are inference, not
// instruction: Fosterton Bridge is the Fosterton Road bridge ~4.2 km from town
// that best matches "goes under very quickly, ~5ks from town", and the sixth
// site is a placeholder — the council described "5 or 6 on one causeway" and
// never named the causeway.
const DUNGOG_SENSORS = [
  { name: 'Fosterton Bridge, Fosterton Rd', lon: 151.78168, lat: -32.37482 },
  { name: 'Stroud Hill Rd ford, Dungog', lon: 151.76233, lat: -32.39747 },
  { name: 'Chichester Dam Rd crossing', lon: 151.73985, lat: -32.38768 },
  { name: 'Horns Crossing, Paterson River', lon: 151.5798, lat: -32.53668 },
  { name: 'Bingleburra Rd ford', lon: 151.60556, lat: -32.40344 },
  { name: 'Summer Hill Rd ford, Lambs Valley', lon: 151.52686, lat: -32.52163 },
];

// Insert-if-absent, keyed on name. The original seed only ran against an empty
// table, which meant a deployed database could never pick up a new site — the
// Railway instance already holds the Northern Rivers six. Matching on name
// keeps it idempotent across restarts and additive across releases.
async function seedSensors(db, sensors, label) {
  let added = 0;
  for (const s of sensors) {
    const existing = await db.query('SELECT 1 FROM sensors WHERE name = $1', [s.name]);
    if (existing.rowCount) continue;
    const r = await db.query(
      `INSERT INTO sensors (name, lon, lat, state, depth_m) VALUES ($1,$2,$3,'clear',0) RETURNING id`,
      [s.name, s.lon, s.lat]
    );
    await db.query(
      `INSERT INTO sensor_readings (sensor_id, depth_m, state) VALUES ($1, 0, 'clear')`,
      [r.rows[0].id]
    );
    added += 1;
  }
  if (added) console.log(`Seeded ${added} ${label} sensors`);
  return added;
}

async function initDb() {
  const db = getPool();
  await db.query(SCHEMA);
  await db.query(MIGRATIONS);
  await seedSensors(db, SEED_SENSORS, 'Northern Rivers');
  await seedSensors(db, DUNGOG_SENSORS, 'Dungog');
}

module.exports = { getPool, initDb };
