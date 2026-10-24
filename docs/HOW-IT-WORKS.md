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
   merchant memory (your corrections, earlier AI answers) → built‑in merchant dictionary
   (`worker/services/merchants.ts`) → type defaults (cash, fees; card‑to‑card transfers become “Transfers sent” /
   “Transfers received”) → **AI**, in a background batch, only for merchants never seen before. AI results with
   low confidence are flagged “needs a check”. A category is only ever applied to transactions going its direction
   (income is never turned into spending).
7. **Rules** (`shared/rules.ts`) run next, in your order. Each has up to 20 conditions (text fields, amount,
   direction, card, type, category, currency, weekday, hour range that may wrap midnight) combined with *all* or
   *any*, and actions (category, type, rename, tags, note, exclude). The first matching rule wins unless it is set
   to keep checking; later rules then only fill in what is still unset, and tags add up. A rule's category is
   final (AI never overrides it).
8. **Transfers between your own cards.** Messages only name your own card, so each card is its own ledger and a
   transfer is spending on one card and income on the other. When the same amount leaves one of your cards and
   arrives on another within 30 minutes, both get a `pair_id` pointing at each other: a *suggestion* shown as
   “own transfer?”. They keep counting as spending/income until you confirm (kind → `transfer`, category
   “Between my accounts”), which removes both from spending, income and budgets. “Not a transfer” stores
   `pair_id = 0` so the pair is never suggested again. If you (or one of your rules) already marked one side as
   between your cards, its counterpart follows. **Search my history again** pairs older or imported transactions
   the same way. Cash withdrawals are never paired.
9. **Alerts:** Telegram message per transaction (optional), unusual‑amount warning, budget warnings once per
   threshold per month.

## Custom dashboards (`worker/services/query.ts`, `shared/widgets.ts`)

A dashboard is a named list of widgets stored as JSON (`dashboards` table). Each widget is one query: a metric
(`spent`, `income`, `net`, `count`, `average`, `flow_in`, `flow_out`), a grouping (`category`, `subcategory`,
`merchant`, `account`, `day`, `week`, `month`, `weekday`, `hour`, `tag`, `type`, `weekday_hour` or none), a date
range (presets resolved in the browser from the budget‑month setting, or custom dates), filters (categories incl.
their subcategories, cards, merchant text, tag, amount range, include hidden) and a chart type. `POST
/api/analytics/query` aggregates in SQL, fills gaps in time series, orders weekdays Mon–Sun, collapses the long tail
into “Other”, and can return the previous period of the same length for comparison. `flow_in` / `flow_out` count
everything that moved on a card, transfers included, so a card's money flow adds up to its balance change.

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
migrations/        D1 database schema (applied automatically on every deploy)
scripts/           deploy.mjs (used by GitHub Actions), seed-demo.mjs (local demo data)
tests/             unit tests (vitest)
.github/workflows/ CI and one-click Deploy
```

## Ideas for later

- Savings goals and sinking funds; splitting a transaction across categories.
- Web push notifications (in addition to Telegram).
- Email statement parsing (forward ABB e‑statements to the app).
- Multi‑currency accounts with live balances in USD/EUR.
