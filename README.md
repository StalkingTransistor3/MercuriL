# MercuriL — landing site

Landing site for **MercuriL** — a flood-crossing sensor network and verified-closure feed. Node/Express + static frontend + Neon Postgres intake form. Designed to deploy on Railway.

## Stack

- Node 20+ / Express 4
- Vanilla HTML + CSS + JS in `public/`
- Neon Postgres (via `pg`) for intake storage; schema auto-created on boot
- Helmet + `express-rate-limit` for basic hygiene

## Local dev

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL (Neon connection string)
npm run dev
# → http://localhost:3000
```

## Database (Neon)

Intake submissions are stored in a single `inquiries` table in a Neon Postgres
database. **No manual setup needed** — on startup the server runs a
`CREATE TABLE IF NOT EXISTS`, so the table is created automatically the first
time it boots with a valid `DATABASE_URL`.

Schema:

| Column | Type |
| --- | --- |
| `id` | `bigint` identity, primary key |
| `inquiry_type` | `text` — one of: `Council pilot`, `Expert consultation`, `State agency / SES`, `Media`, `Other` |
| `name` | `text` |
| `email` | `text` |
| `organisation` | `text` (nullable) |
| `role` | `text` (nullable) |
| `message` | `text` |
| `source` | `text` |
| `created_at` | `timestamptz` default `now()` |

Get `DATABASE_URL` from the Neon dashboard → **Connection Details → Pooled connection**. Keep it secret; it only lives in `.env` (gitignored) and Railway Variables.

## Deploy to Railway

1. Push this repo to GitHub (already at `StalkingTransistor3/MercuriL`).
2. In Railway → **New Project → Deploy from GitHub** → pick this repo.
3. Under **Variables**, set:
   - `DATABASE_URL` (the Neon pooled connection string)
4. Railway auto-detects Node via nixpacks and runs `npm start` (see `railway.json`).
5. Under **Settings → Networking**, generate a Railway domain (for smoke-testing) and add your custom domain when ready.
6. Point DNS: `CNAME @ → <project>.up.railway.app` (or `A` record per Railway's instructions).

## Katya's copy — PENDING HER SIGN-OFF

The hero lede and Katya's team bio were drafted **from her own pitch-script
language** (the working draft in the PFC master doc), not invented — but they
speak in her first person and reference her friend's death. **Katya must
read and approve both before the URL is shared anywhere public.** If she
wants the personal line off the website (stage and website are different
exposure levels), swap the hero lede for the impersonal variant:

> "Rural road closures don't reach the apps people trust. We're building the
> sensors and the verified feed that close that gap."

## Compliance guardrails (Peter Farrell Cup rubric — David Burt)

Do not add to the site pre-finals:

- Pricing / "Buy" / "Get started" CTAs
- Revenue framing (ARR, MRR, "customers")
- ABN or company registration details
- Press releases, "launch" language, funding announcements

The current framing — "we're building this, incubated with UNSW, forming an expert bench" — is the ceiling. See `dashboards/data/reports/2026-06-29-pfc-evidence-ladder-v2.md` for the full rubric note.

## Health check

`GET /healthz` returns `{ ok: true }` — use for Railway health probes if desired.
