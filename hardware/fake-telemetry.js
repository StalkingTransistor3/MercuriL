/* Drive the v0.5 telemetry pipeline without hardware.
 *
 * Walks a full flood cycle in the firmware's own wire schema: cold boot
 * (UNCAL), dry crossing (OPEN), water arriving (WARNING), peak (CLOSED),
 * recession, a NO_TARGET dropout, one mid-cycle reboot, battery sagging
 * throughout. Use it to prove ingest + /api/series + /telemetry end to end,
 * and to rehearse the filming beat before the box is on the pole.
 *
 *   BASE=http://localhost:3000 TOKEN=change-me DEVICE=bench-01 \
 *     node hardware/fake-telemetry.js
 *
 * INTERVAL_MS between posts (default 2000). Server stamps received_at, so a
 * fast interval just compresses the story — that's fine for a bench run.
 */

const BASE = process.env.BASE || 'http://localhost:3000';
const TOKEN = process.env.TOKEN || 'change-me';
const DEVICE = process.env.DEVICE || 'bench-01';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 2000);

const DRY = 1.357; // sensor-to-bed distance when the crossing is dry, metres

function step(i) {
  // depth follows a rise-peak-recede curve over ~80 steps
  const phase = i / 80;
  let depth = 0;
  if (phase > 0.2) depth = Math.max(0, 0.55 * Math.sin(((phase - 0.2) / 0.7) * Math.PI));
  const vel = depth > 0.02 ? +(depth * 2.4 + 0.15).toFixed(3) : 0;
  const dv = +(depth * vel).toFixed(4);

  let cls = 'OPEN';
  if (i < 3) cls = 'UNCAL'; // cold boot, no calibration yet
  else if (i === 46 || i === 47) cls = 'NO_TARGET'; // debris / lost echo
  else if (dv >= 0.3 || depth >= 0.25) cls = 'CLOSED';
  else if (depth >= 0.08) cls = 'WARNING';

  const measured = cls !== 'UNCAL' && cls !== 'NO_TARGET';
  const batV = +(12.3 - i * 0.006).toFixed(2);
  const uptime = i >= 60 ? (i - 60) * INTERVAL_MS / 1000 + 1 : i * INTERVAL_MS / 1000 + 900; // reboot at 60

  return {
    device: DEVICE,
    fw: '0.5-fake',
    uptime_s: Math.round(uptime),
    class: cls,
    depth: measured ? +depth.toFixed(3) : 0,
    vel: measured ? vel : 0,
    dv: measured ? dv : 0,
    range: measured ? +(DRY - depth).toFixed(3) : 0,
    dry: DRY,
    echo_pct: cls === 'NO_TARGET' ? 8 : 100 - Math.round(depth * 20),
    batV,
    batPct: Math.max(0, Math.round(((batV - 10.5) / 2.1) * 100)),
    src: 'wifi',
  };
}

(async () => {
  console.log(`posting to ${BASE}/api/ingest as ${DEVICE}, every ${INTERVAL_MS} ms`);
  for (let i = 0; i <= 90; i++) {
    const body = step(i);
    try {
      const res = await fetch(`${BASE}/api/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      console.log(`#${i} ${body.class} depth=${body.depth} dv=${body.dv} -> ${res.status}`,
        res.ok ? '' : JSON.stringify(out));
      if (res.status === 401 || res.status === 503) process.exit(1);
    } catch (err) {
      console.error(`#${i} failed:`, err.message);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.log('cycle complete — open /telemetry and pick the device');
})();
