const { loadEnv } = require('./lib/env');
loadEnv();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

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

function sensorFeature(row, readings) {
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
      readings: readings || [],
    },
  };
}

// ---------- closures (real government data) ----------

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
    if (active) {
      // Flood-relevant only: full closures, plus hazards/conditions that are
      // actually about water. Generic "merge left" roadworks noise stays out —
      // every grey dot should be on-message for the demo.
      where += ` AND (to_date IS NULL OR to_date > now())
        AND (
          category = 'Road Closure'
          OR (category IN ('Hazard','Road Conditions')
              AND (description ~* 'flood|water (over|across|on)|inundat|wash(ed)? ?(out|away)|causeway'
                   OR type ~* 'flood|weather'))
        )`;
    }
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
        },
      })),
    });
  } catch (err) {
    console.error('closures failed', err.message);
    res.status(500).json({ ok: false, error: 'closures query failed' });
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
