// ETL: federal "Roadworks and Road Closures" ArcGIS layer -> Neon.
// Source: Department of Infrastructure RADAR curated layer (CC-BY 4.0).
// NSW slice only (~100k records), paginated 2000/request, upsert by unique_identifier.
const { getPool } = require('./db');

const LAYER =
  'https://spatial.infrastructure.gov.au/server/rest/services/Hosted/RADAR_Curated_Prod_roadworks/FeatureServer/0/query';
const PAGE = 2000;
const OUT_FIELDS =
  'id,unique_identifier,status,category,updated_category,type,description,street_name,direction,from_date,to_date,state,source_url';

function toTs(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

async function fetchPage(offset) {
  const params = new URLSearchParams({
    where: "state='NSW'",
    outFields: OUT_FIELDS,
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    returnGeometry: 'true',
    f: 'json',
  });
  const resp = await fetch(`${LAYER}?${params}`, {
    headers: { 'User-Agent': 'MercuriL-prototype/0.1 (UNSW student project)' },
  });
  if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} at offset ${offset}`);
  const data = await resp.json();
  if (data.error) throw new Error(`ArcGIS error: ${JSON.stringify(data.error)}`);
  return data;
}

async function upsertBatch(db, features) {
  const cols = 14;
  const values = [];
  const params = [];
  let i = 0;
  for (const f of features) {
    const a = f.attributes;
    const g = f.geometry;
    if (!g || typeof g.x !== 'number' || typeof g.y !== 'number') continue;
    const uid = a.unique_identifier || `oid-${a.id}`;
    params.push(
      uid, a.id, a.state, a.status, a.category, a.updated_category, a.type,
      a.description, a.street_name, a.direction,
      toTs(a.from_date), toTs(a.to_date), a.source_url, g.x, g.y
    );
    const base = i * (cols + 1);
    values.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15})`
    );
    i++;
  }
  if (!values.length) return 0;
  await db.query(
    `INSERT INTO closures
       (uid, source_oid, state, status, category, updated_category, type,
        description, street_name, direction, from_date, to_date, source_url, lon, lat)
     VALUES ${values.join(',')}
     ON CONFLICT (uid) DO UPDATE SET
       status = EXCLUDED.status,
       category = EXCLUDED.category,
       updated_category = EXCLUDED.updated_category,
       type = EXCLUDED.type,
       description = EXCLUDED.description,
       street_name = EXCLUDED.street_name,
       direction = EXCLUDED.direction,
       from_date = EXCLUDED.from_date,
       to_date = EXCLUDED.to_date,
       source_url = EXCLUDED.source_url,
       lon = EXCLUDED.lon,
       lat = EXCLUDED.lat,
       ingested_at = now()`,
    params
  );
  return i;
}

let running = false;

async function runEtl() {
  if (running) return { ok: false, error: 'ETL already running' };
  running = true;
  const db = getPool();
  const run = await db.query('INSERT INTO etl_runs DEFAULT VALUES RETURNING id');
  const runId = run.rows[0].id;
  let total = 0;
  try {
    let offset = 0;
    for (;;) {
      const page = await fetchPage(offset);
      const feats = page.features || [];
      total += await upsertBatch(db, feats);
      offset += feats.length;
      if (!page.exceededTransferLimit || feats.length === 0) break;
    }
    await db.query(
      'UPDATE etl_runs SET finished_at = now(), records = $1, ok = true WHERE id = $2',
      [total, runId]
    );
    console.log(`ETL complete: ${total} NSW records upserted`);
    return { ok: true, records: total };
  } catch (err) {
    await db.query(
      'UPDATE etl_runs SET finished_at = now(), records = $1, ok = false, error = $2 WHERE id = $3',
      [total, String(err.message).slice(0, 500), runId]
    );
    console.error('ETL failed:', err.message);
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

// Run on boot if the last successful run is stale, then re-check daily.
const DAY = 24 * 60 * 60 * 1000;

async function scheduleEtl() {
  const db = getPool();
  const { rows } = await db.query(
    'SELECT finished_at FROM etl_runs WHERE ok ORDER BY finished_at DESC LIMIT 1'
  );
  const last = rows[0]?.finished_at ? new Date(rows[0].finished_at).getTime() : 0;
  if (Date.now() - last > DAY) {
    runEtl().catch((e) => console.error('boot ETL failed', e.message));
  }
  setInterval(() => {
    runEtl().catch((e) => console.error('scheduled ETL failed', e.message));
  }, DAY).unref();
}

module.exports = { runEtl, scheduleEtl };
