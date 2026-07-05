# MercuriL — MercuriL site

Landing site for **MercuriL**, MercuriL' flood-crossing sensor network and verified-closure feed. Node/Express + static frontend + Airtable-backed intake form. Designed to deploy on Railway.

## Stack

- Node 20+ / Express 4
- Vanilla HTML + CSS + JS in `public/`
- Airtable REST API for intake storage (no SDK dependency)
- Helmet + `express-rate-limit` for basic hygiene

## Local dev

```bash
npm install
cp .env.example .env
# fill in AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE
npm run dev
# → http://localhost:3000
```

## Airtable setup

1. Create a new base — suggested name: **MercuriL Intake**.
2. Rename the first table to **Inquiries** (or whatever you set in `AIRTABLE_TABLE`).
3. Add fields (exact names matter — case-sensitive):

   | Field name | Type |
   | --- | --- |
   | Inquiry Type | Single select — options: `Council pilot`, `Expert consultation`, `State agency / SES`, `Media`, `Other` |
   | Name | Single line text |
   | Email | Email |
   | Organisation | Single line text |
   | Role | Single line text |
   | Message | Long text |
   | Source | Single line text |
   | Created | Created time (auto) |

4. Create a Personal Access Token at <https://airtable.com/create/tokens>:
   - Scopes: `data.records:write`, `schema.bases:read`
   - Access: limit to the MercuriL Intake base only
5. Copy the token → `AIRTABLE_TOKEN`. Base ID (starts with `app…`) from the base URL → `AIRTABLE_BASE_ID`.

## Deploy to Railway

1. Push this repo to GitHub (already at `StalkingTransistor3/MercuriL`).
2. In Railway → **New Project → Deploy from GitHub** → pick this repo.
3. Under **Variables**, set:
   - `AIRTABLE_TOKEN`
   - `AIRTABLE_BASE_ID`
   - `AIRTABLE_TABLE` (default `Inquiries`)
4. Railway auto-detects Node via nixpacks and runs `npm start` (see `railway.json`).
5. Under **Settings → Networking**, generate a Railway domain (for smoke-testing) and add your custom domain when ready.
6. Point DNS: `CNAME @ → <project>.up.railway.app` (or `A` record per Railway's instructions).

## Content still to fill

Two blocks in `public/index.html` are marked `data-katya-placeholder` and highlighted in yellow on the page — Katya writes these in her own voice:

- **Hero lede** — the mission opener (2–3 sentences)
- **Team bio** — Katya's short bio (2–3 sentences)

Do not generate these. Judges pattern-match generated vs. lived language.

## Compliance guardrails (Peter Farrell Cup rubric — David Burt)

Do not add to the site pre-finals:

- Pricing / "Buy" / "Get started" CTAs
- Revenue framing (ARR, MRR, "customers")
- ABN or company registration details
- Press releases, "launch" language, funding announcements

The current framing — "we're building this, incubated with UNSW, forming an expert bench" — is the ceiling. See `dashboards/data/reports/2026-06-29-pfc-evidence-ladder-v2.md` for the full rubric note.

## Health check

`GET /healthz` returns `{ ok: true }` — use for Railway health probes if desired.
