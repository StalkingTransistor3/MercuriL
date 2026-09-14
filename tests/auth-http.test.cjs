const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { installAuth, COOKIE } = require('../lib/auth');

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
