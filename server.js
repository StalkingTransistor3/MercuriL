const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL;

// Neon Postgres. SSL is required by Neon (the connection string carries
// sslmode=require); rejectUnauthorized:false avoids CA-chain friction on
// serverless hosts. Pool kept small — low traffic, Neon pooler endpoint.
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    })
  : null;

const VALID_INQUIRY_TYPES = new Set([
  'Council pilot',
  'Expert consultation',
  'State agency / SES',
  'Media',
  'Other',
]);

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      inquiry_type  text NOT NULL,
      name          text NOT NULL,
      email         text NOT NULL,
      organisation  text,
      role          text,
      message       text NOT NULL,
      source        text,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
}

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://static.cloudflareinsights.com'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'https://cloudflareinsights.com'],
      },
    },
  })
);

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const intakeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many submissions. Try again later.' },
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/api/inquire', intakeLimiter, async (req, res) => {
  const { inquiryType, name, email, organisation, role, message, website } = req.body || {};

  if (website) return res.status(200).json({ ok: true });

  const errors = [];
  if (!inquiryType || !VALID_INQUIRY_TYPES.has(inquiryType)) errors.push('inquiryType');
  if (!name || typeof name !== 'string' || name.trim().length < 2) errors.push('name');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email');
  if (!message || typeof message !== 'string' || message.trim().length < 10) errors.push('message');
  if (errors.length) return res.status(400).json({ ok: false, errors });

  if (!pool) {
    console.error('DATABASE_URL not set — submission dropped', { name, email });
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  try {
    await pool.query(
      `INSERT INTO inquiries (inquiry_type, name, email, organisation, role, message, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        inquiryType,
        name.trim(),
        email.trim().toLowerCase(),
        (organisation || '').trim() || null,
        (role || '').trim() || null,
        message.trim(),
        'mercuril.au',
      ]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('DB insert failed', err);
    return res.status(502).json({ ok: false, error: 'Could not record submission' });
  }
});

ensureSchema()
  .catch((err) => console.error('Schema init failed', err))
  .finally(() => {
    app.listen(PORT, () => console.log(`MercuriL site listening on ${PORT}`));
  });
