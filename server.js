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
const { number: tnum, judgement, presentation, projectReport, reconcileAssessments } = require('./lib/sensor-state');
const { assessReport } = require('./lib/flood-assessment');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;
// One shared token for the fleet (v0.5 firmware sends it as a Bearer header).
// Unset = telemetry ingest disabled, same safe-default pattern as ADMIN_KEY.
const DEVICE_TOKEN = process.env.DEVICE_TOKEN;
// Rock7 webhooks can't carry custom headers; the shared secret rides the URL.
const ROCK7_SECRET = process.env.ROCK7_SECRET;

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
        // Inter + Instrument Serif, the two faces the mercuril.com landing uses.
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
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

// /api/raw must see the body as untouched bytes, and must be mounted BEFORE
// the JSON parser: express.json 400s on malformed JSON, and the whole point
// of the raw hook is that a malformed payload still gets remembered.
app.use('/api/raw', express.raw({ type: () => true, limit: '256kb' }));
app.use(express.json({ limit: '32kb' }));
// Rock7 delivers satellite messages as form-encoded POSTs.
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- helpers ----------

async function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.get('x-admin-key') !== ADMIN_KEY) {
    if (req.path === '/api/devices' && req.method === 'POST') {
      const kept = await keepInNet(req, 'provision-rejected:bad-admin-key', JSON.stringify(req.body), req.body);
      return res.status(kept ? 401 : 500).json({ ok: false, error: 'Unauthorised', kept });
    }
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
      ...presentation(row),
      deployment: row.device_id ? row.deployment : 'simulated',
      location_note: row.location_note || null,
      observed_at: row.observed_at,
      telemetry_src: row.telemetry_src,
      report_interval_s: row.report_interval_s,
      class_derived: row.class_derived,
      closure: row.closure || null,
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
          source: 'government',
          simulated: false,
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

// Active instrument closures: separate from government records and their counts.
app.get('/api/sensor-closures', async (_req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT s.*, to_jsonb(c) AS closure
      FROM sensors s JOIN sensor_closures c ON c.sensor_id=s.id AND c.reopened_at IS NULL
      WHERE s.state='flooded' AND s.device_id IS NOT NULL
        AND s.deployment='installed' AND NOT s.is_simulated AND s.device_id !~* '^bench-'`);
    res.json({ type: 'FeatureCollection', features: rows.map((r) => sensorFeature(r)) });
  } catch (err) {
    console.error('sensor closures failed', err.message);
    res.status(500).json({ ok: false, error: 'sensor closures query failed' });
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
    const { rows } = await db.query(`SELECT s.*, to_jsonb(c) AS closure FROM sensors s
      LEFT JOIN sensor_closures c ON c.sensor_id=s.id AND c.reopened_at IS NULL ORDER BY s.id`);
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
  if (s.device_id && (state !== undefined || depth_m !== undefined)) {
    const kept = await keepInNet(req, 'sensor-edit-rejected:device-controlled', JSON.stringify(req.body), req.body);
    return res.status(409).json({ ok: false, error: 'Device readings can only change through ingest', kept });
  }
  if (s.device_id) {
    // Provisioning owns field coordinates. Metadata edits cannot race ingest
    // and write an old state/depth back over a newly closed crossing.
    if (lon !== undefined || lat !== undefined) {
      const kept = await keepInNet(req, 'sensor-edit-rejected:use-provisioning', JSON.stringify(req.body), req.body);
      return res.status(409).json({ ok: false, error: 'Use device provisioning with confirmed location metadata', kept });
    }
    await db.query('UPDATE sensors SET name=$2 WHERE id=$1', [id, name === undefined ? s.name : String(name).trim().slice(0, 120)]);
    return res.json({ ok: true, sensor_id: id });
  }
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
  const result = await getPool().query('DELETE FROM sensors WHERE id = $1 AND device_id IS NULL RETURNING id', [Number(req.params.id)]);
  if (!result.rowCount) return res.status(409).json({ ok: false, error: 'Only simulated map pins can be deleted here' });
  res.json({ ok: true });
});

// ---------- device ingest (real hardware) ----------
//
// Provision a physical unit. Returns the token ONCE — it goes into the
// firmware and is not retrievable afterwards. Reprovisioning keeps its token.
// Devices get their own token so
// no unit ever carries ADMIN_KEY, which also authorises DELETE and ETL.
app.post('/api/devices', requireAdmin, async (req, res) => {
  const { device_id, name, lon, lat, deployment = 'bench', location_note, simulated = false, report_interval_s, rock7_imei } = req.body || {};
  if (typeof device_id !== 'string' || !device_id.trim() || typeof name !== 'string' || !name.trim()
      || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90
      || !['bench','installed'].includes(deployment) || typeof simulated !== 'boolean'
      || (deployment === 'installed' && (typeof location_note !== 'string' || !location_note.trim()))
      || (rock7_imei != null && !/^\d{15}$/.test(rock7_imei))
      || (report_interval_s != null && (!Number.isInteger(report_interval_s) || report_interval_s < 1 || report_interval_s > 86400))) {
    const kept = await keepInNet(req, 'provision-rejected:bad-shape', JSON.stringify(req.body), req.body);
    return res.status(400).json({ ok: false, error: 'Valid device_id, name, lon, lat, deployment and confirmed location_note required; cadence is seconds', kept });
  }
  const token = crypto.randomBytes(24).toString('hex');
  try {
    const existing = await getPool().query('SELECT deployment FROM sensors WHERE device_id=$1', [device_id.trim().slice(0,64)]);
    if (existing.rows[0]?.deployment === 'installed' && req.body.deployment !== 'installed') {
      const kept = await keepInNet(req, 'provision-rejected:field-location-required', JSON.stringify(req.body), req.body);
      return res.status(409).json({ ok: false, error: 'An installed unit requires explicit installed deployment and confirmed location metadata', kept });
    }
    const { rows } = await getPool().query(
      `INSERT INTO sensors (name, lon, lat, device_id, device_token, source, state, depth_m, battery_pct, last_seen, deployment, location_note, is_simulated, report_interval_s, rock7_imei)
       VALUES ($1,$2,$3,$4,$5,'device','clear',NULL,NULL,NULL,$6,$7,$8,$9,$10)
       ON CONFLICT (device_id) WHERE device_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, lon = EXCLUDED.lon, lat = EXCLUDED.lat,
                     source = 'device', deployment = EXCLUDED.deployment, location_note = EXCLUDED.location_note,
                     report_interval_s = COALESCE(EXCLUDED.report_interval_s,sensors.report_interval_s),
                     rock7_imei = COALESCE(EXCLUDED.rock7_imei,sensors.rock7_imei)
       RETURNING id, device_id, device_token=$5 AS created`,
      [String(name).trim().slice(0, 120), lon, lat, String(device_id).trim().slice(0, 64), token,
       deployment, String(location_note || 'Bench display position; install location unconfirmed').slice(0, 240),
       simulated || /^bench-/i.test(device_id.trim()), report_interval_s || null, rock7_imei || null]
    );
    res.json({ ok: true, sensor_id: rows[0].id, device_id: rows[0].device_id, ...(rows[0].created ? { device_token: token } : {}) });
  } catch (err) {
    console.error('device provision failed', err.message);
    res.status(500).json({ ok: false, error: 'provisioning failed' });
  }
});

const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240, // a fleet in hazard mode reports every 10 s
  standardHeaders: true,
  legacyHeaders: false,
  handler: async (req, res) => {
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    const kept = await keepInNet(req, 'ingest-rejected:rate-limit', text, Buffer.isBuffer(req.body) ? null : req.body);
    res.status(kept ? 429 : 500).json({ ok: false, error: 'Report rate limit exceeded', kept });
  },
});

// ---------- v0.5 firmware telemetry ----------

const TELEMETRY_CLASSES = new Set(['OPEN', 'WARNING', 'CLOSED', 'UNCAL', 'NO_TARGET']);


// Rejection is not permission to forget. Any payload the typed endpoints
// turn away still gets remembered in raw_hooks, tagged with why, so a
// misbehaving firmware build loses an HTTP status, never data. Best-effort:
// if even this insert fails there is nothing left to keep it with.
async function keepInNet(req, tag, text, json) {
  try {
    const { rows } = await getPool().query(
      `INSERT INTO raw_hooks (content_type, authed, ip, headers, bytes, body_text, body_json)
       VALUES ($1, false, $2, $3, $4, $5, $6) RETURNING id`,
      [tag, req.ip, {}, text ? Buffer.byteLength(text) : 0, text,
       json ? JSON.stringify(json) : null]
    );
    return rows[0].id;
  } catch (err) {
    console.error('net keep failed', err.message);
    return null;
  }
}

// Store one v0.5-shaped record and await its map projection. Shared by the
// Wi-Fi and satellite paths — same table, same plot.
async function storeTelemetry({ device, src, fw, uptime_s, cls, depth, vel, dv, range, dry, echo_pct, batV, batPct, raw, received_at, interval_s }) {
  // The firmware reports 0.0 for depth/vel/dv when it has no target or no
  // calibration. Store NULL — a zero here would plot as "confidently dry".
  const measured = cls !== 'UNCAL' && cls !== 'NO_TARGET';
  const d = measured ? tnum(depth) : null;
  const v = measured ? tnum(vel) : null;
  const p = measured ? tnum(dv) : null;
  const { rows } = await getPool().query(
    `INSERT INTO telemetry (device, received_at, src, fw, uptime_s, class, depth, vel, dv,
                            range_m, dry_m, echo_pct, bat_v, bat_pct, raw)
     VALUES ($1, COALESCE($2, now()), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, received_at`,
    [device, received_at || null, src, fw, tnum(uptime_s), cls, d, v, p,
     tnum(range), tnum(dry), tnum(echo_pct), tnum(batV), tnum(batPct), raw]
  );
  await projectReport(getPool(), { device, cls, depth: d, vel: v, dv: p,
    batV: tnum(batV), batPct: tnum(batPct), src, interval_s,
    ts: rows[0].received_at, telemetry_id: rows[0].id, raw });
  return { ...rows[0], assessment: assessReport(cls, d, v, p) };
}

// The v0.5 firmware wire: Authorization: Bearer <shared fleet token>, body is
// the device's own JSON verbatim. received_at is stamped server-side — the
// device has no clock, and uptime_s is only useful for spotting reboots.
async function ingestTelemetry(req, res) {
  const b = req.body || {};
  if (!DEVICE_TOKEN) {
    const kept = await keepInNet(req, 'ingest-rejected:no-server-token', JSON.stringify(b), b);
    return res.status(503).json({ ok: false, error: 'DEVICE_TOKEN not configured', kept });
  }
  const auth = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (auth !== DEVICE_TOKEN) {
    const kept = await keepInNet(req, 'ingest-rejected:bad-token', JSON.stringify(b), b);
    return res.status(401).json({ ok: false, error: 'bad token', kept });
  }
  const device = String(b.device || '').trim().slice(0, 64);
  const cls = String(b.class || '').toUpperCase();
  if (!device || !TELEMETRY_CLASSES.has(cls)) {
    const kept = await keepInNet(req, 'ingest-rejected:bad-shape', JSON.stringify(b), b);
    return res.status(400).json({ ok: false, error: 'device and class (OPEN|WARNING|CLOSED|UNCAL|NO_TARGET) required', kept });
  }
  try {
    const row = await storeTelemetry({
      device, src: b.src === 'sat' ? 'sat' : 'wifi', fw: b.fw ? String(b.fw).slice(0, 32) : null,
      uptime_s: b.uptime_s, cls, depth: b.depth, vel: b.vel, dv: b.dv,
      range: b.range, dry: b.dry, echo_pct: b.echo_pct, batV: b.batV, batPct: b.batPct, raw: b,
    });
    res.json({ ok: true, id: row.id, received_at: row.received_at, assessment: row.assessment });
  } catch (err) {
    console.error('telemetry ingest failed', err.message);
    res.status(500).json({ ok: false, error: 'ingest failed' });
  }
}

// Everything the plot needs: the stored records for one device, oldest first.
app.get('/api/series', async (req, res) => {
  const device = String(req.query.device || '').trim().slice(0, 64);
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 14);
  try {
    const { rows } = await getPool().query(
      `SELECT device, received_at, src, fw, uptime_s::int AS uptime_s, class,
              depth, vel, dv, range_m AS range, dry_m AS dry, echo_pct,
              bat_v AS "batV", bat_pct AS "batPct"
         FROM telemetry
        WHERE device = $1 AND received_at > now() - $2 * interval '1 hour'
        ORDER BY received_at ASC
        LIMIT 20000`,
      [device, hours]
    );
    res.json(rows.map((r) => ({ ...r, class_derived: judgement(r.class, r.depth, r.vel, r.dv).class_derived,
      assessment: assessReport(r.class, r.depth, r.vel, r.dv) })));
  } catch (err) {
    console.error('series failed', err.message);
    res.status(500).json({ ok: false, error: 'series query failed' });
  }
});

// Which devices have ever reported, and when we last heard from each.
app.get('/api/telemetry/devices', async (_req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT DISTINCT ON (t.device) t.device, t.received_at, t.src, t.class, t.bat_pct AS "batPct",
              s.device_id, s.deployment, s.is_simulated, s.report_interval_s
         FROM telemetry t LEFT JOIN sensors s ON s.device_id=t.device ORDER BY t.device, t.received_at DESC`
    );
    res.json(rows.map((r) => ({ ...r, provenance: /^bench-|^probe$/i.test(r.device) || r.is_simulated
      ? 'simulated' : !r.device_id ? 'unverified' : r.deployment === 'installed' ? 'real_sensor' : 'bench_unit' })));
  } catch (err) {
    console.error('telemetry devices failed', err.message);
    res.status(500).json({ ok: false, error: 'query failed' });
  }
});

// ---------- raw webhook (catch anything, remember it, decide later) ----------
//
// For payloads whose shape isn't settled yet. Accepts ANY method-POST body in
// ANY encoding, stores the bytes verbatim plus every honest decode we can
// manage (utf8 text, parsed JSON, hex for binary), stamps received_at, and
// answers 200. It never rejects on content — the one weird packet from a
// firmware build at 2 AM is exactly the packet worth keeping. Auth is
// recorded, not required: a valid Bearer DEVICE_TOKEN marks the row
// authed=true so real-unit traffic is separable from internet noise.
app.post('/api/raw', ingestLimiter, async (req, res) => {
  try {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? null));
    const text = buf.toString('utf8');
    const printable = !/[\u0000-\u0008\u000e-\u001f]/.test(text);
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON — that's allowed here */ }
    const auth = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!['authorization', 'cookie'].includes(k)) headers[k] = v; // never store secrets
    }
    const { rows } = await getPool().query(
      `INSERT INTO raw_hooks (content_type, authed, ip, headers, bytes, body_text, body_json, body_hex)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, received_at`,
      [
        req.get('content-type') || null,
        Boolean(DEVICE_TOKEN && auth === DEVICE_TOKEN),
        req.ip,
        headers,
        buf.length,
        printable ? text : null,
        json === null ? null : JSON.stringify(json),
        printable ? null : buf.toString('hex'),
      ]
    );
    res.json({ ok: true, id: rows[0].id, received_at: rows[0].received_at });
  } catch (err) {
    console.error('raw hook failed', err.message);
    res.status(500).json({ ok: false, error: 'store failed' });
  }
});

// Read the net back, newest first. Admin-gated — the firehose stores whatever
// anyone posted, which is not a thing to serve publicly.
app.get('/api/raw', requireAdmin, async (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM raw_hooks WHERE received_at > now() - $1 * interval '1 hour'
        ORDER BY received_at DESC LIMIT $2`,
      [hours, limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('raw read failed', err.message);
    res.status(500).json({ ok: false, error: 'query failed' });
  }
});

// ---------- satellite ingest (Rock7 / RockBLOCK webhook) ----------
//
// Rock7 POSTs form-encoded fields (imei, serial, momsn, transmit_time, data)
// where `data` is the message payload hex-encoded. Two ASCII CSV formats:
//
//   M2,<seq>,<batV_cV>,<batPct>,<echo>,<n>,<dt_s>,<d0>,<v0>,<d1>,<v1>,...
//     Batched, oldest sample first. Depths mm, velocities cm/s, -1 = missing.
//     Sample i was taken at transmit_time - (n-1-i)*dt. ~70 bytes for 6
//     samples = 2 Iridium credits. Battery/echo describe the message, not a
//     sample — they attach to the newest sample only.
//
//   M,1,cls,depth_mm,vel_cms,n,dmin_mm,dmax_mm,echo_pct,seq,reason,flags
//     Single-sample, cls 0/1/2 -> OPEN/WARNING/CLOSED (unknown -> UNCAL).
//
// M2 carries no class. The server derives only CLOSED when measurements
// reach a WRL depth, speed or product limit — and everything else
// is honestly UNCLASSED (renders grey). Both-missing samples are NO_TARGET.
//
// A payload matching neither format is KEPT ANYWAY, in raw_hooks — the
// standing order is catch first, decode later. Always answer 200 once
// authorised: Rock7 retries non-200s for 24h and a payload we can't parse
// today won't parse on the 40th retry either.
const ROCK7_DEVICES = Object.fromEntries(
  (process.env.ROCK7_DEVICES || '')
    .split(',')
    .map((kv) => kv.split('=').map((s) => s.trim()))
    .filter((kv) => kv.length === 2 && kv[0] && kv[1])
);

async function rock7Device(b) {
  const hit = ROCK7_DEVICES[String(b.imei || '')] || ROCK7_DEVICES[String(b.serial || '')];
  if (hit) return hit;
  const { rows } = await getPool().query('SELECT device_id FROM sensors WHERE rock7_imei=$1', [String(b.imei || '')]);
  return rows[0]?.device_id || null;
}

app.post('/api/rock7', ingestLimiter, async (req, res) => {
  if (ROCK7_SECRET && req.query.secret !== ROCK7_SECRET) {
    const kept = await keepInNet(req, 'rock7-rejected:bad-secret', JSON.stringify(req.body), req.body);
    return res.status(kept ? 401 : 500).json({ ok: false, error: 'bad secret', kept });
  }
  const b = req.body || {};
  try {
    const text = Buffer.from(String(b.data || ''), 'hex').toString('utf8').trim();
    const f = text.split(',');
    const device = await rock7Device(b);
    if (!device) {
      const kept = await keepInNet(req, 'rock7-rejected:unmapped-device', JSON.stringify(b), b);
      return res.status(kept ? 200 : 500).json({ ok: !!kept, kept: 'raw', id: kept, reason: 'unmapped device' });
    }
    const meta = {
      csv: text, imei: b.imei || null, serial: b.serial || null,
      momsn: b.momsn || null, transmit_time: b.transmit_time || null,
    };
    // Iridium stamps transmit_time ("YY-MM-DD HH:MM:SS" UTC) with its own
    // clock — unlike the device it can be trusted, and a store-and-forward
    // message can land minutes late, so prefer it over arrival time.
    let base = null;
    const tt = String(b.transmit_time || '').match(/^(\d\d)-(\d\d)-(\d\d) (\d\d:\d\d:\d\d)$/);
    if (tt) base = Date.parse(`20${tt[1]}-${tt[2]}-${tt[3]}T${tt[4]}Z`);
    if (!Number.isFinite(base)) base = Date.now();

    // ---- M2: batched samples ----
    if (f[0] === 'M2' && f.length >= 9) {
      const seq = Number(f[1]), batV = Number(f[2]) / 100, batPct = Number(f[3]);
      const echo = Number(f[4]), n = Number(f[5]), dt = Number(f[6]);
      if (Number.isInteger(n) && n >= 1 && n <= 48 && Number.isFinite(dt) && dt >= 0
          && f.length >= 7 + 2 * n) {
        const ids = [];
        for (let i = 0; i < n; i++) {
          const dmm = Number(f[7 + 2 * i]), vcm = Number(f[8 + 2 * i]);
          const depth = Number.isFinite(dmm) && dmm >= 0 ? dmm / 1000 : null;
          const vel = Number.isFinite(vcm) && vcm >= 0 ? vcm / 100 : null;
          const dv = depth !== null && vel !== null ? +(depth * vel).toFixed(4) : null;
          const cls =
            depth === null && vel === null ? 'NO_TARGET'
            : assessReport('UNCLASSED', depth, vel, dv).result === 'close' ? 'CLOSED'
            : 'UNCLASSED';
          const newest = i === n - 1;
          const row = await storeTelemetry({
            device, src: 'sat', fw: null, uptime_s: null, cls,
            depth, vel, dv, range: null, dry: null,
            echo_pct: newest && Number.isFinite(echo) ? echo : null,
            batV: newest && Number.isFinite(batV) ? batV : null,
            batPct: newest && Number.isFinite(batPct) ? batPct : null,
            raw: { ...meta, m2: { seq, i, n, dt_s: dt, class_derived: cls === 'CLOSED' } },
            received_at: new Date(base - (n - 1 - i) * dt * 1000),
          });
          ids.push(row.id);
        }
        return res.json({ ok: true, format: 'M2', samples: n, ids });
      }
    }

    // ---- M,1: legacy single sample ----
    if (f[0] === 'M' && f[1] === '1' && f.length >= 9) {
      const cls = ['OPEN', 'WARNING', 'CLOSED'][Number(f[2])] || 'UNCAL';
      const depth = Number(f[3]) / 1000;
      const vel = Number(f[4]) / 100;
      const row = await storeTelemetry({
        device, src: 'sat', fw: null, uptime_s: null, cls,
        depth: Number.isFinite(depth) ? depth : null,
        vel: Number.isFinite(vel) ? vel : null,
        dv: Number.isFinite(depth * vel) ? depth * vel : null,
        range: null, dry: null, echo_pct: Number(f[8]),
        batV: null, batPct: null,
        raw: {
          ...meta, n: Number(f[5]), dmin_mm: Number(f[6]), dmax_mm: Number(f[7]),
          seq: Number(f[9]), reason: f[10] ?? null, flags: f[11] ?? null,
        },
        received_at: new Date(base),
      });
      return res.json({ ok: true, format: 'M1', id: row.id });
    }

    // ---- neither format: keep it anyway ----
    const { rows } = await getPool().query(
      `INSERT INTO raw_hooks (content_type, authed, ip, headers, bytes, body_text, body_json)
       VALUES ('rock7-unparsed', $1, $2, $3, $4, $5, $6) RETURNING id, received_at`,
      [Boolean(ROCK7_SECRET), req.ip, {}, Buffer.byteLength(text), text,
       JSON.stringify({ ...meta, fields: b })]
    );
    console.log(`rock7: unparsed payload kept in raw net (id ${rows[0].id}):`,
      JSON.stringify(text.slice(0, 80)));
    res.json({ ok: true, kept: 'raw', id: rows[0].id });
  } catch (err) {
    // A genuine storage failure must NOT answer 200 — that tells Rock7
    // "delivered" and the message is gone forever. 500 makes it retry.
    console.error('rock7 ingest failed', err.message);
    res.status(500).json({ ok: false, error: 'ingest failed' });
  }
});

// The hardware endpoint. v0.5 firmware authenticates with a Bearer token and
// is handled by ingestTelemetry; the older per-device-token contract
// (hardware/SENSOR-DESIGN.md §6, fake-device.js) still works underneath.
app.post('/api/ingest', ingestLimiter, async (req, res) => {
  if (req.get('authorization')) return ingestTelemetry(req, res);
  const body = req.body || {};
  const token = req.get('x-device-token');
  const deviceId = body.sensor_id || body.device_id;
  if (!token || !deviceId) {
    const kept = await keepInNet(req, 'ingest-rejected:missing-device-token', JSON.stringify(body), body);
    return res.status(kept ? 401 : 500).json({ ok: false, error: 'x-device-token header and sensor_id required', kept });
  }
  try {
    const db = getPool();
    const { rows: found } = await db.query(
      'SELECT * FROM sensors WHERE device_id = $1 AND device_token = $2',
      [String(deviceId).slice(0, 64), token]
    );
    if (!found.length) {
      const kept = await keepInNet(req, 'ingest-rejected:unknown-device', JSON.stringify(body), body);
      return res.status(kept ? 401 : 500).json({ ok: false, error: 'unknown device or bad token', kept });
    }
    const deviceState = ['dry', 'wet', 'hazard', 'unknown'].includes(body.state) ? body.state : 'unknown';
    const depth = tnum(body.depth_mm) !== null ? body.depth_mm / 1000 : tnum(body.depth_m);
    const vel = tnum(body.velocity_ms);
    const dv = tnum(body.dv_product);
    const cls = /^H[2-6]$/i.test(body.hazard_class || '') ? 'hazard' : deviceState;
    const ts = body.ts && !Number.isNaN(Date.parse(body.ts)) ? new Date(body.ts) : new Date();
    const result = await projectReport(db, {
      device: found[0].device_id, cls, depth, vel, dv, ts, src: 'legacy', raw: body,
      batV: tnum(body.batt_v), batPct: tnum(body.batt_v) === null ? null
        : Math.max(0, Math.min(100, Math.round(((body.batt_v - 6.0) / 2.4) * 100))), legacy: body,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('ingest failed', err.message);
    const kept = await keepInNet(req, 'ingest-rejected:storage-failure', JSON.stringify(body), body);
    res.status(500).json({ ok: false, error: 'ingest failed', kept });
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
      `SELECT s.*, to_jsonb(c) AS closure FROM sensors s
       LEFT JOIN sensor_closures c ON c.sensor_id=s.id AND c.reopened_at IS NULL
       WHERE s.state='flooded' AND (s.device_id IS NULL OR s.is_simulated OR s.device_id ~* '^bench-' OR s.deployment='installed')`
    );
    const hazards = flooded.map((r) => ({ ...sensorFeature(r).properties, lon: r.lon, lat: r.lat }));
    const result = await route(from, to, mode, hazards);
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

// ---------- last-resort catch ----------

// A body the JSON parser refused is still a body somebody sent. body-parser
// hands the raw string back on the error object; keep it before answering.
app.use(async (err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed' && req.path.startsWith('/api/')) {
    const kept = await keepInNet(req, 'parse-rejected', typeof err.body === 'string' ? err.body : null, null);
    return res.status(400).json({ ok: false, error: 'unparseable body', kept });
  }
  next(err);
});

// ---------- boot ----------

if (require.main === module) (async () => {
  try {
    await initDb();
    await reconcileAssessments(getPool());
    scheduleEtl();
  } catch (err) {
    console.error('DB init failed (serving static only):', err.message);
  }
  app.listen(PORT, () => console.log(`MercuriL prototype listening on ${PORT}`));
})();

module.exports = { app };
