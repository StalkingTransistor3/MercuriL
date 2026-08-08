#!/usr/bin/env node
/*
 * Simulated MercuriL unit — posts real /api/ingest payloads so the pipeline can
 * be proven, and the filming beat rehearsed, before the hardware exists.
 *
 *   ADMIN_KEY=... node hardware/fake-device.js
 *   BASE=https://<host> ADMIN_KEY=... node hardware/fake-device.js --fast
 *
 * Provisions (or re-provisions) a device at a real Northern Rivers crossing,
 * then walks it dry -> wet -> hazard -> receding -> dry. Watch the public map:
 * the dot flips within 5 s and any route across it redraws.
 *
 * Ctrl-C leaves the sensor in place. --cleanup removes it.
 */

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_KEY;
const FAST = process.argv.includes('--fast');
const CLEANUP = process.argv.includes('--cleanup');
const STEP_MS = FAST ? 1200 : 4000;

const DEVICE = {
  device_id: 'MRC-SIM-01',
  name: 'Tabulam Causeway, Bruxner Hwy (simulated unit)',
  lon: 152.575,
  lat: -28.885,
};

// depth_mm, velocity m/s, device state. Roughly a flash-flood profile over a
// causeway: rises fast, peaks over the vehicle-stability threshold, drains slower.
const PROFILE = [
  [0, 0.0, 'dry'], [0, 0.0, 'dry'],
  [15, 0.4, 'wet'], [48, 0.8, 'wet'], [95, 1.3, 'wet'],
  [150, 1.9, 'hazard'], [187, 2.24, 'hazard'], [230, 2.4, 'hazard'],
  [205, 2.1, 'hazard'], [160, 1.7, 'hazard'], [110, 1.2, 'wet'],
  [60, 0.7, 'wet'], [22, 0.3, 'wet'], [0, 0.0, 'dry'],
];

async function post(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 120) }; }
  return { status: r.status, json };
}

(async () => {
  if (!ADMIN_KEY) {
    console.error('ADMIN_KEY not set — needed once, to provision the device.');
    process.exit(1);
  }

  const prov = await post('/api/devices', DEVICE, { 'x-admin-key': ADMIN_KEY });
  if (!prov.json.ok) {
    console.error('provisioning failed:', prov.status, prov.json);
    process.exit(1);
  }
  const { device_token: token, sensor_id: id } = prov.json;
  console.log(`provisioned ${DEVICE.device_id} as sensor ${id} at ${DEVICE.name}`);

  if (CLEANUP) {
    await fetch(`${BASE}/api/sensors/${id}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    console.log('removed.');
    return;
  }

  console.log(`posting to ${BASE}/api/ingest every ${STEP_MS / 1000}s — watch the map\n`);

  for (const [depth_mm, velocity_ms, state] of PROFILE) {
    const dv = (depth_mm / 1000) * velocity_ms;
    // AR&R vehicle-stability bands, approximate — see SENSOR-DESIGN.md §1,
    // still to be confirmed against Book 6 Ch.7 before anything is printed.
    const hazard_class = dv >= 0.6 ? 'H4' : dv >= 0.3 ? 'H3' : dv >= 0.15 ? 'H2' : 'H1';
    const r = await post('/api/ingest', {
      sensor_id: DEVICE.device_id,
      ts: new Date().toISOString(),
      depth_mm,
      depth_p95_mm: depth_mm ? Math.round(depth_mm * 1.14) : 0,
      depth_p5_mm: depth_mm ? Math.round(depth_mm * 0.86) : 0,
      velocity_ms,
      velocity_spread: velocity_ms ? +(velocity_ms * 0.14).toFixed(2) : 0,
      dv_product: +dv.toFixed(3),
      hazard_class,
      rise_rate_mm_min: 4.1,
      wet_50mm: depth_mm >= 50,
      wet_150mm: depth_mm >= 150,
      tilt_deg: 44.2,
      temp_c: 14.8,
      batt_v: 7.9,
      confidence: state === 'dry' ? 0.97 : 0.86,
      state,
    }, { 'x-device-token': token });

    const shown = r.json.state ? r.json.state.toUpperCase() : `ERR ${r.status}`;
    console.log(
      `  ${String(depth_mm).padStart(3)} mm  ${velocity_ms.toFixed(2)} m/s  ` +
      `D×V ${dv.toFixed(3)}  ${hazard_class}  device:${state.padEnd(7)} → map: ${shown}`
    );
    await new Promise((r) => setTimeout(r, STEP_MS));
  }

  console.log('\nprofile complete. `--cleanup` removes the simulated unit.');
})();
