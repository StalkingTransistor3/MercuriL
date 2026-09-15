const crypto = require('node:crypto');
const { promisify } = require('node:util');
const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const COOKIE = 'mercuril_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const ASSETS = path.join(__dirname, '..', 'auth');
// An unknown username still pays the same password-verification cost.
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_users (
  username text PRIMARY KEY,
  password_hash text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash text PRIMARY KEY,
  username text NOT NULL REFERENCES app_users(username) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx ON app_sessions(expires_at);
CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON app_sessions(username);
-- Existing operator-created accounts remain approved during the migration.
-- After adding the column, new accounts default to pending on every boot.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS access_status text NOT NULL DEFAULT 'approved'
  CHECK (access_status IN ('pending','approved','rejected'));
ALTER TABLE app_users ALTER COLUMN access_status SET DEFAULT 'pending';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS reviewed_by text;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_idx ON app_users(email) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS app_access_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (email.length > 254) return '';
  const parts = email.split('@');
  if (parts.length !== 2) return '';
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..')) return '';
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return '';
  return email;
}

function normalizeUsername(value) {
  if (typeof value !== 'string') return '';
  if (value.includes('@')) return normalizeEmail(value);
  const name = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._@+-]{1,79}$/.test(name) ? name : '';
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 16 || Buffer.byteLength(password) > 256) {
    throw new Error('Password must be at least 16 characters and at most 256 bytes');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 256) return false;
  const valid = /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded || '');
  const [, salt, expected] = (valid ? encoded : DUMMY_HASH).split('$');
  const key = await scrypt(password, salt, 64, SCRYPT);
  return crypto.timingSafeEqual(key, Buffer.from(expected, 'hex')) && valid;
}

function sessionToken(req) {
  const matches = (req.get('cookie') || '').split(';').map((s) => s.trim())
    .filter((s) => s.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return '';
  const token = matches[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

function safeNext(value) {
  // Only local page links. Decode as well to reject encoded slash/backslash tricks.
  if (typeof value !== 'string' || value.length > 2048) return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\x00-\x20]/.test(decoded)) return '/';
    const url = new URL(value, 'https://mercuril.invalid');
    if (url.origin !== 'https://mercuril.invalid' || /^\/(?:auth|login|signup|api)(?:[/.]|$)/i.test(url.pathname) || /^\/admin\/login(?:[/.]|$)/i.test(url.pathname)) return '/';
    return url.pathname + url.search + url.hash;
  } catch { return '/'; }
}

function sameOrigin(req, res, next) {
  if (req.get('origin') !== `${req.protocol}://${req.get('host')}` || req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ ok: false, error: 'Please submit from this site.' });
  }
  next();
}

function cookieOptions(req) {
  return { httpOnly: true, secure: req.secure || process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' };
}

function installAuth(app, getPool) {
  let activeChecks = 0;
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  for (const [url, file] of [['/login', 'login.html'], ['/login.css', 'login.css'], ['/login.js', 'login.js'],
    ['/signup', 'signup.html'], ['/signup.js', 'signup.js'], ['/admin/login', 'admin-login.html']]) {
    app.get(url, (_req, res) => res.sendFile(path.join(ASSETS, file), { cacheControl: false }));
  }

  const limiter = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { ok: false, error: 'Too many sign-in attempts. Please try again later.' } });
  const globalLimiter = rateLimit({ windowMs: 60_000, limit: 60, keyGenerator: () => 'login',
    standardHeaders: false, legacyHeaders: false, message: { ok: false, error: 'Sign-in is busy. Please try again shortly.' } });

  const loginLimiter = limiter(15 * 60_000, 10);
  const loginHandler = (adminOnly) => async (req, res) => {
      if (activeChecks >= 2) return res.status(503).json({ ok: false, error: 'Sign-in is busy. Please try again shortly.' });
      activeChecks++;
      try {
        const username = adminOnly ? 'admin' : normalizeUsername(req.body?.username);
        const { rows } = await getPool().query('SELECT username, password_hash, disabled, access_status, is_admin FROM app_users WHERE username=$1', [username]);
        const user = rows[0];
        const matches = await verifyPassword(req.body?.password, user?.password_hash || DUMMY_HASH);
        if (!matches || !user || (adminOnly && !user.is_admin)) return res.status(401).json({ ok: false, error: adminOnly ? 'Admin password is incorrect.' : 'Email or password is incorrect.' });
        const denied = accessDenial(user);
        if (denied) return res.status(403).json(denied);
        const token = crypto.randomBytes(32).toString('hex');
        const duration = user.is_admin ? ADMIN_SESSION_MS : SESSION_MS;
        const expires = new Date(Date.now() + duration);
        // Serialize with password resets / disable so an in-flight login cannot
        // create a usable session after credentials have been revoked.
        const db = await getPool().connect();
        try {
          await db.query('BEGIN');
          const current = await db.query('SELECT password_hash, disabled, access_status, is_admin FROM app_users WHERE username=$1 FOR UPDATE', [username]);
          if (!current.rows[0] || accessDenial(current.rows[0]) || current.rows[0].is_admin !== user.is_admin || current.rows[0].password_hash !== user.password_hash) {
            await db.query('ROLLBACK');
            return res.status(401).json({ ok: false, error: 'Username or password is incorrect.' });
          }
          await db.query('DELETE FROM app_sessions WHERE expires_at <= now() OR token_hash=$1', [hashToken(sessionToken(req))]);
          await db.query('INSERT INTO app_sessions(token_hash, username, expires_at) VALUES ($1,$2,$3)', [hashToken(token), username, expires]);
          await db.query('COMMIT');
        } catch (err) { await db.query('ROLLBACK'); throw err; }
        finally { db.release(); }
        res.cookie(COOKIE, token, { ...cookieOptions(req), maxAge: duration });
        res.json({ ok: true, next: safeNext(req.body.next || (adminOnly ? '/admin/access' : '/')) });
      } catch {
        res.status(503).json({ ok: false, error: 'Sign-in is temporarily unavailable. Please try again.' });
      } finally { activeChecks--; }
    };
  app.post('/auth/login', sameOrigin, loginLimiter, globalLimiter, express.json({ limit: '2kb' }), loginHandler(false));
  app.post('/auth/admin/login', sameOrigin, loginLimiter, globalLimiter, express.json({ limit: '2kb' }), loginHandler(true));

  app.post('/auth/signup', sameOrigin, limiter(60 * 60_000, 5), globalLimiter, express.json({ limit: '2kb' }), async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 16 || Buffer.byteLength(password) > 256) {
      return res.status(400).json({ ok: false, error: 'Use a password of at least 16 characters (up to 256 bytes).' });
    }
    if (activeChecks >= 2) return res.status(503).json({ ok: false, error: 'Sign-up is busy. Please try again shortly.' });
    activeChecks++;
    try {
      const passwordHash = await hashPassword(password);
      // Never accept role/status from the request or overwrite a prior request's
      // password. Both identity fields are derived from the validated email.
      const result = await getPool().query(`INSERT INTO app_users(username,email,password_hash,access_status,is_admin)
        VALUES ($1,$1,$2,'pending',false) ON CONFLICT DO NOTHING RETURNING username`, [email, passwordHash]);
      if (!result.rowCount) return res.status(409).json({ ok: false, error: 'This email is already registered. Sign in with your existing password to check your access.' });
      res.status(202).json({ ok: true, status: 'pending', message: 'Your account is awaiting admin approval. Once approved, you can sign in with your email and password.' });
    } catch { res.status(503).json({ ok: false, error: 'Could not submit your request. Please try again.' }); }
    finally { activeChecks--; }
  });

  app.post('/auth/logout', sameOrigin, async (req, res) => {
    try {
      const token = sessionToken(req);
      if (token) await getPool().query('DELETE FROM app_sessions WHERE token_hash=$1', [hashToken(token)]);
      res.clearCookie(COOKIE, cookieOptions(req));
      res.json({ ok: true });
    } catch { res.status(503).json({ ok: false, error: 'Could not sign out. Please try again.' }); }
  });

  // Method-specific exceptions: machine ingestion keeps its existing contracts.
  // /api/raw is intentionally a write-only catch-all; reads still require admin.
  const ingestion = new Set(['/api/ingest', '/api/rock7', '/api/raw']);
  app.use(async (req, res, next) => {
    const route = req.path.toLowerCase().replace(/\/$/, '');
    const fromBrowser = Boolean(req.get('origin') || req.get('sec-fetch-site'));
    const adminPage = /^\/(?:admin(?:[/.]|$)|net(?:\.|$)|access\.(?:js|css)$)/.test(route);
    if (['GET', 'HEAD'].includes(req.method) && route === '/healthz') return next();
    if (req.method === 'POST' && ingestion.has(route)) return next();
    if (req.method === 'POST' && route === '/api/devices' && !fromBrowser) return next();
    // Existing server-side admin integrations remain usable; never accept a key
    // in a URL or a device token as permission to read the application.
    const supplied = req.get('x-admin-key');
    if (!fromBrowser && route.startsWith('/api/') && process.env.ADMIN_KEY && supplied &&
        crypto.timingSafeEqual(hashBuffer(supplied), hashBuffer(process.env.ADMIN_KEY))) {
      return next();
    }
    try {
      const token = sessionToken(req);
      if (token) {
        const { rows } = await getPool().query(`SELECT u.username, u.is_admin, s.expires_at FROM app_sessions s
          JOIN app_users u USING(username) WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled AND u.access_status='approved'`, [hashToken(token)]);
        if (rows[0]) {
          req.user = rows[0];
          if (adminPage && !req.user.is_admin) return res.redirect(302, `/admin/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
          if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return sameOrigin(req, res, next);
          return next();
        }
      }
      if (route.startsWith('/api/') || route.startsWith('/auth/') || !['GET', 'HEAD'].includes(req.method)) {
        return res.status(401).json({ ok: false, error: 'Sign in to continue.', code: 'LOGIN_REQUIRED' });
      }
      res.redirect(302, `${adminPage ? '/admin/login' : '/login'}?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
    } catch { res.status(503).json({ ok: false, error: 'Access is temporarily unavailable. Please try again.' }); }
  });
  app.get('/auth/session', (req, res) => res.json({ ok: true, username: req.user.username, is_admin: req.user.is_admin, expires_at: req.user.expires_at }));

  const adminOnly = (req, res, next) => req.user?.is_admin ? next() : res.status(403).json({ ok: false, error: 'Admin access required.', code: 'ADMIN_REQUIRED' });
  for (const [url, file] of [['/admin/access', 'access.html'], ['/access.js', 'access.js'], ['/access.css', 'access.css']]) {
    app.get(url, adminOnly, (_req, res) => res.sendFile(path.join(ASSETS, file), { cacheControl: false }));
  }
  app.get('/auth/admin/users', adminOnly, async (req, res) => {
    const filter = req.query.status || 'pending';
    if (!['pending', 'approved', 'rejected', 'disabled'].includes(filter)) return res.status(400).json({ ok: false, error: 'Unknown account filter.' });
    const offset = Number(req.query.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ ok: false, error: 'Invalid page.' });
    try {
      const counts = await getPool().query(`SELECT count(*) FILTER(WHERE NOT disabled AND access_status='pending')::int AS pending,
        count(*) FILTER(WHERE NOT disabled AND access_status='approved')::int AS approved,
        count(*) FILTER(WHERE NOT disabled AND access_status='rejected')::int AS rejected,
        count(*) FILTER(WHERE disabled)::int AS disabled FROM app_users WHERE NOT is_admin`);
      const { rows } = await getPool().query(`SELECT username,email,access_status,disabled,created_at,reviewed_at,reviewed_by
        FROM app_users WHERE NOT is_admin AND (($1='disabled' AND disabled) OR ($1<>'disabled' AND NOT disabled AND access_status=$1))
        ORDER BY created_at DESC, username LIMIT 50 OFFSET $2`, [filter, offset]);
      res.json({ ok: true, users: rows, counts: counts.rows[0], offset, has_more: offset + rows.length < counts.rows[0][filter] });
    } catch { res.status(503).json({ ok: false, error: 'Could not load accounts. Please try again.' }); }
  });
  app.post('/auth/admin/users/decision', adminOnly, express.json({ limit: '2kb' }), async (req, res) => {
    const { action, expected_status: expected, expected_disabled: disabled } = req.body || {};
    const username = normalizeUsername(req.body?.username);
    if (!username || !['approve', 'reject', 'disable'].includes(action) || !['pending', 'approved', 'rejected'].includes(expected) || typeof disabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'Invalid account decision. Refresh and try again.' });
    }
    let db;
    try {
      db = await getPool().connect();
      await db.query('BEGIN');
      // Revalidate admin authority under the same transaction as the decision.
      const actor = await db.query(`SELECT u.username FROM app_users u JOIN app_sessions s USING(username)
        WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_admin AND NOT u.disabled AND u.access_status='approved' FOR UPDATE OF u,s`, [hashToken(sessionToken(req))]);
      if (!actor.rows.length) { await db.query('ROLLBACK'); return res.status(403).json({ ok: false, error: 'Admin session has ended. Sign in again.' }); }
      const { rows } = await db.query('SELECT is_admin,access_status,disabled FROM app_users WHERE username=$1 FOR UPDATE', [username]);
      const user = rows[0];
      if (!user) { await db.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'Account not found.' }); }
      if (user.is_admin) { await db.query('ROLLBACK'); return res.status(403).json({ ok: false, error: 'Admin credentials are managed on the server.' }); }
      if (user.access_status !== expected || user.disabled !== disabled) {
        await db.query('ROLLBACK'); return res.status(409).json({ ok: false, error: 'This account has changed. Refresh and review it again.' });
      }
      const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : user.access_status;
      await db.query(`UPDATE app_users SET access_status=$2,disabled=$3,reviewed_at=now(),reviewed_by=$4 WHERE username=$1`, [username, status, action === 'disable', req.user.username]);
      await db.query('DELETE FROM app_sessions WHERE username=$1', [username]);
      await db.query('INSERT INTO app_access_events(username,actor,action) VALUES ($1,$2,$3)', [username, req.user.username, action]);
      await db.query('COMMIT');
      res.json({ ok: true, status, disabled: action === 'disable' });
    } catch {
      if (db) await db.query('ROLLBACK').catch(() => {});
      res.status(503).json({ ok: false, error: 'The decision could not be saved. Refresh before trying again.' });
    } finally { if (db) db.release(); }
  });
  // Authentication bodies never enter telemetry retention or default error pages.
  app.use('/auth', (err, _req, res, _next) => res.status(err.status === 413 ? 413 : 400).json({ ok: false, error: 'Invalid access request.' }));
}

function accessDenial(user) {
  if (user.disabled) return { ok: false, code: 'ACCESS_DISABLED', error: 'Your access has been disabled. Contact the MercuriL team.' };
  if (user.access_status === 'pending') return { ok: false, code: 'APPROVAL_PENDING', error: 'Your account is awaiting admin approval. Please check back and sign in once approved.' };
  if (user.access_status !== 'approved') return { ok: false, code: 'ACCESS_REJECTED', error: 'Your access request has not been approved. Contact the MercuriL team.' };
  return null;
}
function hashBuffer(value) { return crypto.createHash('sha256').update(value).digest(); }

module.exports = { AUTH_SCHEMA, COOKIE, hashPassword, verifyPassword, hashToken, normalizeUsername, normalizeEmail, safeNext, installAuth };
