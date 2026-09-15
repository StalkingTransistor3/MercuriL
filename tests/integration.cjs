// Opt-in: uses a fresh, isolated schema, never public tables or real devices.
// node tests/integration.cjs --isolated-neon [--browser]
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
if (!process.argv.includes('--isolated-neon')) throw new Error('Pass --isolated-neon to create and clean up a temporary test schema');
require('../lib/env').loadEnv();
const { Pool } = require('pg');
const { initDb } = require('../lib/db');
const { hashPassword, hashToken, COOKIE } = require('../lib/auth');
const schema = `bench_mercuril_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
// Neon pooler rejects session startup search_path. Use its direct endpoint so
// the isolated schema is enforced on every test connection, including locks.
const testUrl = new URL(process.env.DATABASE_URL);
if (testUrl.hostname.endsWith('.neon.tech')) testUrl.hostname = testUrl.hostname.replace('-pooler.', '.');
const config = { connectionString: testUrl.toString(), ssl: { rejectUnauthorized: false }, max: 2 };
const control = new Pool(config);
const db = new Pool({ ...config, options: `-c search_path=${schema}` });
require.cache[require.resolve('../lib/db')].exports = { getPool: () => db, initDb: () => initDb(db) };
process.env.ADMIN_KEY = crypto.randomBytes(20).toString('hex');
process.env.DEVICE_TOKEN = crypto.randomBytes(20).toString('hex');
process.env.ROCK7_SECRET = crypto.randomBytes(20).toString('hex');
process.env.ROCK7_DEVICES = '';
const nativeFetch = global.fetch;
const baseline = [[151.7, -32.4], [151.8, -32.4]];
const detour = [[151.7, -32.4], [151.7, -32.39], [151.8, -32.39], [151.8, -32.4]];
let ineffective = false;
let routingCalls = 0;
function polyline(coords) {
  let out = '', prev = [0, 0];
  for (const [lon, lat] of coords) for (const [i, value] of [lat, lon].entries()) {
    const current = Math.round(value * 1e6), delta = current - prev[i];
    prev[i] = current;
    let n = delta < 0 ? ~(delta << 1) : delta << 1;
    while (n >= 32) { out += String.fromCharCode((32 | (n & 31)) + 63); n >>>= 5; }
    out += String.fromCharCode(n + 63);
  }
  return out;
}
global.fetch = async (url, options) => {
  if (String(url).startsWith('https://valhalla1.openstreetmap.de/route')) {
    routingCalls++;
    const avoiding = !!JSON.parse(options.body).exclude_polygons?.length;
    return Response.json({ trip: { summary: { length: avoiding ? 12 : 10, time: avoiding ? 720 : 600 },
      legs: [{ shape: polyline(avoiding && !ineffective ? detour : baseline) }] } });
  }
  if (/^https?:/.test(String(url)) && !String(url).startsWith('http://127.0.0.1:')) throw new Error('Unexpected external request in integration test');
  return nativeFetch(url, options);
};
let server, base, browser, checks = 0;
const loginPassword = crypto.randomBytes(24).toString('hex');
async function login(password = loginPassword, extra = {}) {
  return nativeFetch(base + '/auth/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...extra.headers },
    body: JSON.stringify({ username: 'fixture-user', password, next: '/?device=fixture-field', ...extra.body }) });
}
const cookieFrom = (response) => response.headers.get('set-cookie').split(';')[0];
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
async function api(path, body, auth = 'admin', method) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth === 'admin') headers['x-admin-key'] = process.env.ADMIN_KEY;
  if (auth === 'device') headers.authorization = `Bearer ${process.env.DEVICE_TOKEN}`;
  if (typeof auth === 'object') Object.assign(headers, auth);
  const res = await nativeFetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const wifi = (cls, extra = {}) => api('/api/ingest', { device: 'fixture-field', class: cls, depth: .4, vel: 1, dv: .4, ...extra }, 'device');
const sensors = async () => (await api('/api/sensors')).data.features;
const field = async () => (await sensors()).find((f) => f.properties.device_id === 'fixture-field').properties;
const closures = async () => (await api('/api/sensor-closures')).data.features;
const route = (mode, suffix = '') => api(`/api/route?from=151.7,-32.4&to=151.8,-32.4&mode=${mode}${suffix}`);
(async () => {
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    await initDb(db);
    const { app } = require('../server');
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.on('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const passwordHash = await hashPassword(loginPassword);
    await db.query("INSERT INTO app_users(username,password_hash,access_status,is_admin) VALUES ('fixture-user',$1,'approved',false),('admin',$1,'approved',true)", [passwordHash]);
    let sessionCookie;
    await check('all application pages, assets and read APIs require authentication', async () => {
      for (const p of ['/', '/index.html', '/admin', '/admin.html', '/telemetry', '/telemetry.html', '/net', '/net.html', '/app.js', '/vendor/maplibre-gl.js']) {
        const r = await nativeFetch(base + p, { redirect: 'manual' });
        assert.equal(r.status, 302, p);
        assert.match(r.headers.get('location'), /^\/(?:admin\/)?login\?next=/);
        assert.match(r.headers.get('cache-control'), /no-store/);
      }
      for (const p of ['/api/sensors', '/api/sensor-closures', '/api/closures', '/api/closures/stats', '/api/series', '/api/telemetry/devices', '/api/raw', '/api/route', '/api/geocode', '/api/etl/status', '/auth/session']) {
        const r = await nativeFetch(base + p);
        assert.equal(r.status, 401, p); assert.equal((await r.json()).code, 'LOGIN_REQUIRED');
      }
      assert.equal((await nativeFetch(base + '/healthz')).status, 200);
      assert.equal((await nativeFetch(base + '/login.css')).status, 200);
      const loginPage = await nativeFetch(base + '/login');
      assert.equal(loginPage.status, 200);
      assert.match(loginPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.equal(loginPage.headers.get('x-frame-options'), 'DENY');
      assert.equal((await nativeFetch(base + '/api/sensors', { headers: { authorization: `Bearer ${process.env.DEVICE_TOKEN}` } })).status, 401);
      assert.equal((await nativeFetch(base + '/api/sensors', { headers: { cookie: `${COOKIE}=invalid` } })).status, 401);
    });
    await check('login rejects cross-site requests and does not retain passwords in the raw net', async () => {
      const count = (await db.query('SELECT count(*)::int n FROM raw_hooks')).rows[0].n;
      assert.equal((await login(loginPassword, { headers: { Origin: 'https://evil.example' } })).status, 403);
      assert.equal((await nativeFetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{"password":' })).status, 400);
      assert.equal((await nativeFetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'x'.repeat(3000) }) })).status, 413);
      assert.equal((await db.query('SELECT count(*)::int n FROM raw_hooks')).rows[0].n, count);
      const bad = await login('incorrect');
      const missing = await login('incorrect', { body: { username: 'missing-user' } });
      assert.equal(bad.status, 401); assert.equal(missing.status, 401);
      assert.deepEqual(await bad.json(), await missing.json());
    });
    await check('valid credentials create opaque persistent sessions and preserve deep links', async () => {
      const r = await login(); assert.equal(r.status, 200);
      assert.equal((await r.json()).next, '/?device=fixture-field');
      sessionCookie = cookieFrom(r);
      assert.match(r.headers.get('set-cookie'), /HttpOnly/);
      assert.match(r.headers.get('set-cookie'), /SameSite=Lax/);
      const token = sessionCookie.split('=')[1];
      const stored = (await db.query('SELECT token_hash FROM app_sessions')).rows;
      assert.equal(stored.length, 1); assert.equal(stored[0].token_hash, hashToken(token));
      assert.notEqual(stored[0].token_hash, token);
      assert.equal((await nativeFetch(base + '/', { headers: { Cookie: sessionCookie } })).status, 200);
      assert.equal((await nativeFetch(base + '/api/sensors', { headers: { Cookie: sessionCookie } })).status, 200);
      const user = await nativeFetch(base + '/auth/session', { headers: { Cookie: sessionCookie } });
      assert.equal((await user.json()).username, 'fixture-user');
      assert.equal((await nativeFetch(base + '/api/raw', { headers: { Cookie: sessionCookie } })).status, 401);
      const mutation = await nativeFetch(base + '/api/sensors', { method: 'POST', headers: { Cookie: sessionCookie, Origin: 'https://evil.example' } });
      assert.equal(mutation.status, 403);
      const ssl = await login(loginPassword, { headers: { 'X-Forwarded-Proto': 'https', Origin: base.replace('http:', 'https:') }, body: { next: '//evil.example' } });
      assert.equal(ssl.status, 200); assert.match(ssl.headers.get('set-cookie'), /Secure/); assert.equal((await ssl.json()).next, '/');
    });
    await check('logout revokes the server session; expiry and disabled accounts deny access', async () => {
      assert.equal((await nativeFetch(base + '/auth/logout', { method: 'POST', headers: { Cookie: sessionCookie, Origin: 'https://evil.example' } })).status, 403);
      const out = await nativeFetch(base + '/auth/logout', { method: 'POST', headers: { Cookie: sessionCookie, Origin: base } });
      assert.equal(out.status, 200);
      assert.equal((await nativeFetch(base + '/api/sensors', { headers: { Cookie: sessionCookie } })).status, 401);
      const r = await login(); sessionCookie = cookieFrom(r);
      await db.query('UPDATE app_users SET disabled=true WHERE username=$1', ['fixture-user']);
      assert.equal((await nativeFetch(base + '/api/sensors', { headers: { Cookie: sessionCookie } })).status, 401);
      await db.query('UPDATE app_users SET disabled=false WHERE username=$1', ['fixture-user']);
      await db.query("UPDATE app_sessions SET expires_at=now()-interval '1 second'");
      assert.equal((await nativeFetch(base + '/api/sensors', { headers: { Cookie: sessionCookie } })).status, 401);
    });
    let id, token, trigger;
    await check('provisioning is unobserved; repeat preserves credentials', async () => {
      const body = { device_id: 'fixture-field', name: 'ISOLATED TEST crossing', lon: 151.75, lat: -32.4,
        deployment: 'installed', location_note: 'Isolated automated test fixture', rock7_imei: '000000000000001', report_interval_s: 3600 };
      const r = await api('/api/devices', body);
      assert.equal(r.status, 200); id = r.data.sensor_id; token = r.data.device_token;
      const p = await field(); assert.equal(p.reporting, 'unobserved'); assert.equal(p.depth_m, null); assert.equal(p.battery_pct, null);
      assert.equal((await api('/api/devices', body)).data.device_token, undefined);
      assert.equal((await db.query('SELECT device_token FROM sensors WHERE id=$1', [id])).rows[0].device_token, token);
    });
    await check('CLOSED is acknowledged only after pin and closure evidence are stored', async () => {
      assert.equal((await wifi('CLOSED')).status, 200);
      assert.equal((await field()).state, 'flooded');
      const c = await closures(); assert.equal(c.length, 1); trigger = c[0].properties.closure;
      assert.equal(trigger.dv_product, .4); assert.ok(trigger.telemetry_id);
      assert.equal((await db.query('SELECT count(*)::int n FROM closures')).rows[0].n, 0);
    });
    await check('MercuriL detours; Today preserves baseline and hazard provenance', async () => {
      const today = (await route('today')).data, merc = (await route('mercuril')).data;
      assert.deepEqual(today.coords, baseline); assert.equal(today.hazards[0].provenance, 'real_sensor');
      assert.deepEqual(merc.coords, detour); assert.equal(merc.avoided.length, 1);
    });
    await check('blind reports retain closure trigger and never fabricate zero', async () => {
      for (const cls of ['NO_TARGET', 'UNCAL']) assert.equal((await wifi(cls, { depth: 0, vel: 0, dv: 0 })).status, 200);
      const p = await field(); assert.equal(p.state, 'flooded'); assert.equal(p.depth_m, null);
      assert.deepEqual(p.closure, trigger);
      const r = (await db.query('SELECT depth_m FROM sensor_readings WHERE sensor_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0];
      assert.equal(r.depth_m, null);
      const before = routingCalls;
      assert.equal((await route('mercuril')).data.avoided[0].depth_m, null);
      assert.equal(routingCalls, before);
    });
    await check('old and equal-time OPEN cannot clear a closure; newer OPEN reopens', async () => {
      const p = await field();
      for (const ts of [trigger.detected_at, p.observed_at]) {
        const r = await api('/api/ingest', { sensor_id: 'fixture-field', state: 'dry', depth_mm: 0, velocity_ms: 0, dv_product: 0, ts }, { 'x-device-token': token });
        assert.equal(r.status, 200); assert.equal((await field()).state, 'flooded');
      }
      assert.equal((await wifi('OPEN', { depth: 0, vel: 0, dv: 0 })).status, 200);
      assert.equal((await field()).state, 'clear'); assert.equal((await closures()).length, 0);
      assert.deepEqual((await route('mercuril')).data.coords, baseline);
    });
    await check('D×V override applies to Wi-Fi OPEN and measured product', async () => {
      await wifi('OPEN', { depth: .3, vel: 1, dv: 0 });
      const p = await field(); assert.equal(p.state, 'flooded'); assert.equal(p.class_derived, true);
      assert.equal(p.closure.dv_product, .3);
      const r = (await api('/api/series?device=fixture-field')).data.at(-1);
      assert.equal(r.class, 'OPEN'); assert.equal(r.class_derived, true);
    });
    await check('real device edits are rejected; simulated pins remain editable', async () => {
      assert.equal((await api(`/api/sensors/${id}`, { state: 'clear', depth_m: 0 }, 'admin', 'PATCH')).status, 409);
      assert.equal((await api(`/api/sensors/${id}`, { lon: 1 }, 'admin', 'PATCH')).status, 409);
      assert.equal((await api(`/api/sensors/${id}`, undefined, 'admin', 'DELETE')).status, 409);
      const sim = (await sensors()).find((f) => !f.properties.device_id);
      assert.equal((await api(`/api/sensors/${sim.properties.id}`, { state: 'flooded' }, 'admin', 'PATCH')).status, 200);
      assert.equal((await closures()).length, 1);
      assert.equal((await api('/api/devices', { device_id: 'fixture-field', name: 'ambiguous move', lon: 1, lat: 1 })).status, 409);
      assert.equal((await field()).deployment, 'installed');
    });
    await check('unmapped satellite reports are retained without polluting a real unit', async () => {
      const r = await api(`/api/rock7?secret=${process.env.ROCK7_SECRET}`, { imei: '000000000000002', data: Buffer.from('M2,1,1200,70,100,1,3600,0,0').toString('hex') });
      assert.equal(r.status, 200); assert.equal(r.data.reason, 'unmapped device');
      assert.equal((await db.query("SELECT count(*)::int n FROM telemetry WHERE device='mercuril-01'")).rows[0].n, 0);
      assert.equal((await field()).state, 'flooded');
    });
    await check('satellite M2 is ordered; low unclassed sample holds; M1 threshold overrides OPEN', async () => {
      const sat = (csv, date) => api(`/api/rock7?secret=${process.env.ROCK7_SECRET}`, {
        imei: '000000000000001', transmit_time: date.toISOString().slice(2, 19).replace('T', ' '), data: Buffer.from(csv).toString('hex') });
      // Independent satellite fixture avoids future-dating records on the Wi-Fi unit.
      const body = { device_id: 'fixture-sat', name: 'ISOLATED satellite', lon: 152, lat: -33,
        deployment: 'installed', location_note: 'Isolated test fixture', rock7_imei: '000000000000003', report_interval_s: 3600 };
      await api('/api/devices', body);
      const post = (csv, date = new Date()) => api(`/api/rock7?secret=${process.env.ROCK7_SECRET}`, {
        imei: '000000000000003', transmit_time: date.toISOString().slice(2, 19).replace('T', ' '), data: Buffer.from(csv).toString('hex') });
      assert.equal((await post('M2,1,1200,70,100,2,3600,400,100,100,0')).status, 200);
      let p = (await sensors()).find((f) => f.properties.device_id === 'fixture-sat').properties;
      assert.equal(p.state, 'flooded'); assert.equal(p.device_state, 'UNCLASSED'); assert.equal(p.closure.dv_product, .4);
      assert.equal((await post('M,1,0,300,100,1,300,300,100,2')).status, 200);
      p = (await sensors()).find((f) => f.properties.device_id === 'fixture-sat').properties;
      assert.equal(p.state, 'flooded'); assert.equal(p.class_derived, true);
      await post('M,1,0,0,0,1,0,0,100,0', new Date(Date.now() - 86400000));
      assert.equal((await sensors()).find((f) => f.properties.device_id === 'fixture-sat').properties.state, 'flooded');
    });
    await check('bench closure never becomes a road closure or route hazard', async () => {
      await api('/api/devices', { device_id: 'fixture-bench', name: 'Bench display only', lon: 151.75, lat: -32.4 });
      await api('/api/ingest', { device: 'fixture-bench', class: 'CLOSED', depth: .8, vel: 1, dv: .8 }, 'device');
      assert.ok(!(await closures()).some((f) => f.properties.device_id === 'fixture-bench'));
      assert.ok(!(await route('today')).data.hazards.some((p) => p.device_id === 'fixture-bench'));
    });
    await check('delayed hazard after blind observation closes; legacy partial DV and metadata survive', async () => {
      const r = await api('/api/devices', { device_id: 'fixture-order', name: 'Ordering fixture', lon: 154, lat: -34 });
      const legacy = (body) => api('/api/ingest', { sensor_id: 'fixture-order', ...(body.state === 'dry' ? { velocity_ms: 0, dv_product: 0 } : {}), ...body }, { 'x-device-token': r.data.device_token });
      const t = Date.now() - 10000;
      await legacy({ state: 'dry', depth_mm: 0, ts: new Date(t).toISOString() });
      await legacy({ state: 'unknown', ts: new Date(t + 2000).toISOString() });
      await legacy({ state: 'hazard', depth_mm: 400, ts: new Date(t + 1000).toISOString() });
      let p = (await sensors()).find((f) => f.properties.device_id === 'fixture-order').properties;
      assert.equal(p.state, 'flooded'); assert.equal(p.depth_m, null);
      await legacy({ state: 'dry', depth_mm: 0, ts: new Date(t + 3000).toISOString() });
      await legacy({ dv_product: .4, hazard_class: 'H2', confidence: .9, rise_rate_mm_min: 4,
        temp_c: 20, tilt_deg: 1, batt_v: 7.2, ts: new Date(t + 4000).toISOString() });
      p = (await sensors()).find((f) => f.properties.device_id === 'fixture-order').properties;
      assert.equal(p.state, 'flooded'); assert.equal(p.confidence, .9); assert.equal(p.hazard_class, 'H2');
      assert.equal(p.battery_pct, 50);
      // Numeric closure without a supplied state or hazard class.
      await legacy({ state: 'dry', depth_mm: 0, ts: new Date(t + 5000).toISOString() });
      await legacy({ dv_product: .3, ts: new Date(t + 6000).toISOString() });
      assert.equal((await sensors()).find((f) => f.properties.device_id === 'fixture-order').properties.state, 'flooded');
    });
    await check('stale flooded state stays in closures and routing', async () => {
      await db.query("UPDATE sensors SET observed_at=now()-interval '58 minutes',telemetry_src='sat' WHERE id=$1", [id]);
      const p = await field(); assert.equal(p.stale, true); assert.equal(p.reporting, 'satellite_interval');
      assert.ok((await closures()).some((f) => f.properties.id === id));
      assert.ok((await route('mercuril')).data.avoided.some((p) => p.id === id));
    });
    await check('ineffective exclusion cannot claim successful avoidance', async () => {
      ineffective = true;
      await db.query('UPDATE sensors SET lon=lon+0.0001 WHERE id=$1', [id]);
      const r = (await route('mercuril')).data;
      assert.equal(r.avoidanceUnavailable, true); assert.deepEqual(r.avoided, []);
      assert.ok(r.hazards.length); ineffective = false;
    });
    await check('WRL depth and velocity limits close without a DV breach; incomplete OPEN cannot reopen', async () => {
      // Separate this scenario from the intentionally cached failed detour above.
      await db.query('UPDATE sensors SET lon=lon+0.0001 WHERE id=$1', [id]);
      await wifi('OPEN', {depth:0,vel:0,dv:0});
      let r = await wifi('OPEN', {depth:.4,vel:0,dv:0});
      assert.equal(r.data.assessment.result,'close');
      let p = await field(); assert.equal(p.state,'flooded');
      assert.ok(p.closure.assessment.reasons.some((r)=>r.code==='depth_limit'));
      assert.equal((await route('mercuril')).data.avoided.some((s)=>s.id===id),true);
      await wifi('OPEN', {depth:.2,vel:null,dv:null});
      assert.equal((await field()).state,'flooded');
      await wifi('OPEN', {depth:.2,vel:.5,dv:.1});
      assert.equal((await field()).state,'clear');
      await wifi('OPEN', {depth:.05,vel:3.1,dv:.155});
      p=await field();assert.equal(p.state,'flooded');
      assert.ok(p.closure.assessment.reasons.some((r)=>r.code==='velocity_limit'));
      assert.match(p.assessment.reason,/Water speed/);
    });
    await check('existing observations gain new closure limits without fabricating history or contact', async () => {
      const {reconcileAssessments}=require('../lib/sensor-state');
      await db.query("UPDATE sensors SET state='clear',depth_m=.4,velocity_ms=0,dv_product=0,device_state='OPEN' WHERE id=$1",[id]);
      // Emulate an old-policy open decision, after the previous closure episode.
      await db.query('UPDATE sensor_closures SET reopened_at=now() WHERE sensor_id=$1 AND reopened_at IS NULL',[id]);
      const before=(await db.query('SELECT last_contact,(SELECT count(*) FROM sensor_readings WHERE sensor_id=$1) AS n FROM sensors WHERE id=$1',[id])).rows[0];
      await reconcileAssessments(db);
      const after=(await db.query('SELECT last_contact,(SELECT count(*) FROM sensor_readings WHERE sensor_id=$1) AS n FROM sensors WHERE id=$1',[id])).rows[0];
      assert.deepEqual(after,before);assert.equal((await field()).state,'flooded');
      assert.ok((await field()).closure.assessment.reasons.some((r)=>r.code==='depth_limit'));
    });
    await check('delayed or far-future OPEN cannot reopen despite being newer than a closure', async () => {
      const p=await api('/api/devices',{device_id:'fixture-stale-open',name:'Stale recovery fixture',lon:150,lat:-35});
      const post=(state,depth,ts)=>api('/api/ingest',{sensor_id:'fixture-stale-open',state,depth_m:depth,velocity_ms:0,dv_product:0,ts},{'x-device-token':p.data.device_token});
      await post('hazard',.4,new Date(Date.now()-3600000).toISOString());
      const read=async()=>(await sensors()).find((f)=>f.properties.device_id==='fixture-stale-open').properties;
      await post('dry',0,new Date(Date.now()-1800000).toISOString());
      assert.equal((await read()).state,'flooded');
      const before=(await read()).observed_at;
      await post('dry',0,new Date(Date.now()+86400000).toISOString());
      assert.equal((await read()).state,'flooded');assert.equal((await read()).observed_at,before);
      await post('dry',0,new Date().toISOString());
      assert.equal((await read()).state,'clear');
    });
    await check('projection failure returns 500 with the instrument payload retained', async () => {
      await db.query(`ALTER TABLE sensor_closures RENAME TO sensor_closures_unavailable`);
      const r = await wifi('CLOSED'); assert.equal(r.status, 500);
      assert.equal((await db.query("SELECT class FROM telemetry WHERE device='fixture-field' ORDER BY id DESC LIMIT 1")).rows[0].class, 'CLOSED');
      await db.query(`ALTER TABLE sensor_closures_unavailable RENAME TO sensor_closures`);
    });
    await check('bad secrets, invalid bodies and malformed JSON are kept in the net', async () => {
      assert.equal((await api('/api/rock7?secret=invalid', { hello: 'rejected fixture' })).status, 401);
      const r = await nativeFetch(base + '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
      assert.equal(r.status, 400); assert.ok((await r.json()).kept);
      assert.ok((await db.query('SELECT count(*)::int n FROM raw_hooks')).rows[0].n >= 4);
    });
    if (process.argv.includes('--browser')) {
      await check('desktop/mobile map, live popup and admin labels render', async () => {
        const { chromium } = require('/root/1000-projects-landing-page/node_modules/playwright-core');
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
        const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
        const errors = []; page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + '/?scenario=dungog');
        await page.waitForURL('**/login?next=**');
        await page.screenshot({ path: '/tmp/mercuril-login-desktop.png' });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: '/tmp/mercuril-login-mobile.png' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.setViewportSize({ width: 1365, height: 900 });
        await page.locator('#username').fill('fixture-user');
        await page.locator('#password').fill(loginPassword);
        // Local basemap for deterministic WebGL verification, no tile requests.
        await page.route('**/map-style.js', (r) => r.fulfill({ contentType: 'application/javascript', body: 'async function googleishStyle(){return {version:8,sources:{},layers:[{id:"background",type:"background",paint:{"background-color":"#212c3b"}}]}}' }));
        await page.locator('#submit').click();
        await page.waitForURL(base + '/?scenario=dungog');
        await page.locator('#btnMerc').click();
        await page.waitForFunction(() => document.getElementById('sensorCounts').textContent.includes('installed'));
        await page.waitForTimeout(500);
        // Exercise the actual MapLibre click listener on the rendered closure.
        await page.evaluate(() => {
          const canvas = document.querySelector('.maplibregl-canvas');
          // Fit bounds is fixed for the Dungog scenario at this viewport.
          canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 930, clientY: 265 }));
        });
        await page.waitForSelector('.maplibregl-popup');
        assert.match(await page.locator('.maplibregl-popup').innerText(), /KEEP ROAD CLOSED/);
        assert.match(await page.locator('.maplibregl-popup').innerText(), /Water depth/);
        assert.equal(await page.locator('.assessment-evidence').first().getAttribute('open'), null);
        await page.screenshot({ path: '/tmp/mercuril-map-desktop.png' });
        await page.locator('.maplibregl-popup-close-button').click();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: '/tmp/mercuril-map-mobile.png' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.route('**/api/route?**', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: '{"ok":false}' }));
        await page.goto(base + '/?scenario=pitch');
        await page.waitForFunction(() => document.getElementById('adTitle').textContent.includes('Route update unavailable'));
        assert.match(await page.locator('#adBody').innerText(), /avoidance has not been verified/);
        await page.goto(base + '/admin');
        await page.waitForURL('**/admin/login?next=**');
        await page.locator('#password').fill(loginPassword);
        await page.locator('#submit').click();
        await page.waitForURL(base + '/admin');
        await page.waitForSelector('.sensor');
        const card = page.locator('.sensor').filter({ hasText: 'ISOLATED TEST crossing' });
        assert.equal(await card.locator('[data-toggle]').count(), 0);
        assert.match(await card.innerText(), /Real MercuriL sensor/);
        await page.goto(base + '/telemetry?device=fixture-field');
        await page.waitForFunction(() => document.getElementById('roadDecision').textContent.includes('KEEP ROAD CLOSED'));
        assert.match(await page.locator('#roadDecision').innerText(), /Water depth/);
        assert.deepEqual(errors, []);
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await page.waitForURL(base + '/login');
        await page.goto(base + '/telemetry?device=fixture-field');
        await page.waitForURL('**/login?next=**');
      });
    }
    await check('login rate limiting bounds repeated guesses', async () => {
      let response;
      for (let i = 0; i < 11; i++) response = await login('bad', { headers: { 'X-Forwarded-For': '192.0.2.123' } });
      assert.equal(response.status, 429);
      assert.ok(response.headers.get('retry-after'));
    });
    console.log(`Verified ${checks} integration scenarios; all data stayed in an isolated schema.`);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.end();
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.end();
  }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
