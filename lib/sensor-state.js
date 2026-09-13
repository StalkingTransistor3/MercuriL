const { POLICY, assessReport, assessRoad } = require('./flood-assessment');
const DV_CLOSE = POLICY.dv_m2s;
const STALE_MS = 15 * 60 * 1000;
const number = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;

function judgement(cls, depth, vel, dv) {
  const assessment = assessReport(cls, depth, vel, dv);
  return {
    state: assessment.result === 'close' ? 'flooded'
      : ['OPEN', 'dry'].includes(cls) && assessment.result === 'below_limits' ? 'clear' : null,
    class_derived: assessment.class_derived,
    trigger_dv: assessment.checks.find((c) => c.code === 'dv_limit').value,
    assessment,
  };
}

function presentation(row, now = Date.now()) {
  const simulated = !row.device_id || row.is_simulated === true || /^bench-/i.test(row.device_id);
  const age = row.observed_at ? Math.max(0, now - new Date(row.observed_at).getTime()) : null;
  const stale = !!row.device_id && (age === null || age > STALE_MS);
  const cadence = row.report_interval_s || null;
  const awaitingSatellite = row.telemetry_src === 'sat' && age !== null && cadence !== null
    && age <= (cadence * 1000 + STALE_MS);
  const view = {
    simulated,
    provenance: simulated ? 'simulated' : row.deployment === 'installed' ? 'real_sensor' : 'bench_unit',
    stale,
    reporting: !row.observed_at ? 'unobserved' : awaitingSatellite ? 'satellite_interval'
      : stale ? 'overdue' : 'recent',
    observation: !row.device_id ? 'simulated'
      : !row.observed_at ? 'unobserved'
      : stale || !['OPEN', 'dry', 'WARNING', 'wet', 'hazard', 'CLOSED'].includes(row.device_state)
        ? 'unknown' : 'reported',
  };
  return { ...view, assessment: assessRoad(row, view) };
}

// Serialize each device projection with a row lock. The instrument record has
// already been retained before this transaction; failures return 500 for retry.
async function projectReport(pool, report) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query('SELECT * FROM sensors WHERE device_id=$1 FOR UPDATE', [report.device]);
    const s = rows[0];
    if (!s) { await db.query('COMMIT'); return null; }
    const ts = new Date(report.ts);
    const j = judgement(report.cls, report.depth, report.vel, report.dv);
    const previousTime = s.observed_at ? new Date(s.observed_at).getTime() : -Infinity;
    const decisionTime = s.state_observed_at ? new Date(s.state_observed_at).getTime() : -Infinity;
    // Transmission can be delayed. Clock tolerance accommodates small device /
    // database skew; far-future samples never replace current conditions.
    const age = Date.now() - ts.getTime();
    const validTime = Number.isFinite(age) && age >= -60_000;
    const fresh = validTime && age <= STALE_MS;
    // Equal-time conflicts hold closed; duplicates cannot reopen a closure.
    const apply = validTime && (ts.getTime() > previousTime || (ts.getTime() === previousTime && j.state === 'flooded'));
    // A newer blind observation must not suppress a delayed hazard report.
    // Only a later positive decision supersedes a closure; reopening also
    // requires a report newer than the latest observation (including blind).
    const decide = validTime && (j.state === 'flooded' ? ts.getTime() >= decisionTime
      : fresh && j.state === 'clear' && ts.getTime() > Math.max(previousTime, decisionTime));
    const nextState = decide ? j.state : s.state;
    if (!report.replay) await db.query(
      `INSERT INTO sensor_readings (sensor_id,ts,depth_m,state,velocity_ms,dv_product,device_state,raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.id, ts, report.depth, nextState, report.vel, report.dv, report.cls, report.raw]);
    if (apply) {
      await db.query(
        `UPDATE sensors SET state=$2, depth_m=$3, velocity_ms=$4, dv_product=$5,
           device_state=$6, observed_at=$7, last_seen=$7, last_contact=now(),
           telemetry_src=$8, report_interval_s=COALESCE($9,report_interval_s),
           batt_v=COALESCE($10,batt_v), battery_pct=COALESCE($11,battery_pct),
           class_derived=$12 WHERE id=$1`,
        [s.id, nextState, report.depth, report.vel, report.dv, report.cls, ts,
          report.src, report.interval_s || null, report.batV, report.batPct, j.class_derived]);
      if (report.legacy) {
        const b = report.legacy;
        await db.query(`UPDATE sensors SET hazard_class=COALESCE($2,hazard_class),
          rise_rate_mm_min=COALESCE($3,rise_rate_mm_min), confidence=COALESCE($4,confidence),
          temp_c=COALESCE($5,temp_c), tilt_deg=COALESCE($6,tilt_deg) WHERE id=$1`,
          [s.id, typeof b.hazard_class === 'string' ? b.hazard_class.slice(0,8) : null,
            number(b.rise_rate_mm_min), number(b.confidence), number(b.temp_c), number(b.tilt_deg)]);
      }
    } else {
      await db.query('UPDATE sensors SET last_contact=now() WHERE id=$1', [s.id]);
    }
    if (decide) {
      await db.query('UPDATE sensors SET state=$2,state_observed_at=$3 WHERE id=$1', [s.id, nextState, ts]);
      if (j.state === 'flooded') {
        await db.query(
          `INSERT INTO sensor_closures (sensor_id,detected_at,telemetry_id,device_class,class_derived,depth_m,velocity_ms,dv_product,assessment)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (sensor_id) WHERE reopened_at IS NULL DO NOTHING`,
          [s.id, ts, report.telemetry_id || null, report.cls, j.class_derived,
            report.depth, report.vel, j.trigger_dv, j.assessment]);
      } else if (j.state === 'clear') {
        await db.query('UPDATE sensor_closures SET reopened_at=$2 WHERE sensor_id=$1 AND reopened_at IS NULL AND detected_at < $2', [s.id, ts]);
      }
    }
    if (report.replay) await db.query('UPDATE sensors SET last_contact=$2 WHERE id=$1', [s.id, s.last_contact]);
    await db.query('COMMIT');
    return { sensor_id: s.id, state: nextState, depth_m: apply ? report.depth : s.depth_m, assessment: j.assessment };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally { db.release(); }
}

// Apply newly introduced closure limits to already stored latest observations
// at boot. This can close only; it neither fabricates reports nor reopens roads.
async function reconcileAssessments(pool) {
  const { rows } = await pool.query(`SELECT s.*, t.id AS telemetry_id FROM sensors s
    LEFT JOIN LATERAL (SELECT id FROM telemetry WHERE device=s.device_id AND received_at=s.observed_at ORDER BY id DESC LIMIT 1) t ON true
    WHERE s.device_id IS NOT NULL AND s.observed_at IS NOT NULL AND s.state='clear'`);
  for (const s of rows) {
    if (judgement(s.device_state, s.depth_m, s.velocity_ms, s.dv_product).state !== 'flooded') continue;
    await projectReport(pool, { device: s.device_id, cls: s.device_state, depth: s.depth_m,
      vel: s.velocity_ms, dv: s.dv_product, ts: s.observed_at, src: s.telemetry_src,
      batV: null, batPct: null, telemetry_id: s.telemetry_id, replay: true });
  }
}

module.exports = { DV_CLOSE, STALE_MS, number, judgement, presentation, projectReport, reconcileAssessments };
