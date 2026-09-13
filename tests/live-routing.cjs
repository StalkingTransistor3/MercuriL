// Read-only community routing check. Synthetic hazard stays in this process;
// no DB, public device report, or map pin is created. Calls use the normal cache
// and 1 request/second routing throttle.
const assert = require('node:assert/strict');
const { route } = require('../lib/routing');
(async () => {
  const from = [153.047, -28.86], to = [153.43, -29.112];
  const base = await route(from, to, 'today', []);
  const point = base.coords[Math.floor(base.coords.length / 2)];
  const fixture = { id: 'bench-live-route-check', name: 'In-memory routing fixture',
    lon: point[0], lat: point[1], simulated: true, provenance: 'simulated' };
  const today = await route(from, to, 'today', [fixture]);
  const merc = await route(from, to, 'mercuril', [fixture]);
  assert.equal(today.hazards.length, 1);
  assert.equal(merc.avoided.length, 1);
  assert.ok(!merc.avoidanceUnavailable);
  assert.notDeepEqual(today.coords, merc.coords);
  console.log(JSON.stringify({ engine: merc.engine, todayKm: today.distanceKm, avoidingKm: merc.distanceKm,
    extraMinutes: Math.round(merc.extraMin), verified: true,
    scope: 'In-memory synthetic obstacle on a real road route; not an installed crossing test' }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
