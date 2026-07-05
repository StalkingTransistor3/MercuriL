const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Inquiries';

const VALID_INQUIRY_TYPES = new Set([
  'Council pilot',
  'Expert consultation',
  'State agency / SES',
  'Media',
  'Other',
]);

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

  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    console.error('Airtable env not set — submission dropped', { name, email });
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;
  const body = {
    records: [
      {
        fields: {
          'Inquiry Type': inquiryType,
          Name: name.trim(),
          Email: email.trim().toLowerCase(),
          Organisation: (organisation || '').trim(),
          Role: (role || '').trim(),
          Message: message.trim(),
          Source: 'mercuril.au',
        },
      },
    ],
    typecast: true,
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('Airtable write failed', resp.status, text);
      return res.status(502).json({ ok: false, error: 'Could not record submission' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Airtable fetch threw', err);
    return res.status(502).json({ ok: false, error: 'Could not record submission' });
  }
});

app.listen(PORT, () => console.log(`MercuriL site listening on ${PORT}`));
