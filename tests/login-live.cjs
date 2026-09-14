// Read-only app smoke plus login/logout, explicitly opt-in. Never prints or
// stores a password or session. Device ingest is tested only in isolation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (process.argv[2] !== '--credentials' || !process.argv[3]) throw new Error('Usage: node tests/login-live.cjs --credentials /private/credentials.json [--browser]');
const credentials = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const base = 'https://mercuril-production.up.railway.app';
const digest = (body) => crypto.createHash('sha256').update(body).digest('hex');
let cookie, browser;
(async () => {
  try {
    for (const route of ['/', '/admin', '/telemetry', '/net', '/index.html', '/app.js', '/vendor/maplibre-gl.js']) {
      const response = await fetch(base + route, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      assert.equal(response.status, 302, `Unauthenticated ${route}`);
      assert.match(response.headers.get('location'), /^\/login\?next=/);
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
    for (const route of ['/api/sensors', '/api/sensor-closures', '/api/series', '/api/raw', '/api/etl/status', '/auth/session']) {
      const response = await fetch(base + route, { signal: AbortSignal.timeout(20_000) });
      assert.equal(response.status, 401, `Unauthenticated ${route}`);
    }
    assert.equal((await fetch(base + '/healthz')).status, 200);
    const login = await fetch(base + '/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: credentials.username, password: credentials.password, next: '/?device=mercuril-01' }) });
    assert.equal(login.status, 200, 'Production login');
    assert.equal((await login.json()).next, '/?device=mercuril-01');
    const setCookie = login.headers.get('set-cookie');
    assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('Secure') && setCookie.includes('SameSite=Lax'));
    cookie = setCookie.split(';')[0];
    for (const [route, file] of [['/', 'public/index.html'], ['/telemetry', 'public/telemetry.html'], ['/admin', 'public/admin.html'],
      ['/net', 'public/net.html'], ['/session.js', 'public/session.js'], ['/login.js', 'auth/login.js'], ['/login.css', 'auth/login.css']]) {
      const response = await fetch(base + route, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, `Authenticated ${route}`);
      assert.equal(digest(await response.text()), digest(fs.readFileSync(path.join(__dirname, '..', file))), `Deployed asset ${route}`);
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
    assert.equal((await fetch(base + '/api/sensors', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(base + '/api/raw', { headers: { Cookie: cookie } })).status, 401);
    const out = await fetch(base + '/auth/logout', { method: 'POST', headers: { Origin: base, Cookie: cookie } });
    assert.equal(out.status, 200);
    assert.equal((await fetch(base + '/api/sensors', { headers: { Cookie: cookie } })).status, 401);
    cookie = null;
    console.log('PASS production: page/API gate, HTTPS login, protected assets match commit, admin separation, logout invalidation');
    if (process.argv.includes('--browser')) {
      const { chromium } = require('/root/1000-projects-landing-page/node_modules/playwright-core');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base + '/?device=mercuril-01');
      await page.waitForURL('**/login?next=**');
      await page.screenshot({ path: '/tmp/mercuril-login-production.png' });
      await page.locator('#username').fill(credentials.username);
      await page.locator('#password').fill(credentials.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL(base + '/?device=mercuril-01');
      await page.waitForFunction(() => document.getElementById('sensorCounts').textContent.includes('bench'));
      await page.locator('#menuBtn').click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.waitForURL(base + '/login');
      await page.goto(base + '/telemetry?device=mercuril-01');
      await page.waitForURL('**/login?next=**');
      assert.deepEqual(errors, []);
      console.log('PASS production mobile browser: login, original device link, live map, sign out and protected telemetry');
    }
  } finally {
    if (cookie) await fetch(base + '/auth/logout', { method: 'POST', headers: { Origin: base, Cookie: cookie } }).catch(() => {});
    if (browser) {
      for (const context of browser.contexts()) await context.request.post(base + '/auth/logout', { headers: { Origin: base } }).catch(() => {});
      await browser.close();
    }
  }
})().catch((error) => {
  // Assertion summaries identify the failed check without dumping credentials,
  // session cookies, SQL connection details or browser call arguments.
  console.error(`Live login verification failed (${error.code || error.name || 'error'}); inspect the named check locally.`);
  process.exitCode = 1;
});
