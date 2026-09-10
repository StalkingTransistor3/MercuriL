/* MercuriL telemetry console.
 *
 * Draws exactly what the firmware said, against server receive time. Three
 * deliberate honesty rules, matching the ingest side:
 *   - depth/vel/dv are NULL under UNCAL/NO_TARGET, so the lines BREAK there
 *     instead of plotting a confident 0.0 the radar never measured;
 *   - the class band shows a state for every moment we had a report, in the
 *     same colours the map uses (grey = the device itself says "don't know");
 *   - a gap with no records at all is empty axis, not interpolation.
 *
 * Depth (m), velocity (m/s) and d×v (m²/s) share one numeric axis on purpose:
 * they live on the same 0–2 scale and this is a field debug console, not a
 * publication figure. Battery gets its own panel below on the same clock —
 * NOT a second y-axis on the main chart; dual axes let you tell any story
 * you like by picking the scales.
 */

const SERIES = [
  { key: 'depth', label: 'depth', unit: 'm', color: '#3d8ad4' },
  { key: 'vel', label: 'velocity', unit: 'm/s', color: '#bd851c' },
  { key: 'dv', label: 'd×v', unit: 'm²/s', color: '#b062be' },
];

const CLASSES = {
  OPEN: { fill: 'hsl(158 32% 52% / .08)', strip: 'hsl(158 32% 52%)' },
  WARNING: { fill: 'hsl(40 68% 62% / .13)', strip: 'hsl(40 68% 62%)' },
  CLOSED: { fill: 'hsl(0 65% 55% / .14)', strip: 'hsl(0 65% 55%)' },
  UNCAL: { fill: 'hsl(40 25% 90% / .05)', strip: 'hsl(40 25% 90% / .35)' },
  NO_TARGET: { fill: 'hsl(40 25% 90% / .05)', strip: 'hsl(40 25% 90% / .35)' },
  // Satellite batches carry measurements but no class — the device didn't
  // judge, so neither does the band. Grey, same as "can't see".
  UNCLASSED: { fill: 'hsl(40 25% 90% / .05)', strip: 'hsl(40 25% 90% / .35)' },
};

const REFRESH_MS = 15_000;
const STALE_MS = 15 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { device: null, hours: 24, rows: [], timer: null };

// ---------- data ----------

async function loadDevices() {
  const res = await fetch('/api/telemetry/devices');
  const devices = res.ok ? await res.json() : [];
  const sel = $('device');
  const want = new URLSearchParams(location.search).get('device') || state.device;
  sel.innerHTML = devices.length
    ? devices.map((d) => `<option value="${esc(d.device)}">${esc(d.device)}</option>`).join('')
    : '<option value="">no devices yet</option>';
  if (devices.length) {
    state.device = devices.some((d) => d.device === want) ? want : devices[0].device;
    sel.value = state.device;
  }
}

async function loadSeries() {
  if (!state.device) { render(); return; }
  const res = await fetch(
    `/api/series?device=${encodeURIComponent(state.device)}&hours=${state.hours}`
  );
  state.rows = res.ok ? await res.json() : [];
  state.rows.forEach((r) => { r.t = new Date(r.received_at).getTime(); });
  render();
}

// ---------- scales & axes ----------

function niceTicks(max, n = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 1e9; v += step) ticks.push(+v.toFixed(6));
  return { max: top, ticks };
}

function timeTicks(t0, t1) {
  const span = t1 - t0;
  const steps = [10, 30, 60, 180, 360, 720, 1440, 2880].map((m) => m * 60000);
  const step = steps.find((s) => span / s <= 8) || steps[steps.length - 1];
  const ticks = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  return { ticks, dayScale: step >= 1440 * 60000 };
}

const fmtTime = (t, day) => new Date(t).toLocaleString('en-AU',
  day ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtFull = (t) => new Date(t).toLocaleString('en-AU',
  { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

// Contiguous same-class spans. Each report's class holds until the next
// report (or "now" for the last one) — that is literally all we know.
function classSpans(rows, t1) {
  const spans = [];
  for (let i = 0; i < rows.length; i++) {
    const end = i + 1 < rows.length ? rows[i + 1].t : t1;
    const prev = spans[spans.length - 1];
    if (prev && prev.cls === rows[i].class) prev.end = end;
    else spans.push({ cls: rows[i].class, start: rows[i].t, end });
  }
  return spans;
}

function reboots(rows) {
  const marks = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].uptime_s != null && rows[i - 1].uptime_s != null &&
        rows[i].uptime_s < rows[i - 1].uptime_s) marks.push(rows[i].t);
  }
  return marks;
}

// ---------- rendering ----------

const W = 1060;

function svgEl(html, height) {
  const div = document.createElement('div');
  div.innerHTML =
    `<svg viewBox="0 0 ${W} ${height}" role="img" aria-label="telemetry chart">${html}</svg>`;
  return div.firstChild;
}

function grid(x0, x1, y0, y1, xt, yt, xScale, yScale, unitLabel) {
  let s = '';
  for (const v of yt.ticks) {
    const y = yScale(v);
    s += `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="hsl(40 30% 93% / .07)"/>`;
    s += `<text x="${x0 - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="hsl(40 25% 90% / .4)" font-family="ui-monospace,monospace">${v}</text>`;
  }
  for (const t of xt.ticks) {
    const x = xScale(t);
    s += `<text x="${x}" y="${y1 + 17}" text-anchor="middle" font-size="11" fill="hsl(40 25% 90% / .4)" font-family="ui-monospace,monospace">${fmtTime(t, xt.dayScale)}</text>`;
  }
  if (unitLabel) {
    s += `<text x="${x0 - 8}" y="${y0 - 9}" text-anchor="end" font-size="10" fill="hsl(40 25% 90% / .35)" font-family="ui-monospace,monospace">${unitLabel}</text>`;
  }
  return s;
}

function linePath(rows, key, xScale, yScale) {
  let d = '', pen = false;
  for (const r of rows) {
    const v = r[key];
    if (v == null) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${xScale(r.t).toFixed(1)},${yScale(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

function renderMain() {
  const H = 340, x0 = 48, x1 = W - 14, y0 = 34, y1 = H - 26;
  const t1 = Date.now(), t0 = t1 - state.hours * 3600000;
  const rows = state.rows;
  if (!rows.length) {
    $('chart').innerHTML = '<div class="empty">No reports in this window. The device speaks first.</div>';
    $('legend').innerHTML = '';
    return;
  }
  const xScale = (t) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
  const vmax = Math.max(...rows.flatMap((r) => SERIES.map((s) => r[s.key]).filter((v) => v != null)), 0.1);
  const yt = niceTicks(vmax * 1.1);
  const yScale = (v) => y1 - (v / yt.max) * (y1 - y0);
  const xt = timeTicks(t0, t1);

  let s = '';
  // class bands under everything, strip along the top
  for (const sp of classSpans(rows, t1)) {
    const c = CLASSES[sp.cls] || CLASSES.UNCAL;
    const a = Math.max(x0, xScale(sp.start)), b = Math.min(x1, xScale(sp.end));
    if (b <= a) continue;
    s += `<rect x="${a.toFixed(1)}" y="${y0}" width="${(b - a).toFixed(1)}" height="${y1 - y0}" fill="${c.fill}"/>`;
    s += `<rect x="${a.toFixed(1)}" y="${y0 - 14}" width="${(b - a).toFixed(1)}" height="5" rx="2" fill="${c.strip}"/>`;
  }
  s += grid(x0, x1, y0, y1, xt, yt, xScale, yScale, 'm · m/s · m²/s');
  for (const t of reboots(rows)) {
    const x = xScale(t);
    s += `<line x1="${x}" x2="${x}" y1="${y0}" y2="${y1}" stroke="hsl(40 25% 90% / .3)" stroke-width="1" stroke-dasharray="3 4"/>`;
    s += `<text x="${x}" y="${y0 - 2}" text-anchor="middle" font-size="10" fill="hsl(40 25% 90% / .5)">↻</text>`;
  }
  for (const sr of SERIES) {
    s += `<path d="${linePath(rows, sr.key, xScale, yScale)}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  // satellite samples get a ringed marker — sparse, so each one matters
  for (const r of rows) {
    if (r.src !== 'sat') continue;
    for (const sr of SERIES) {
      if (r[sr.key] == null) continue;
      s += `<circle cx="${xScale(r.t).toFixed(1)}" cy="${yScale(r[sr.key]).toFixed(1)}" r="4" fill="${sr.color}" stroke="hsl(215 28% 24%)" stroke-width="2"/>`;
    }
  }
  s += `<line id="xhair" x1="0" x2="0" y1="${y0}" y2="${y1}" stroke="hsl(40 30% 93% / .35)" stroke-width="1" visibility="hidden"/>`;

  const svg = svgEl(s, H);
  $('chart').replaceChildren(svg);
  hoverLayer(svg, rows, xScale, x0, x1, (r) => tipHTML(r), y0, y1);

  $('legend').innerHTML =
    SERIES.map((sr) =>
      `<span class="s"><span class="sw" style="background:${sr.color}"></span>${sr.label} <small>(${sr.unit})</small></span>`
    ).join('') +
    '<span class="gap"></span>' +
    [['OPEN', 'open'], ['WARNING', 'warning'], ['CLOSED', 'closed'],
     ['UNCAL', 'unclassed / uncal / no target']].map(([k, label]) => {
      const c = CLASSES[k];
      return `<span class="cls"><span class="b" style="background:${c.strip}"></span>${label}</span>`;
    }).join('');
}

function renderBattery() {
  const H = 130, x0 = 48, x1 = W - 14, y0 = 12, y1 = H - 26;
  const t1 = Date.now(), t0 = t1 - state.hours * 3600000;
  const rows = state.rows.filter((r) => r.batPct != null);
  if (!rows.length) { $('battery').innerHTML = '<div class="empty">No battery data.</div>'; return; }
  const xScale = (t) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
  const yScale = (v) => y1 - (v / 100) * (y1 - y0);
  const xt = timeTicks(t0, t1);
  let s = grid(x0, x1, y0, y1, xt, { ticks: [0, 50, 100] }, xScale, yScale, '%');
  s += `<path d="${linePath(rows, 'batPct', xScale, yScale)}" fill="none" stroke="hsl(40 25% 90% / .55)" stroke-width="2" stroke-linejoin="round"/>`;
  const last = rows[rows.length - 1];
  s += `<circle cx="${xScale(last.t).toFixed(1)}" cy="${yScale(last.batPct).toFixed(1)}" r="4" fill="hsl(40 25% 90% / .8)" stroke="hsl(215 28% 24%)" stroke-width="2"/>`;
  s += `<text x="${Math.min(x1 - 2, xScale(last.t) + 8)}" y="${yScale(last.batPct) - 8}" font-size="11" fill="hsl(40 25% 90% / .7)" font-family="ui-monospace,monospace">${last.batPct}%</text>`;
  s += `<line id="xhair" x1="0" x2="0" y1="${y0}" y2="${y1}" stroke="hsl(40 30% 93% / .35)" stroke-width="1" visibility="hidden"/>`;
  const svg = svgEl(s, H);
  $('battery').replaceChildren(svg);
  hoverLayer(svg, rows, xScale, x0, x1,
    (r) => `<div class="t">${fmtFull(r.t)}</div>battery ${r.batPct}%${r.batV != null ? ` · ${r.batV.toFixed(2)} V` : ''}`,
    y0, y1);
}

function hoverLayer(svg, rows, xScale, x0, x1, html, y0, y1) {
  const ns = 'http://www.w3.org/2000/svg';
  const hit = document.createElementNS(ns, 'rect');
  hit.setAttribute('x', x0); hit.setAttribute('y', y0);
  hit.setAttribute('width', x1 - x0); hit.setAttribute('height', y1 - y0);
  hit.setAttribute('fill', 'transparent');
  svg.appendChild(hit);
  const xhair = svg.querySelector('#xhair');
  const tip = $('tip');
  hit.addEventListener('mousemove', (ev) => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const { x } = pt.matrixTransform(svg.getScreenCTM().inverse());
    let best = null, dist = Infinity;
    for (const r of rows) {
      const d = Math.abs(xScale(r.t) - x);
      if (d < dist) { dist = d; best = r; }
    }
    if (!best) return;
    xhair.setAttribute('x1', xScale(best.t)); xhair.setAttribute('x2', xScale(best.t));
    xhair.setAttribute('visibility', 'visible');
    tip.innerHTML = html(best);
    tip.style.display = 'block';
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - w - 10)}px`;
    tip.style.top = `${Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 10)}px`;
  });
  hit.addEventListener('mouseleave', () => {
    xhair.setAttribute('visibility', 'hidden');
    $('tip').style.display = 'none';
  });
}

function tipHTML(r) {
  const cls = CLASSES[r.class] || CLASSES.UNCAL;
  const rowsHtml = SERIES.map((sr) =>
    `<div class="row"><span><span class="sw" style="background:${sr.color}"></span>${sr.label}</span><span>${
      r[sr.key] == null ? '—' : r[sr.key].toFixed(3) + ' ' + sr.unit}</span></div>`).join('');
  return `<div class="t">${fmtFull(r.t)}</div>
    <div class="row"><span><span class="sw" style="background:${cls.strip}"></span>${esc(r.class)}</span><span>${esc(r.src)}</span></div>
    ${rowsHtml}
    <div class="row"><span>echo</span><span>${r.echo_pct ?? '—'}%</span></div>
    <div class="row"><span>range / dry</span><span>${r.range?.toFixed(3) ?? '—'} / ${r.dry?.toFixed(3) ?? '—'}</span></div>
    <div class="row"><span>battery</span><span>${r.batPct != null ? r.batPct + '%' : '—'}${r.batV != null ? ' · ' + r.batV.toFixed(2) + 'V' : ''}</span></div>
    <div class="row"><span>uptime</span><span>${r.uptime_s != null ? r.uptime_s + ' s' : '—'}</span></div>`;
}

function renderTiles() {
  const last = state.rows[state.rows.length - 1];
  if (!last) { $('tiles').innerHTML = ''; return; }
  const cls = CLASSES[last.class] || CLASSES.UNCAL;
  const rb = reboots(state.rows).length;
  const val = (v, f) => (v == null ? '—' : f(v));
  $('tiles').innerHTML = `
    <div class="tile"><div class="k">Class</div>
      <div class="chip"><span class="dot" style="background:${cls.strip}"></span>${esc(last.class)}</div>
      <div class="m">${ago(last.t)} · ${esc(last.src)}</div></div>
    <div class="tile"><div class="k">Depth</div><div class="v">${val(last.depth, (v) => v.toFixed(3))} <small>m</small></div></div>
    <div class="tile"><div class="k">Velocity</div><div class="v">${val(last.vel, (v) => v.toFixed(2))} <small>m/s</small></div></div>
    <div class="tile"><div class="k">D×V</div><div class="v">${val(last.dv, (v) => v.toFixed(3))} <small>m²/s</small></div>
      <div class="m">closes the road at 0.30</div></div>
    <div class="tile"><div class="k">Battery</div><div class="v">${val(last.batPct, (v) => v)}<small>%</small></div>
      <div class="m">${last.batV != null ? last.batV.toFixed(2) + ' V' : ''}</div></div>
    <div class="tile"><div class="k">Link</div><div class="v" style="font-size:15px">fw ${esc(last.fw ?? '—')}</div>
      <div class="m">${state.rows.length} reports · ${rb} reboot${rb === 1 ? '' : 's'}</div></div>`;
}

function renderTable() {
  const rows = state.rows.slice(-200).reverse();
  if (!rows.length) { $('rawtable').innerHTML = ''; return; }
  const cols = ['received_at', 'src', 'class', 'depth', 'vel', 'dv', 'range', 'dry', 'echo_pct', 'batV', 'batPct', 'uptime_s', 'fw'];
  $('rawtable').innerHTML = `<table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => {
      let v = c === 'received_at' ? fmtFull(r.t) : r[c];
      return `<td>${v == null ? '—' : esc(typeof v === 'number' ? +v.toFixed(4) : v)}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderLive() {
  const last = state.rows[state.rows.length - 1];
  const live = $('live');
  if (!last) { live.classList.add('stale'); $('liveTxt').textContent = 'no data'; return; }
  const stale = Date.now() - last.t > STALE_MS;
  live.classList.toggle('stale', stale);
  $('liveTxt').textContent = stale ? `stale · last heard ${ago(last.t)}` : `live · ${ago(last.t)}`;
}

function render() {
  renderTiles(); renderMain(); renderBattery(); renderTable(); renderLive();
  $('refresh').textContent = `refreshes every ${REFRESH_MS / 1000} s`;
}

// ---------- wiring ----------

$('device').addEventListener('change', (e) => {
  state.device = e.target.value;
  history.replaceState(null, '', `?device=${encodeURIComponent(state.device)}`);
  loadSeries();
});
$('ranges').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.hours = Number(b.dataset.h);
  for (const x of $('ranges').children) x.classList.toggle('on', x === b);
  loadSeries();
});

(async () => {
  await loadDevices();
  await loadSeries();
  state.timer = setInterval(async () => {
    if (document.hidden) return;
    await loadDevices();
    await loadSeries();
  }, REFRESH_MS);
})();
