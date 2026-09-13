// Conservative small-passenger screening envelope: WRL TR 2017/07,
// Table 7-2 (p48) and Figure 7-3 (p45). This is MercuriL's closure policy,
// not a claim of WRL approval or proof of road trafficability.
const POLICY = Object.freeze({
  id: 'wrl2017-small-passenger-v1',
  vehicle_class: 'Small passenger vehicle',
  depth_m: 0.30,
  velocity_ms: 3.0,
  dv_m2s: 0.30,
  source_url: 'https://www.unsw.edu.au/content/dam/pdfs/engineering/civil-environmental/water-research-laboratory/publications/WRL-TR2017-07-Vehicle-Stability-Testing-for-Flood-Flows.pdf',
  source_location: 'Table 7-2, p48; Figure 7-3, p45',
});
const number = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const nonnegative = (v) => number(v) !== null && v >= 0 ? v : null;

function assessReport(cls, depth, velocity, dv) {
  const blind = ['UNCAL', 'NO_TARGET'].includes(cls);
  const d = blind ? null : nonnegative(depth);
  const v = blind || number(velocity) === null ? null : Math.abs(velocity);
  const supplied = blind ? null : nonnegative(dv);
  const calculated = d !== null && v !== null ? d * v : null;
  const product = supplied === null ? calculated : calculated === null ? supplied : Math.max(supplied, calculated);
  const checks = [
    { code: 'depth_limit', label: 'Water depth', value: d, limit: POLICY.depth_m, unit: 'm' },
    { code: 'velocity_limit', label: 'Water speed', value: v, limit: POLICY.velocity_ms, unit: 'm/s' },
    { code: 'dv_limit', label: 'Depth × speed', value: product, limit: POLICY.dv_m2s, unit: 'm²/s' },
  ].map((c) => ({ ...c, status: c.value === null ? 'missing' : c.value >= c.limit ? 'reached' : 'below' }));
  const reasons = checks.filter((c) => c.status === 'reached').map((c) => ({
    code: c.code, source: 'wrl_policy',
    text: `${c.label} ${c.value.toFixed(2)} ${c.unit} reaches the ${c.limit.toFixed(2)} ${c.unit} closure limit.`,
  }));
  const derived = reasons.length > 0;
  if (!derived && ['CLOSED', 'WARNING', 'wet', 'hazard'].includes(cls)) {
    // M2 has a server-derived stored class; never attribute every stored class
    // to the instrument. Its numeric trigger above provides the WRL reason.
    reasons.push({ code: 'report_warning', source: 'report', text: `The report carries a ${cls} classification.` });
  }
  const complete = checks.every((c) => c.status !== 'missing');
  const result = reasons.length ? 'close' : complete ? 'below_limits' : 'unknown';
  return {
    policy_id: POLICY.id, vehicle_class: POLICY.vehicle_class,
    source_url: POLICY.source_url, source_location: POLICY.source_location,
    result, class_derived: derived, complete, reasons, checks,
    reason: reasons.length ? reasons.map((r) => r.text).join(' ')
      : complete ? 'The measured conditions are below all three closure limits. This does not establish that the road is trafficable.'
      : blind ? `The device reported ${cls}; water conditions cannot be assessed.`
      : 'One or more measurements are missing or invalid; all closure limits cannot be assessed.',
  };
}

function assessRoad(row, view) {
  const sample = assessReport(row.device_state, row.depth_m, row.velocity_ms, row.dv_product);
  let action, headline, reason;
  if (row.state === 'flooded') {
    action = 'closed'; headline = 'KEEP ROAD CLOSED';
    reason = sample.result === 'close' && !view.stale ? sample.reason
      : 'The previous closure remains in force. Reopening requires a fresh, newer OPEN report with every closure check below its limit.';
  } else if (sample.result === 'close') {
    // Also exposes newly introduced limits on an older, not-yet-reprojected row.
    action = 'close'; headline = 'CLOSE ROAD'; reason = sample.reason;
  } else if (view.stale || view.observation === 'unobserved' || sample.result === 'unknown') {
    action = 'unknown'; headline = 'ROAD STATUS UNKNOWN';
    reason = view.stale ? 'A current assessment is unavailable because the last observation is stale. No reopening decision can be made.' : sample.reason;
  } else {
    action = 'no_closure_trigger'; headline = 'NO CLOSURE TRIGGER DETECTED'; reason = sample.reason;
  }
  if (!row.device_id) {
    headline = row.state === 'flooded' ? 'SIMULATED ROAD CLOSURE' : 'SIMULATED · NO CLOSURE';
    reason = 'Demonstration state set from mission control; no physical measurement is claimed.';
  }
  if (row.device_id && row.deployment !== 'installed' && !view.simulated) {
    action = 'bench'; headline = 'BENCH UNIT · NO ROAD ATTACHED';
    reason = 'These readings do not describe an installed crossing. The latest sample assessment is shown below.';
  }
  return { action, headline, reason, sample, sample_at: row.observed_at || null,
    current: !view.stale && !!row.observed_at, simulated: view.simulated };
}

module.exports = { POLICY, assessReport, assessRoad };
