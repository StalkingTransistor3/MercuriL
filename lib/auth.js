const crypto = require('node:crypto');
const { promisify } = require('node:util');
const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const COOKIE = 'mercuril_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
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
`;

function normalizeUsername(value) {
  if (typeof value !== 'string') return '';
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
    if (url.origin !== 'https://mercuril.invalid' || /^\/(?:auth|login|api)(?:[/.]|$)/i.test(url.pathname)) return '/';
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
  for (const [url, file] of [['/login', 'login.html'], ['/login.css', 'login.css'], ['/login.js', 'login.js']]) {
    app.get(url, (_req, res) => res.sendFile(path.join(ASSETS, file), { cacheControl: false }));
  }

  const limiter = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { ok: false, error: 'Too many sign-in attempts. Please try again later.' } });
  const globalLimiter = rateLimit({ windowMs: 60_000, limit: 60, keyGenerator: () => 'login',
    standardHeaders: false, legacyHeaders: false, message: { ok: false, error: 'Sign-in is busy. Please try again shortly.' } });

  app.post('/auth/login', sameOrigin, limiter(15 * 60_000, 10), globalLimiter,
    express.json({ limit: '2kb' }), async (req, res) => {
      if (activeChecks >= 2) return res.status(503).json({ ok: false, error: 'Sign-in is busy. Please try again shortly.' });
      activeChecks++;
      try {
        const username = normalizeUsername(req.body?.username);
        const { rows } = await getPool().query('SELECT username, password_hash, disabled FROM app_users WHERE username=$1', [username]);
        const user = rows[0];
        const matches = await verifyPassword(req.body?.password, user?.password_hash || DUMMY_HASH);
        if (!matches || !user || user.disabled) return res.status(401).json({ ok: false, error: 'Username or password is incorrect.' });
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + SESSION_MS);
        // Serialize with password resets / disable so an in-flight login cannot
        // create a usable session after credentials have been revoked.
        const db = await getPool().connect();
        try {
          await db.query('BEGIN');
          const current = await db.query('SELECT password_hash, disabled FROM app_users WHERE username=$1 FOR UPDATE', [username]);
          if (!current.rows[0] || current.rows[0].disabled || current.rows[0].password_hash !== user.password_hash) {
            await db.query('ROLLBACK');
            return res.status(401).json({ ok: false, error: 'Username or password is incorrect.' });
          }
          await db.query('DELETE FROM app_sessions WHERE expires_at <= now() OR token_hash=$1', [hashToken(sessionToken(req))]);
          await db.query('INSERT INTO app_sessions(token_hash, username, expires_at) VALUES ($1,$2,$3)', [hashToken(token), username, expires]);
          await db.query('COMMIT');
        } catch (err) { await db.query('ROLLBACK'); throw err; }
        finally { db.release(); }
        res.cookie(COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_MS });
        res.json({ ok: true, next: safeNext(req.body.next) });
      } catch {
        res.status(503).json({ ok: false, error: 'Sign-in is temporarily unavailable. Please try again.' });
      } finally { activeChecks--; }
    });
  // Never forward login bodies to the telemetry retention/error logger.
  app.use('/auth', (err, _req, res, _next) => {
    res.status(err.status === 413 ? 413 : 400).json({ ok: false, error: 'Invalid sign-in request.' });
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
        const { rows } = await getPool().query(`SELECT u.username, s.expires_at FROM app_sessions s
          JOIN app_users u USING(username) WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled`, [hashToken(token)]);
        if (rows[0]) {
          req.user = rows[0];
          if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return sameOrigin(req, res, next);
          return next();
        }
      }
      if (route.startsWith('/api/') || route.startsWith('/auth/') || !['GET', 'HEAD'].includes(req.method)) {
        return res.status(401).json({ ok: false, error: 'Sign in to continue.', code: 'LOGIN_REQUIRED' });
      }
      res.redirect(302, `/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
    } catch { res.status(503).json({ ok: false, error: 'Access is temporarily unavailable. Please try again.' }); }
  });
  app.get('/auth/session', (req, res) => res.json({ ok: true, username: req.user.username, expires_at: req.user.expires_at }));
}

function hashBuffer(value) { return crypto.createHash('sha256').update(value).digest(); }

module.exports = { AUTH_SCHEMA, COOKIE, hashPassword, verifyPassword, hashToken, normalizeUsername, safeNext, installAuth };
