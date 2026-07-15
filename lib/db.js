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

async function initDb() {
  const db = getPool();
  await db.query(SCHEMA);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM sensors');
  if (rows[0].n === 0) {
    for (const s of SEED_SENSORS) {
      const r = await db.query(
        `INSERT INTO sensors (name, lon, lat, state, depth_m) VALUES ($1,$2,$3,'clear',0) RETURNING id`,
        [s.name, s.lon, s.lat]
      );
      await db.query(
        `INSERT INTO sensor_readings (sensor_id, depth_m, state) VALUES ($1, 0, 'clear')`,
        [r.rows[0].id]
      );
    }
    console.log(`Seeded ${SEED_SENSORS.length} demo sensors`);
  }
}

module.exports = { getPool, initDb };
