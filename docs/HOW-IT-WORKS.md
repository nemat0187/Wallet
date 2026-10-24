# How it works

## Overview

```
 ┌────────────┐  SMS / push   ┌──────────────┐  HTTPS POST /api/ingest   ┌─────────────────────────────┐
 │    ABB     │ ───────────►  │ Your phone   │ ────────────────────────► │ Cloudflare Worker (wallet)  │
 └────────────┘               │ Shortcuts /  │   (connection key)        │                             │
                              │ MacroDroid   │                           │  parse → dedupe → account   │
                              └──────────────┘                           │  → categorize → save (D1)   │
                                                                         │  → alerts (Telegram)        │
 ┌────────────┐  HTTPS (password + session cookie)                       │                             │
 │ Web app    │ ◄──────────────────────────────────────────────────────► │  JSON API  /api/*           │
 │ (React PWA)│                                                          │  static web app (dist/)     │
 └────────────┘                                                          │  hourly cron                │
                                                                         └──────────┬──────────────────┘
                                                                                    │ only when needed
                                                                          ┌─────────▼─────────┐
                                                                          │ Claude API        │
                                                                          └───────────────────┘
```

- **Hosting:** one Cloudflare Worker serves both the API (`worker/`) and the web app (`src/`, built into `dist/`).
  Static files are served directly by Cloudflare; only `/api/*` runs code.
- **Database:** Cloudflare D1 (SQLite). Schema in `migrations/`. Money is stored as integers in qəpik.
- **Background jobs:** a cron trigger runs every hour (`worker/services/cron.ts`): AI categorization backlog,
  and at 09:00 Baku time exchange rates, budget alerts, clean‑up, and weekly (Mondays) / monthly
  (first day of your budget month) AI reports.

## From SMS to transaction

1. **Receive** (`worker/routes/ingest.ts`): the phone posts the message text with its connection key. Field names
   from common forwarder apps are accepted (`text`, `message`, `body`, …). The key can be sent as a Bearer header,
   `X-Api-Key`, `?token=` or a `token` field.
2. **Filter:** one‑time passwords / 3‑D Secure codes are recognized and dropped without being stored. An identical
   message received twice is ignored (hash).
3. **Parse** (`worker/services/parser.ts`): a deterministic parser reads `Key: Value` lines and free text in
   Azerbaijani, English and Russian: amount and currency (incl. foreign currency + AZN equivalent), direction
   (Mədaxil/Məxaric, signs, refund words…), type (purchase, transfer, cash withdrawal, income, refund, fee),
   merchant, card last 4 digits, date/time (Baku time) and balance after. Each result has a confidence score.
4. **AI double‑check:** if the parser is unsure (or a purchase has no merchant), the message is also read by
   Claude with a strict JSON schema; the parser's exact numbers are kept when it was confident about them.
5. **Account:** the card's last 4 digits select the account; unknown cards are created automatically.
   Non‑AZN amounts are converted with official CBAR rates.
6. **Categorize** (`worker/services/categorize.ts`), cheapest and most trustworthy first:
   your rules → merchant memory (your corrections, earlier AI answers) → built‑in merchant dictionary
   (`worker/services/merchants.ts`) → type defaults (cash, fees, transfers) → **AI**, in a background batch,
   only for merchants never seen before. AI results with low confidence are flagged “needs a check”.
   A category is only ever applied to transactions going its direction (income is never turned into spending).
7. **Transfers between your own cards** (same amount out and in within 15 minutes) are marked as internal
   transfers and excluded from spending/income.
8. **Alerts:** Telegram message per transaction (optional), unusual‑amount warning, budget warnings once per
   threshold per month.

## AI usage and cost control (`worker/services/ai.ts`)

| Task | Default model | When |
|---|---|---|
| Categorize new merchants (batched, ≤25 per request) | Claude Haiku 5.5 | once per new merchant |
| Read unusual messages | Claude Haiku 5.5 | only when the parser is unsure |
| Read PDF statements | Claude Haiku 5.5 | when you import |
| Weekly / monthly / on‑demand reports | Claude Opus 5.5 | weekly, monthly, or when you ask |
| Ask AI (chat with tools over your data) | Claude Opus 5.5 | when you ask |

- Every request's token usage and cost is recorded (`ai_usage` table) and shown in Settings → AI.
- A **monthly spending limit** (default $3) is checked before every request; when reached, AI pauses and the app
  keeps working with rules only. Merchants waiting for AI are picked up after the limit resets.
- Reports send **aggregated statistics** (totals, category comparisons with your own averages, habit counters such
  as delivery orders, taxi rides, late‑night purchases, subscriptions and anomalies), not your raw transaction list.
- The chat uses tools (`spending_summary`, `find_transactions`, `budgets_and_subscriptions`) so numbers come from
  SQL queries over your data instead of the model's memory.
- Structured outputs (JSON schemas) are used wherever the app needs data back; refusal fallbacks are enabled for
  the Opus/Sonnet models.

## Security

- Single owner. Password from the `APP_PASSWORD` secret, compared in constant time; optional TOTP two‑step login.
- Login lockout: 5 failures per IP → 15 minutes; 30 failures globally per hour → 30 minutes.
- Sessions: random 256‑bit token in an HttpOnly, Secure, SameSite=Strict cookie; only its SHA‑256 hash is stored;
  30‑day sliding expiry; “log out other devices”.
- State‑changing API calls from other origins are rejected. API responses are `no-store`.
- Phone connection keys are random, stored hashed, revocable, and only allow posting messages.
- Telegram webhook is verified with a secret token; only the linked chat is answered.
- CSV export guards against spreadsheet formula injection. Backups exclude secrets.

## Project layout

```
worker/            Cloudflare Worker (API, cron)
  routes/          HTTP endpoints
  services/        parser, categorization, AI, analytics, budgets, telegram, cron…
  auth/            sessions, TOTP, rate limiting
src/               React web app (pages, components)
shared/            code used by both (types, money/date helpers, default categories)
migrations/        D1 database schema
scripts/           deploy.mjs (used by GitHub Actions), seed-demo.mjs (local demo data)
tests/             unit tests (vitest)
.github/workflows/ CI and one-click Deploy
```

## Ideas for later

- Savings goals and sinking funds; splitting a transaction across categories.
- Web push notifications (in addition to Telegram).
- Email statement parsing (forward ABB e‑statements to the app).
- Multi‑currency accounts with live balances in USD/EUR.
