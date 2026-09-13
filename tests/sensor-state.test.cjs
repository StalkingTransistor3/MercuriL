const { test } = require('node:test');
const assert = require('node:assert/strict');
const { judgement, presentation } = require('../lib/sensor-state');
const display = require('../public/sensor-display');

test('threshold dominates OPEN, including an understated supplied product', () => {
  assert.equal(judgement('OPEN', .3, 1, .3).state, 'flooded');
  assert.equal(judgement('OPEN', .3, -1, 0).state, 'flooded');
  assert.equal(judgement('OPEN', .2, 1, .2).state, 'clear');
  assert.equal(judgement('OPEN', .3, 1, 0).class_derived, true);
});
test('only a positive OPEN/dry reopens; unclassed low readings hold', () => {
  for (const cls of ['UNCAL', 'NO_TARGET', 'unknown', 'UNCLASSED']) {
    assert.equal(judgement(cls, 0, 0, 0).state, null);
  }
  assert.equal(judgement('NO_TARGET', 99, 99, 999).state, null);
  for (const cls of ['WARNING', 'CLOSED', 'wet', 'hazard']) assert.equal(judgement(cls, null, null, null).state, 'flooded');
  assert.equal(judgement('UNCLASSED', .5, 1, .5).state, 'flooded');
});
test('hourly satellite age is stale but expected; no new OPEN is inferred', () => {
  const now = Date.now();
  const p = presentation({ device_id: 'fixture', deployment: 'installed', state: 'clear',
    device_state: 'OPEN', observed_at: new Date(now - 58 * 60000), telemetry_src: 'sat', report_interval_s: 3600 }, now);
  assert.equal(p.stale, true);
  assert.equal(p.reporting, 'satellite_interval');
  assert.equal(p.observation, 'unknown');
});
test('unobserved and simulated devices have honest provenance', () => {
  assert.equal(presentation({ device_id: 'fixture', deployment: 'bench' }).reporting, 'unobserved');
  assert.equal(presentation({ device_id: 'bench-fixture', deployment: 'installed' }).provenance, 'simulated');
  assert.equal(presentation({ device_id: 'fixture', deployment: 'bench' }).provenance, 'bench_unit');
});
test('closure popup leads with decision, retains evidence and escapes names', () => {
  const row = { name: '<script>bad</script>', device_id: 'fixture', deployment: 'installed',
    state: 'flooded', depth_m: null, velocity_ms: null, dv_product: null, device_state: 'NO_TARGET',
    observed_at: new Date(), closure: { detected_at: '2026-09-13T00:00:00Z', dv_product: .4, device_class: 'CLOSED', telemetry_id: 9 } };
  const html = display.popup({ ...row, ...presentation(row) });
  assert.match(html, /KEEP ROAD CLOSED/);
  assert.match(html, /Closed by MercuriL sensor/);
  assert.match(html, /not measured/);
  assert.match(html, /Measurements and WRL limits/);
  assert.ok(!html.includes('Latest depth:'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('safe'));
});

const { assessReport } = require('../lib/flood-assessment');
test('WRL closes deep still water and shallow fast water independently of DV', () => {
  for (const [d,v,dv,code] of [[.3,0,0,'depth_limit'], [.4,0,0,'depth_limit'], [.05,3,.15,'velocity_limit'], [.2,1.5,.3,'dv_limit'], [.15,2,.3,'dv_limit']]) {
    const a = assessReport('OPEN',d,v,dv);
    assert.equal(a.result,'close'); assert.ok(a.reasons.some((r)=>r.code===code));
    assert.equal(judgement('OPEN',d,v,dv).state,'flooded');
  }
});
test('no universal 15 cm rule; below-limit sample never invents OPEN', () => {
  for (const [d,v] of [[.15,0],[.24,0],[.299,0],[.05,2.99]]) {
    assert.equal(assessReport('UNCLASSED',d,v,d*v).result,'below_limits');
    assert.equal(judgement('UNCLASSED',d,v,d*v).state,null);
  }
});
test('missing and invalid channels cannot reopen; independent known breach still closes', () => {
  assert.equal(judgement('OPEN',.31,null,null).state,'flooded');
  assert.equal(judgement('OPEN',null,3,null).state,'flooded');
  for (const d of [null,NaN,Infinity,-1,.2]) assert.equal(judgement('OPEN',d,null,null).state,null);
  assert.equal(assessReport('UNCAL',.5,5,2.5).result,'unknown');
  assert.equal(assessReport('NO_TARGET',.5,5,2.5).result,'unknown');
});
test('bench .24 m still-water reading gets an assessment without a road-opening claim', () => {
  const row = { device_id:'fixture', deployment:'bench', state:'clear', device_state:'UNCLASSED',
    depth_m:.24, velocity_ms:0, dv_product:0, observed_at:'2026-09-10T06:57:15Z' };
  const p = presentation(row, Date.parse('2026-09-13T06:57:15Z'));
  assert.equal(p.assessment.action,'bench'); assert.equal(p.assessment.sample.result,'below_limits');
  const html=display.popup({...row,...p});
  assert.match(html,/LAST SAMPLE: NO CLOSURE TRIGGER/); assert.match(html,/stale observation/);
});
