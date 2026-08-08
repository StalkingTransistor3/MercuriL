const { loadEnv } = require('./lib/env');
loadEnv();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');

const { getPool, initDb } = require('./lib/db');
const { runEtl, scheduleEtl } = require('./lib/etl');
const { route } = require('./lib/routing');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;

const VALID_INQUIRY_TYPES = new Set([
  'Council pilot',
  'Expert consultation',
  'State agency / SES',
  'Media',
  'Other',
]);

app.set('trust proxy', 1);

app.use(
  helmet({
    // Drop X-Frame-Options entirely so the demo can be iframed anywhere
    // (Notion, Framer, judge links, buildclub.ai). Framing is governed by
    // the CSP frame-ancestors directive below instead.
    frameguard: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://static.cloudflareinsights.com'],
        'style-src': ["'self'", "'unsafe-inline'"],
        // map tiles/glyphs/sprites + inline data-uri markers
        'img-src': ["'self'", 'data:', 'blob:', 'https://tiles.openfreemap.org'],
        'connect-src': [
          "'self'",
          'https://tiles.openfreemap.org',
          'https://cloudflareinsights.com',
        ],
        // maplibre-gl runs its worker from a blob
        'worker-src': ["'self'", 'blob:'],
        'child-src': ["'self'", 'blob:'],
        // Allow embedding on any parent page (overrides useDefaults' 'self').
        'frame-ancestors': ['*'],
      },
    },
  })
);

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- helpers ----------

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.get('x-admin-key') !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorised' });
  }
  next();
}

// A device is "stale" when we haven't heard from it inside two of its slowest
// heartbeats. Simulated pins never go stale — nobody is claiming they're alive.
const STALE_AFTER_MS = 15 * 60 * 1000;

function sensorFeature(row, readings) {
  const age = Date.now() - new Date(row.last_seen).getTime();
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
    properties: {
      id: row.id,
      name: row.name,
      state: row.state,
      depth_m: row.depth_m,
      battery_pct: row.battery_pct,
      last_seen: row.last_seen,
      // --- real-hardware fields (null while the pin is simulated) ---
      source: row.source || 'sim',
      device_id: row.device_id || null,
      device_state: row.device_state || null,
      velocity_ms: row.velocity_ms,
      dv_product: row.dv_product,
      hazard_class: row.hazard_class,
      rise_rate_mm_min: row.rise_rate_mm_min,
      confidence: row.confidence,
      batt_v: row.batt_v,
      stale: row.source === 'device' && age > STALE_AFTER_MS,
      readings: readings || [],
    },
  };
}

// Provenance of a government closure record. Deliberately derived from DATES
// ONLY, which are unambiguous.
//
// Do NOT reintroduce a bucket based on the `status` column. Its two values
// ('Open' / 'Closed') do not describe whether the road is trafficable — the
// set includes 'Closed' records that are single-lane crash reports and 'Open'
// records that are scheduled roadworks with 2029 end dates. The field appears
// to track the source system's own record lifecycle, it is undocumented in the
// payload, and any claim built on it dies to one informed question.
//
//   abandoned  — no end date, first reported over a year ago
//   open_ended — no end date, reported within the year
//   dated      — has an end date you could plan a drive around
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function closureProvenance(r) {
  if (r.to_date !== null) return 'dated';
  const started = r.from_date ? new Date(r.from_date).getTime() : 0;
  return Date.now() - started > YEAR_MS ? 'abandoned' : 'open_ended';
}

// ---------- closures (real government data) ----------

// Shared definitions so /api/closures and /api/closures/stats can never drift.
// The counter on the map has to describe exactly the dots on the map.
const ACTIVE_SQL = '(to_date IS NULL OR to_date > now())';
// Flood-relevant only: full closures, plus hazards/conditions that are actually
// about water. Generic "merge left" roadworks noise stays out — every grey dot
// should be on-message for the demo.
const FLOOD_SQL = `(
  category = 'Road Closure'
  OR (category IN ('Hazard','Road Conditions')
      AND (description ~* 'flood|water (over|across|on)|inundat|wash(ed)? ?(out|away)|causeway'
           OR type ~* 'flood|weather'))
)`;

app.get('/api/closures', async (req, res) => {
  try {
    const bbox = (req.query.bbox || '').split(',').map(Number);
    if (bbox.length !== 4 || bbox.some(Number.isNaN)) {
      return res.status(400).json({ ok: false, error: 'bbox=w,s,e,n required' });
    }
    const [w, s, e, n] = bbox;
    const active = req.query.active === '1';
    const params = [w, e, s, n];
    let where = 'lon BETWEEN $1 AND $2 AND lat BETWEEN $3 AND $4';
    if (active) where += ` AND ${ACTIVE_SQL} AND ${FLOOD_SQL}`;
    const { rows } = await getPool().query(
      `SELECT uid, category, type, status, description, street_name, direction,
              from_date, to_date, lon, lat
         FROM closures WHERE ${where} LIMIT 5000`,
      params
    );
    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
        properties: {
          uid: r.uid,
          category: r.category,
          type: r.type,
          status: r.status,
          description: r.description,
          street: r.street_name,
          direction: r.direction,
          from: r.from_date,
          to: r.to_date,
          provenance: closureProvenance(r),
        },
      })),
    });
  } catch (err) {
    console.error('closures failed', err.message);
    res.status(500).json({ ok: false, error: 'closures query failed' });
  }
});

// Headline integrity numbers for the official feed, statewide. Every figure
// here is derived from the government's own records — a judge can check it.
// Cached because it is a full scan of ~105k rows and the answer moves daily.
let statsCache = { at: 0, payload: null };
const STATS_TTL_MS = 10 * 60 * 1000;

app.get('/api/closures/stats', async (_req, res) => {
  try {
    if (statsCache.payload && Date.now() - statsCache.at < STATS_TTL_MS) {
      return res.json(statsCache.payload);
    }
    const db = getPool();
    const { rows } = await db.query(`
      SELECT count(*)::int AS listed,
             count(*) FILTER (WHERE to_date IS NULL
                                AND from_date < now() - interval '365 days')::int AS abandoned,
             count(*) FILTER (WHERE to_date IS NULL
                                AND from_date >= now() - interval '365 days')::int AS open_ended,
             count(*) FILTER (WHERE to_date IS NOT NULL)::int AS dated,
             min(from_date) AS oldest_start,
             max(to_date)   AS furthest_end,
             count(*) FILTER (WHERE from_date > now() - interval '7 days')::int AS started_last_7d
        FROM closures
       WHERE ${ACTIVE_SQL} AND ${FLOOD_SQL}`);
    const etl = await db.query(
      'SELECT finished_at FROM etl_runs WHERE ok ORDER BY finished_at DESC LIMIT 1'
    );
    const payload = { ...rows[0], last_sync: etl.rows[0]?.finished_at || null };
    statsCache = { at: Date.now(), payload };
    res.json(payload);
  } catch (err) {
    console.error('closure stats failed', err.message);
    res.status(500).json({ error: 'stats query failed' });
  }
});

// ---------- sensors ----------

app.get('/api/sensors', async (_req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM sensors ORDER BY id');
    const readings = await db.query(
      `SELECT sensor_id, ts, depth_m, state FROM (
         SELECT *, row_number() OVER (PARTITION BY sensor_id ORDER BY ts DESC) rn
         FROM sensor_readings
       ) t WHERE rn <= 24 ORDER BY sensor_id, ts`
    );
    const bySensor = {};
    for (const r of readings.rows) {
      (bySensor[r.sensor_id] ||= []).push({ ts: r.ts, depth_m: r.depth_m, state: r.state });
    }
    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => sensorFeature(r, bySensor[r.id])),
    });
  } catch (err) {
    console.error('sensors failed', err.message);
    res.status(500).json({ ok: false, error: 'sensors query failed' });
  }
});

app.post('/api/sensors', requireAdmin, async (req, res) => {
  const { name, lon, lat } = req.body || {};
  if (!name || typeof lon !== 'number' || typeof lat !== 'number') {
    return res.status(400).json({ ok: false, error: 'name, lon, lat required' });
  }
  const { rows } = await getPool().query(
    `INSERT INTO sensors (name, lon, lat) VALUES ($1,$2,$3) RETURNING *`,
    [name.trim().slice(0, 120), lon, lat]
  );
  await getPool().query(
    `INSERT INTO sensor_readings (sensor_id, depth_m, state) VALUES ($1, 0, 'clear')`,
    [rows[0].id]
  );
  res.json({ ok: true, sensor: rows[0] });
});

app.patch('/api/sensors/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, lon, lat, state, depth_m } = req.body || {};
  if (state && !['clear', 'flooded'].includes(state)) {
    return res.status(400).json({ ok: false, error: 'state must be clear|flooded' });
  }
  const db = getPool();
  const cur = await db.query('SELECT * FROM sensors WHERE id = $1', [id]);
  if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'not found' });
  const s = cur.rows[0];
  const next = {
    name: name !== undefined ? String(name).trim().slice(0, 120) : s.name,
    lon: typeof lon === 'number' ? lon : s.lon,
    lat: typeof lat === 'number' ? lat : s.lat,
    state: state || s.state,
    depth_m: typeof depth_m === 'number' ? depth_m : s.depth_m,
  };
  // A state/depth change is a new "reading" from the field.
  const stateChanged = next.state !== s.state || next.depth_m !== s.depth_m;
  const { rows } = await db.query(
    `UPDATE sensors SET name=$1, lon=$2, lat=$3, state=$4, depth_m=$5,
       last_seen = CASE WHEN $6 THEN now() ELSE last_seen END
     WHERE id=$7 RETURNING *`,
    [next.name, next.lon, next.lat, next.state, next.depth_m, stateChanged, id]
  );
  if (stateChanged) {
    await db.query(
      `INSERT INTO sensor_readings (sensor_id, depth_m, state) VALUES ($1,$2,$3)`,
      [id, next.depth_m, next.state]
    );
  }
  res.json({ ok: true, sensor: rows[0] });
});

app.delete('/api/sensors/:id', requireAdmin, async (req, res) => {
  await getPool().query('DELETE FROM sensors WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- device ingest (real hardware) ----------
//
// Provision a physical unit. Returns the token ONCE — it goes into the
// firmware and is not retrievable afterwards. Devices get their own token so
// no unit ever carries ADMIN_KEY, which also authorises DELETE and ETL.
app.post('/api/devices', requireAdmin, async (req, res) => {
  const { device_id, name, lon, lat } = req.body || {};
  if (!device_id || !name || typeof lon !== 'number' || typeof lat !== 'number') {
    return res.status(400).json({ ok: false, error: 'device_id, name, lon, lat required' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  try {
    const { rows } = await getPool().query(
      `INSERT INTO sensors (name, lon, lat, device_id, device_token, source, state, depth_m)
       VALUES ($1,$2,$3,$4,$5,'device','clear',0)
       ON CONFLICT (device_id) WHERE device_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, lon = EXCLUDED.lon, lat = EXCLUDED.lat,
                     device_token = EXCLUDED.device_token, source = 'device'
       RETURNING id, device_id`,
      [String(name).trim().slice(0, 120), lon, lat, String(device_id).trim().slice(0, 64), token]
    );
    res.json({ ok: true, sensor_id: rows[0].id, device_id: rows[0].device_id, device_token: token });
  } catch (err) {
    console.error('device provision failed', err.message);
    res.status(500).json({ ok: false, error: 'provisioning failed' });
  }
});

// The device's four-state view projected onto the two states the map draws.
// Fails toward flooded, never toward clear: 'unknown' holds the previous
// state rather than reporting a road safe that nobody can currently see.
// A false "flooded" annoys a driver; a false "clear" kills one.
function mapState(deviceState, prevState) {
  if (deviceState === 'dry') return 'clear';
  if (deviceState === 'wet' || deviceState === 'hazard') return 'flooded';
  return prevState; // unknown, or anything unrecognised
}

const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240, // a fleet in hazard mode reports every 10 s
  standardHeaders: true,
  legacyHeaders: false,
});

// The hardware endpoint. Accepts the payload defined in
// hardware/SENSOR-DESIGN.md §6 verbatim; unknown keys are kept in `raw` so
// firmware can add fields without waiting on a server change.
app.post('/api/ingest', ingestLimiter, async (req, res) => {
  const body = req.body || {};
  const token = req.get('x-device-token');
  const deviceId = body.sensor_id || body.device_id;
  if (!token || !deviceId) {
    return res.status(401).json({ ok: false, error: 'x-device-token header and sensor_id required' });
  }
  try {
    const db = getPool();
    const { rows: found } = await db.query(
      'SELECT * FROM sensors WHERE device_id = $1 AND device_token = $2',
      [String(deviceId).slice(0, 64), token]
    );
    if (!found.length) return res.status(401).json({ ok: false, error: 'unknown device or bad token' });
    const s = found[0];

    // Depth in metres is what the map reads; firmware talks millimetres.
    const depth_m =
      typeof body.depth_mm === 'number' ? body.depth_mm / 1000
      : typeof body.depth_m === 'number' ? body.depth_m
      : s.depth_m;

    const deviceState = ['dry', 'wet', 'hazard', 'unknown'].includes(body.state)
      ? body.state
      : 'unknown';
    let state = mapState(deviceState, s.state);

    // Australian Rainfall & Runoff hazard: the depth x velocity product, not
    // depth alone. A hazard class or a D*V over the vehicle-stability
    // threshold closes the road regardless of what the state field says.
    const dv = typeof body.dv_product === 'number' ? body.dv_product : null;
    const hazardClass = typeof body.hazard_class === 'string' ? body.hazard_class.slice(0, 8) : null;
    if ((dv !== null && dv >= 0.3) || (hazardClass && /^H[2-6]$/i.test(hazardClass))) state = 'flooded';

    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    // Device-supplied timestamp wins so a unit that buffered while offline
    // backfills at the time it actually measured, not the time it uploaded.
    const ts = body.ts && !Number.isNaN(Date.parse(body.ts)) ? new Date(body.ts) : new Date();
    const batt_v = num(body.batt_v);

    // COALESCE on every optional field: a partial payload (a battery-only
    // heartbeat, a firmware build that hasn't got velocity working yet) must
    // never wipe the last known reading. The reading row below records exactly
    // what arrived, nulls and all — this row is "last known good".
    await db.query(
      `UPDATE sensors SET
         state = $1, depth_m = $2, device_state = $3,
         velocity_ms      = COALESCE($4,  velocity_ms),
         dv_product       = COALESCE($5,  dv_product),
         hazard_class     = COALESCE($6,  hazard_class),
         rise_rate_mm_min = COALESCE($7,  rise_rate_mm_min),
         confidence       = COALESCE($8,  confidence),
         batt_v           = COALESCE($9,  batt_v),
         temp_c           = COALESCE($10, temp_c),
         tilt_deg         = COALESCE($11, tilt_deg),
         battery_pct      = COALESCE($12, battery_pct),
         source = 'device',
         last_seen = now()
       WHERE id = $13`,
      [
        state, depth_m, deviceState, num(body.velocity_ms), dv, hazardClass,
        num(body.rise_rate_mm_min), num(body.confidence), batt_v,
        num(body.temp_c), num(body.tilt_deg),
        // 2x18650 in series: ~6.0 V empty, ~8.4 V full. Rough, and labelled so.
        batt_v === null ? null : Math.max(0, Math.min(100, Math.round(((batt_v - 6.0) / 2.4) * 100))),
        s.id,
      ]
    );
    await db.query(
      `INSERT INTO sensor_readings
         (sensor_id, ts, depth_m, state, velocity_ms, dv_product, confidence, device_state, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [s.id, ts, depth_m, state, num(body.velocity_ms), dv, num(body.confidence), deviceState, body]
    );
    res.json({ ok: true, sensor_id: s.id, state, depth_m });
  } catch (err) {
    console.error('ingest failed', err.message);
    res.status(500).json({ ok: false, error: 'ingest failed' });
  }
});

// ---------- routing ----------

const routeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/api/route', routeLimiter, async (req, res) => {
  try {
    const from = (req.query.from || '').split(',').map(Number);
    const to = (req.query.to || '').split(',').map(Number);
    const mode = req.query.mode === 'mercuril' ? 'mercuril' : 'today';
    if (from.length !== 2 || to.length !== 2 || [...from, ...to].some(Number.isNaN)) {
      return res.status(400).json({ ok: false, error: 'from=lon,lat & to=lon,lat required' });
    }
    const { rows: flooded } = await getPool().query(
      `SELECT id, name, lon, lat, depth_m, last_seen FROM sensors WHERE state = 'flooded'`
    );
    const result = await route(from, to, mode, flooded);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('route failed', err.message);
    res.status(502).json({ ok: false, error: 'routing failed' });
  }
});

// ---------- geocoding (Photon proxy, NSW-biased) ----------

const geoCache = new Map();

app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ results: [] });
  if (geoCache.has(q)) return res.json(geoCache.get(q));
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lat=-31.5&lon=151.5`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'MercuriL-prototype/0.1 (UNSW student project)' },
    });
    if (!resp.ok) throw new Error(`photon ${resp.status}`);
    const data = await resp.json();
    const results = (data.features || [])
      .filter((f) => f.properties.countrycode === 'AU')
      .map((f) => ({
        name: f.properties.name,
        label: [
          f.properties.name,
          f.properties.city || f.properties.county,
          f.properties.state,
        ]
          .filter(Boolean)
          .join(', '),
        type: f.properties.osm_value,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
      }));
    const payload = { results };
    if (geoCache.size > 500) geoCache.delete(geoCache.keys().next().value);
    geoCache.set(q, payload);
    res.json(payload);
  } catch (err) {
    console.error('geocode failed', err.message);
    res.status(502).json({ results: [], error: 'geocoding unavailable' });
  }
});

// ---------- ETL admin ----------

app.post('/api/etl/refresh', requireAdmin, async (_req, res) => {
  const result = await runEtl();
  res.json(result);
});

app.get('/api/etl/status', async (_req, res) => {
  const { rows } = await getPool().query(
    'SELECT started_at, finished_at, records, ok, error FROM etl_runs ORDER BY id DESC LIMIT 1'
  );
  const count = await getPool().query('SELECT count(*)::int n FROM closures');
  res.json({ lastRun: rows[0] || null, closures: count.rows[0].n });
});

// ---------- health + inquiry (unchanged behaviour) ----------

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const intakeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many submissions. Try again later.' },
});

app.post('/api/inquire', intakeLimiter, async (req, res) => {
  const { inquiryType, name, email, organisation, role, message, website } = req.body || {};

  if (website) return res.status(200).json({ ok: true });

  const errors = [];
  if (!inquiryType || !VALID_INQUIRY_TYPES.has(inquiryType)) errors.push('inquiryType');
  if (!name || typeof name !== 'string' || name.trim().length < 2) errors.push('name');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email');
  if (!message || typeof message !== 'string' || message.trim().length < 10) errors.push('message');
  if (errors.length) return res.status(400).json({ ok: false, errors });

  // Stored in Neon (inquiries table) — adopted from the July landing-page
  // rework, which replaced the original Airtable intake.
  try {
    await getPool().query(
      `INSERT INTO inquiries (inquiry_type, name, email, organisation, role, message, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        inquiryType,
        name.trim(),
        email.trim().toLowerCase(),
        (organisation || '').trim() || null,
        (role || '').trim() || null,
        message.trim(),
        'mercuril prototype',
      ]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('inquiry insert failed', err.message);
    return res.status(502).json({ ok: false, error: 'Could not record submission' });
  }
});

// ---------- boot ----------

(async () => {
  try {
    await initDb();
    scheduleEtl();
  } catch (err) {
    console.error('DB init failed (serving static only):', err.message);
  }
  app.listen(PORT, () => console.log(`MercuriL prototype listening on ${PORT}`));
})();
