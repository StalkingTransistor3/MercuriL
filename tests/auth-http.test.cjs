const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { installAuth, COOKIE } = require('../lib/auth');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const path = require('node:path');

test('browser admin keys do not bypass login, and database outages fail closed', async () => {
  const previous = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = crypto.randomBytes(20).toString('hex');
  const app = express();
  installAuth(app, () => ({ query: async () => { throw new Error('Database unavailable'); } }));
  app.get('/api/sensors', (_req, res) => res.json({ allowed: true }));
  app.get('/private.html', (_req, res) => res.send('private content'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { 'x-admin-key': process.env.ADMIN_KEY };
    assert.equal((await fetch(base + '/api/sensors', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/sensors', { headers: { ...headers, 'sec-fetch-site': 'same-origin' } })).status, 401);
    assert.equal((await fetch(base + '/api/sensors', { headers: { ...headers, Origin: base } })).status, 401);
    const cookie = `${COOKIE}=${crypto.randomBytes(32).toString('hex')}`;
    for (const url of ['/api/sensors', '/private.html']) {
      const response = await fetch(base + url, { headers: { Cookie: cookie } });
      assert.equal(response.status, 503);
      assert.equal((await response.text()).includes('private content'), false);
    }
    const missingOrigin = await fetch(base + '/auth/login', { method: 'POST' });
    assert.equal(missingOrigin.status, 403);
    const login = await fetch(base + '/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(login.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = previous;
  }
});

test('the hardware probe authenticates gated readback without logging credentials', async () => {
  const previous = process.env.ADMIN_KEY;
  const deviceToken = crypto.randomBytes(24).toString('hex');
  process.env.ADMIN_KEY = crypto.randomBytes(24).toString('hex');
  const app = express();
  let reports = 0;
  installAuth(app, () => ({ query: async () => { throw new Error('No browser database in probe fixture'); } }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.post('/api/ingest', (req, res) => {
    if (req.get('authorization') !== `Bearer ${deviceToken}`) return res.status(401).json({ ok: false });
    reports++; res.json({ ok: true, id: 1 });
  });
  app.get('/api/series', (_req, res) => res.json([{ class: 'OPEN' }]));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = (extra) => execFile(process.execPath, [path.join(__dirname, '../hardware/probe.js')], {
    env: { ...process.env, BASE: base, TOKEN: deviceToken, ...extra }, timeout: 10_000,
  });
  try {
    const result = await run();
    assert.match(result.stdout, /PIPELINE GREEN/);
    assert.equal(result.stdout.includes(deviceToken), false);
    assert.equal(result.stdout.includes(process.env.ADMIN_KEY), false);
    assert.equal(reports, 1);
    await assert.rejects(run({ ADMIN_KEY: '' }), (error) => error.code === 1 && /before probing/.test(error.stdout));
    assert.equal(reports, 1);
    const wrong = crypto.randomBytes(20).toString('hex');
    await assert.rejects(run({ TOKEN: wrong }), (error) => error.code === 1 && /rejected the device token/.test(error.stdout) && !error.stdout.includes(wrong));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = previous;
  }
});
