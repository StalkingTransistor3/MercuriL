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
test('closure popup preserves evidence, renders null honestly, escapes names', () => {
  const html = display.popup({ name: '<script>bad</script>', device_id: 'fixture', simulated: false,
    deployment: 'installed', state: 'flooded', depth_m: null, velocity_ms: null, dv_product: null,
    closure: { detected_at: '2026-09-13T00:00:00Z', dv_product: .4, device_class: 'CLOSED', telemetry_id: 9 } });
  assert.match(html, /D×V = 0.40 m²\/s/);
  assert.match(html, /Latest depth: not measured/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('safe'));
});
