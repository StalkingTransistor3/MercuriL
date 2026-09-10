/* Is the telemetry pipeline actually alive? One command, one verdict.
 *
 *   node hardware/probe.js                 # probe production once
 *   node hardware/probe.js --watch         # re-probe every 15 s until green
 *   BASE=http://localhost:3000 TOKEN=x node hardware/probe.js
 *
 * Posts one reading as device "probe", then reads it back through
 * /api/series — a full round trip through the same path the real unit uses.
 * Each stage prints its own pass/fail so a red run tells you WHERE it died:
 * server down vs token missing vs wrong token vs write-ok-but-can't-read-back.
 */

const BASE = (process.env.BASE || 'https://mercuril-production.up.railway.app').replace(/\/$/, '');
const TOKEN = process.env.TOKEN || 'change-me';
const WATCH = process.argv.includes('--watch');

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

async function probe() {
  console.log(`\nprobing ${BASE} @ ${new Date().toLocaleTimeString('en-AU', { hour12: false })}`);
  let alive = false, ingest = false, readback = false;

  // 1. is anyone home
  try {
    const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(10000) });
    alive = r.ok;
    alive ? ok('server up (/healthz)') : bad(`server answered ${r.status}`);
  } catch (e) {
    bad(`server unreachable: ${e.message}`);
  }
  if (!alive) return false;

  // 2. can a device write
  const body = {
    device: 'probe', fw: 'probe', uptime_s: Math.round(process.uptime()),
    class: 'OPEN', depth: 0.001, vel: 0.001, dv: 0, range: 1.35, dry: 1.351,
    echo_pct: 100, batV: 12.0, batPct: 99, src: 'wifi',
  };
  let id = null;
  try {
    const r = await fetch(`${BASE}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const out = await r.json().catch(() => ({}));
    if (r.ok && out.ok) {
      ingest = true; id = out.id;
      ok(`ingest accepted (id ${id}, received_at ${out.received_at})`);
    } else if (r.status === 503) {
      bad('ingest OFF — DEVICE_TOKEN is not set on the server (Railway → Variables)');
    } else if (r.status === 401) {
      bad(`ingest rejected the token — server has a DEVICE_TOKEN and it isn't "${TOKEN}"`);
    } else {
      bad(`ingest failed: HTTP ${r.status} ${JSON.stringify(out)}`);
    }
  } catch (e) {
    bad(`ingest unreachable: ${e.message}`);
  }

  // 3. can the plot read it back
  if (ingest) {
    try {
      const r = await fetch(`${BASE}/api/series?device=probe&hours=1`, { signal: AbortSignal.timeout(10000) });
      const rows = r.ok ? await r.json() : [];
      readback = Array.isArray(rows) && rows.length > 0;
      readback
        ? ok(`series read back ${rows.length} row(s) — last class ${rows[rows.length - 1].class}`)
        : bad('ingest said ok but /api/series returned nothing — that is a real bug, tell Kira');
    } catch (e) {
      bad(`series unreachable: ${e.message}`);
    }
  }

  const green = alive && ingest && readback;
  console.log(green
    ? `\n\x1b[32mPIPELINE GREEN\x1b[0m — the wire works end to end. ${BASE}/telemetry?device=probe`
    : '\n\x1b[31mPIPELINE BLOCKED\x1b[0m — fix the ✗ above and run again.');
  return green;
}

(async () => {
  if (!WATCH) { process.exit((await probe()) ? 0 : 1); }
  for (;;) {
    if (await probe()) process.exit(0);
    await new Promise((r) => setTimeout(r, 15000));
  }
})();
