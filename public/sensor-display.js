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
  const object = (v) => typeof v === 'string' ? JSON.parse(v) : v;
  function decision(p) {
    const a = object(p.assessment);
    if (!a) return '<div class="pp-state unknown">Assessment unavailable</div>';
    const sample = a.sample;
    const sampleTitle = sample.result === 'close' ? 'CLOSURE TRIGGERED'
      : sample.result === 'below_limits' ? 'NO CLOSURE TRIGGER' : 'ASSESSMENT INCOMPLETE';
    const bench = a.action === 'bench';
    return `<div class="pp-state ${['closed','close'].includes(a.action) || sample.result === 'close' ? 'flooded' : 'unknown'}">${esc(bench ? 'LAST SAMPLE: ' + sampleTitle : a.headline)}</div>
      <div class="cl-desc">${esc(bench ? sample.reason : a.reason)}</div>
      ${bench ? `<div class="cl-flag warn">Bench unit · no road attached${a.current ? '' : ' · stale observation'}. No road closure or routing effect.</div>` : ''}
      ${!bench && a.action === 'closed' && sample.result !== 'close' ? `<div class="pp-meta">Latest sample: ${sampleTitle.toLowerCase()}. The existing closure is retained.</div>` : ''}
      ${!bench && a.action === 'unknown' && sample.result === 'below_limits' ? '<div class="pp-meta">Last sample was below the closure limits; current conditions are unknown.</div>' : ''}
      <div class="pp-meta">Small-passenger-vehicle closure screen · ${esc(when(a.sample_at))}</div>
      <details class="assessment-evidence"><summary>Measurements and WRL limits</summary>
        <table class="assessment-checks"><thead><tr><th>Check</th><th>Sample</th><th>Close at</th></tr></thead><tbody>
        ${sample.checks.map((c) => `<tr class="${c.status === 'reached' ? 'reached' : ''}"><th>${esc(c.label)}</th><td>${metric(c.value, c.unit)}</td><td>≥ ${metric(c.limit, c.unit)}</td></tr>`).join('')}
        </tbody></table>
        <div class="pp-meta">Any reached limit triggers closure. Missing measurements cannot establish that all checks are below their limits.</div>
        <div class="pp-meta">Requires calibrated depth above the road and water velocity. The screen does not assess road damage or debris.</div>
        <a href="${esc(sample.source_url)}" target="_blank" rel="noopener">WRL TR 2017/07 · ${esc(sample.source_location)}</a>
      </details>`;
  }
  function popup(p) {
    const c = object(p.closure);
    const realClosure = !p.simulated && p.deployment === 'installed' && c && p.state === 'flooded';
    return `<div class="cl-cat">${label(p)}</div><div class="pp-name">${esc(p.name)}</div>
      ${decision(p)}
      ${realClosure ? `<div class="pp-meta">Closed by MercuriL sensor at ${esc(when(c.detected_at))}. ${esc(c.assessment?.reason || 'Closure retained from the recorded device report.')}</div>` : ''}
      <div class="cl-flag">${esc(freshness(p))}</div>
      <details class="assessment-evidence"><summary>Device and location</summary>
        ${p.location_note ? `<div class="pp-meta">${esc(p.location_note)}</div>` : ''}
        <div class="pp-meta">Recorded class: ${esc(p.device_state || 'unreported')} · reported D×V: ${metric(p.dv_product, 'm²/s')}</div>
        ${p.device_id ? `<div class="pp-meta">${esc(p.device_id)} · battery ${p.battery_pct == null ? 'unreported' : esc(p.battery_pct) + '%'} · <a href="/telemetry?device=${encodeURIComponent(p.device_id)}">Instrument record</a></div>` : ''}
      </details>`;
  }

  const api = { esc, metric, when, label, freshness, decision, popup };
  if (typeof module !== 'undefined') module.exports = api;
  else root.sensorDisplay = api;
})(typeof window !== 'undefined' ? window : globalThis);
