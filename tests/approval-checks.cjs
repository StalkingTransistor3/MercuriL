// Runs only inside tests/access.cjs's disposable schema, using real Express/SQL.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { COOKIE } = require('../lib/auth');
module.exports = async function ({ db, adminPassword, cli, directory }) {
  require('../lib/db');
  const originalDb = require.cache[require.resolve('../lib/db')].exports;
  require.cache[require.resolve('../lib/db')].exports = { getPool: () => db };
  const { app } = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const password = crypto.randomBytes(24).toString('base64url');
  let ip = 1, adminCookie, browser;
  const email = 'new.user+pilot@example.invalid';
  const request = (url, body, cookie, extras = {}) => fetch(base + url, {
    method: body ? 'POST' : 'GET', redirect: 'manual',
    headers: { ...(body ? { Origin: base, 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}), 'X-Forwarded-For': `192.0.2.${ip++}`, ...extras },
    body: body ? JSON.stringify(body) : undefined,
  });
  const login = (username = email, pass = password) => request('/auth/login', { username, password: pass });
  const cookieFrom = (r) => r.headers.get('set-cookie').split(';')[0];
  const decision = (username, action, status, disabled = false, cookie = adminCookie) => request('/auth/admin/users/decision', {
    username, action, expected_status: status, expected_disabled: disabled,
  }, cookie);
  try {
    // A repeat migration must not auto-approve new signups.
    const created = await request('/auth/signup', { email: email.toUpperCase(), password, is_admin: true, access_status: 'approved', disabled: false });
    assert.equal(created.status, 202); assert.equal(created.headers.get('set-cookie'), null);
    const pending = (await db.query('SELECT * FROM app_users WHERE username=$1', [email])).rows[0];
    assert.equal(pending.access_status, 'pending'); assert.equal(pending.is_admin, false); assert.notEqual(pending.password_hash, password);
    await db.query(require('../lib/auth').AUTH_SCHEMA);
    assert.equal((await login()).status, 403);
    assert.equal((await (await login()).json()).code, 'APPROVAL_PENDING');
    assert.equal((await login(email, 'wrong')).status, 401);
    assert.equal((await request('/auth/session')).status, 401);
    const duplicate = await request('/auth/signup', { email, password: 'replacement-password-for-test' });
    assert.equal(duplicate.status, 409);
    assert.equal((await db.query('SELECT password_hash FROM app_users WHERE username=$1', [email])).rows[0].password_hash, pending.password_hash);
    assert.equal((await request('/auth/signup', { email: 'bad', password })).status, 400);
    assert.equal((await request('/auth/signup', { email: 'short@example.invalid', password: 'short' })).status, 400);
    assert.equal((await request('/auth/signup', { email: 'csrf@example.invalid', password }, null, { Origin: 'https://evil.example' })).status, 403);
    console.log('PASS sign-up: validated email, pending by default across migrations, no session, no self-promotion, duplicate preserves password');

    const badAdmin = await request('/auth/admin/login', { username: email, password });
    assert.equal(badAdmin.status, 401);
    const admin = await request('/auth/admin/login', { password: adminPassword });
    assert.equal(admin.status, 200); adminCookie = cookieFrom(admin);
    assert.equal((await admin.json()).next, '/admin/access');
    const list = await request('/auth/admin/users', null, adminCookie);
    assert.equal(list.status, 200); const listing = await list.json();
    assert.equal(listing.counts.pending, 1); assert.equal(listing.users[0].email, email);
    assert.equal('password_hash' in listing.users[0], false);
    assert.equal((await request('/auth/admin/users', null, null, { 'x-admin-key': process.env.ADMIN_KEY || 'fixture' })).status, 401);
    assert.equal((await decision(email, 'approve', 'pending', false, '')).status, 401);
    assert.equal((await request('/auth/admin/users/decision', { username: email, action: 'approve', expected_status: 'pending', expected_disabled: false }, adminCookie, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await decision(email, 'approve', 'pending')).status, 200);
    assert.equal((await decision(email, 'reject', 'pending')).status, 409);
    assert.equal((await decision('admin', 'disable', 'approved')).status, 403);
    const admitted = await login(); assert.equal(admitted.status, 200); const memberCookie = cookieFrom(admitted);
    assert.equal((await request('/auth/session', null, memberCookie)).status, 200);
    assert.equal((await request('/auth/admin/users', null, memberCookie)).status, 403);
    assert.equal((await decision(email, 'approve', 'approved', false, memberCookie)).status, 403);
    assert.equal((await request('/admin/access', null, memberCookie)).headers.get('location'), '/admin/login?next=%2Fadmin%2Faccess');
    console.log('PASS admin approval: password-only console, role isolation, CSRF checks, stale-decision conflict, member login only after approval');

    assert.equal((await decision(email, 'disable', 'approved')).status, 200);
    assert.equal((await request('/auth/session', null, memberCookie)).status, 401);
    assert.equal((await login()).status, 403);
    assert.equal((await decision(email, 'approve', 'approved', true)).status, 200);
    const fresh = await login(); assert.equal(fresh.status, 200); const freshCookie = cookieFrom(fresh);
    assert.equal((await decision(email, 'reject', 'approved')).status, 200);
    assert.equal((await request('/auth/session', null, freshCookie)).status, 401);
    assert.equal((await (await login()).json()).code, 'ACCESS_REJECTED');
    assert.equal((await db.query('SELECT count(*)::int n FROM app_access_events WHERE username=$1', [email])).rows[0].n, 4);
    const resetFile = path.join(directory, 'request-reset.json');
    await cli('reset', email, '--out', resetFile);
    const reset = JSON.parse(fs.readFileSync(resetFile, 'utf8'));
    assert.equal((await (await login(email, reset.password)).json()).code, 'ACCESS_REJECTED');
    console.log('PASS revocation: reject/disable ends existing sessions, re-approval works, audit events persist, password reset cannot approve');

    // Expiry/auth role checks must use database state rather than cookie claims.
    await db.query("UPDATE app_users SET is_admin=false WHERE username='admin'");
    assert.equal((await request('/auth/admin/users', null, adminCookie)).status, 403);
    await db.query("UPDATE app_users SET is_admin=true WHERE username='admin'");
    await request('/auth/logout', {}, adminCookie); adminCookie = null;

    if (process.argv.includes('--browser')) {
      const { chromium } = require('/root/1000-projects-landing-page/node_modules/playwright-core');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      const member = await browser.newPage({ viewport: { width: 390, height: 844 } });
      // This suite tests access only; the separate integration suite renders the
      // map against its device fixtures. Avoid road-data calls in an auth schema.
      await member.route('**/app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: '' }));
      const operator = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const browserEmail = 'browser.applicant@example.invalid';
      const errors = []; member.on('pageerror', (e) => errors.push(e.message)); operator.on('pageerror', (e) => errors.push(e.message));
      await member.goto(base + '/signup');
      await member.locator('#email').fill(browserEmail);
      await member.locator('#password').fill(password);
      await member.locator('#confirm').fill(password);
      await member.locator('#submit').click();
      await member.locator('#success').waitFor({ state: 'visible' });
      await member.screenshot({ path: '/tmp/mercuril-signup-mobile.png' });
      await member.goto(base + '/login');
      await member.locator('#username').fill(browserEmail); await member.locator('#password').fill(password);
      await member.locator('#submit').click();
      await member.waitForFunction(() => document.getElementById('error').textContent.includes('awaiting admin approval'));
      await operator.goto(base + '/admin/access');
      await operator.waitForURL('**/admin/login?next=**');
      await operator.locator('#password').fill(adminPassword); await operator.locator('#submit').click();
      await operator.waitForURL(base + '/admin/access');
      await operator.getByRole('button', { name: `Approve ${browserEmail}`, exact: true }).waitFor();
      await operator.screenshot({ path: '/tmp/mercuril-approvals-desktop.png' });
      await operator.setViewportSize({ width: 390, height: 844 });
      assert.equal(await operator.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await operator.screenshot({ path: '/tmp/mercuril-approvals-mobile.png' });
      await operator.getByRole('button', { name: `Approve ${browserEmail}`, exact: true }).click();
      await operator.waitForFunction(() => document.getElementById('message').textContent.includes('they can now sign in'));
      // A protected session endpoint is enough to prove admission; this schema
      // deliberately contains no road or device data.
      await member.locator('#submit').click();
      await member.waitForURL(base + '/');
      assert.equal((await member.request.get(base + '/auth/session')).status(), 200);
      await operator.getByRole('button', { name: /^Approved/ }).click();
      operator.once('dialog', (dialog) => dialog.accept());
      await operator.getByRole('button', { name: `Disable access ${browserEmail}`, exact: true }).click();
      await operator.waitForFunction(() => document.getElementById('message').textContent.includes('access disabled'));
      assert.equal((await member.request.get(base + '/auth/session')).status(), 401);
      await operator.getByRole('button', { name: 'Sign out', exact: true }).click();
      await operator.waitForURL(base + '/admin/login');
      assert.deepEqual(errors, []);
      console.log('PASS desktop/mobile browser: signup → pending denial → admin approval → member login → disable → revoked session');
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    require.cache[require.resolve('../lib/db')].exports = originalDb;
  }
};
