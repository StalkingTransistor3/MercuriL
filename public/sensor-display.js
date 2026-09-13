/* Shared public/admin wording. All instrument and operator strings are escaped. */
(function (root) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const metric = (v, unit) => v == null ? 'not measured' : `${Number(v).toFixed(2)} ${unit}`;
  const when = (v) => v ? new Date(v).toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }) : 'not yet reported';
  const label = (p) => p.simulated ? 'Simulated' : p.deployment === 'installed' ? 'Real MercuriL sensor' : 'Real unit · bench only';
  function freshness(p) {
    if (!p.device_id) return 'Simulated readings · controlled from mission control';
    if (!p.observed_at) return 'No device report yet · crossing condition unknown';
    const mins = Math.max(0, Math.floor((Date.now() - new Date(p.observed_at)) / 60000));
    const age = mins < 1 ? 'less than a minute ago' : mins < 120 ? `${mins} min ago` : `${(mins / 60).toFixed(1)} h ago`;
    const cadence = p.telemetry_src === 'sat' && p.report_interval_s
      ? ` · satellite reports expected every ${Math.round(p.report_interval_s / 60)} min` : '';
    const condition = p.reporting === 'satellite_interval' ? ' · awaiting next scheduled report'
      : p.stale ? ' · report overdue; present conditions unknown' : '';
    return `Last sample ${age}${cadence}${condition}${p.state === 'flooded' ? ' · closure held until positive OPEN' : ''}`;
  }
  function popup(p) {
    const c = typeof p.closure === 'string' ? JSON.parse(p.closure) : p.closure;
    const realClosure = !p.simulated && p.deployment === 'installed' && c && p.state === 'flooded';
    const status = realClosure ? 'CLOSED BY MERCURIL SENSOR'
      : p.state === 'flooded' ? (p.simulated ? 'SIMULATED FLOOD' : 'BENCH HAZARD REPORT')
      : p.observation === 'reported' ? 'Open / no hazard detected at last report'
      : p.simulated ? 'Simulated · no hazard detected' : 'Crossing condition unknown';
    return `<div class="cl-cat">${label(p)}</div><div class="pp-name">${esc(p.name)}</div>
      <div class="pp-state ${p.state === 'flooded' ? 'flooded' : 'unknown'}">${status}</div>
      ${realClosure ? `<div class="cl-desc">Closed by MercuriL sensor at ${esc(when(c.detected_at))}. D×V = ${metric(c.dv_product, 'm²/s')}.</div>
      <div class="pp-meta">${c.class_derived ? 'Server closure trigger' : 'Device report'} · ${esc(c.device_class)} · report ${esc(c.telemetry_id ?? 'legacy')}</div>` : ''}
      ${p.deployment === 'bench' && !p.simulated ? '<div class="cl-flag warn">Bench display position · no road closure or routing effect.</div>' : ''}
      ${p.location_note ? `<div class="pp-meta">${esc(p.location_note)}</div>` : ''}
      <div class="pp-meta">Latest depth: ${metric(p.depth_m, 'm')} · velocity: ${metric(p.velocity_ms, 'm/s')}</div>
      <div class="pp-meta">Latest D×V: ${metric(p.dv_product, 'm²/s')} · device: ${esc(p.device_state || 'unreported')}</div>
      <div class="cl-flag">${esc(freshness(p))}</div>
      ${p.device_id ? `<div class="pp-meta">${esc(p.device_id)} · battery ${p.battery_pct == null ? 'unreported' : esc(p.battery_pct) + '%'} · <a href="/telemetry?device=${encodeURIComponent(p.device_id)}">Instrument record</a></div>` : ''}`;
  }
  const api = { esc, metric, when, label, freshness, popup };
  if (typeof module !== 'undefined') module.exports = api;
  else root.sensorDisplay = api;
})(typeof window !== 'undefined' ? window : globalThis);
