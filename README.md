# Wallet — private expense & budget tracker for ABB cards

A personal web app that records every card payment automatically from the SMS / notifications ABB already
sends you, sorts it into categories, tracks your budgets, and uses AI to point out bad habits and ways to save.
It runs for free on your own Cloudflare account and only you can open it.

**→ New here? Follow [docs/SETUP.md](docs/SETUP.md)** — a step‑by‑step guide, no coding required.

## What it does

- **Automatic tracking, read‑only.** Your phone forwards ABB's card messages to the app (iPhone Shortcuts or
  Android MacroDroid). No bank login, no access to your money. All 3 cards are recognized by their last 4 digits
  and their balances update from each message. One‑time passwords are ignored and never stored.
- **Understands ABB messages** in Azerbaijani, English and Russian (Məxaric/Mədaxil, Ödəniş, Köçürmə,
  Nağdlaşdırma, foreign‑currency purchases, refunds, balances…). Anything unusual is read by AI; anything still
  unclear lands in an inbox where you can fix it.
- **Categories you control.** ~100 ready‑made categories and subcategories (groceries, eating out, taxi, utilities,
  subscriptions, …). Add, rename, recolor, hide, delete or merge them.
- **Smart, cheap categorization.** Built‑in knowledge of Azerbaijani merchants (Bravo, Araz, Wolt, Bolt, Azercell,
  Azərişıq, SOCAR, Kontakt, Trendyol…) handles most payments for free. AI is asked only about merchants it
  hasn't seen, once each. Every correction you make is remembered for that merchant forever.
- **Each card on its own, transfers you confirm.** ABB's messages only show your own card, never who received the
  money, so every card is tracked separately: money leaving a card is spending, money arriving is income. When the
  same amount leaves one of your cards and arrives on another, the app labels both “own transfer?”. One tap on
  **Yes, my transfer** removes the pair from spending, income and budgets. Nothing is hidden without your say.
- **Rules for the special cases.** Combine conditions on merchant or message text, amount (=, >, <, between), money
  in/out, card, transaction type, category, currency, day of week and time of day, with *all* or *any* matching.
  A rule can set the category or type (incl. “between my cards”), rename the merchant, add tags or a note, or leave
  the transaction out of statistics. A live preview shows which of your past transactions it would catch.
- **Budgets.** Monthly total and per‑category limits, a budget month that can start on salary day, “left to spend
  per day”, pace markers and end‑of‑month projections. Telegram warnings at 80% / 100%.
- **Analytics.** Month‑by‑month income vs spending, category trends, top merchants, a weekday × time heatmap,
  detected subscriptions and regular bills, unusually large payments, any date range you choose.
- **Your own dashboards.** Build dashboards from widgets: pick what to measure (spending, income, savings, number of
  payments, average payment, or all money in/out of each card), how to split it (category, merchant, card, day,
  week, month, weekday, hour, tag, type), the period (presets or custom dates), filters (categories, cards,
  merchant, tag, amount) and the chart (big number, bars, columns, line, area, donut, table, heatmap). Ready‑made
  templates to start from; pin any dashboard to Home.
- **AI coach (Claude).** Weekly and monthly reports with a health score, bad habits with their monthly cost,
  concrete recommendations and suggested budgets. Ask questions in plain language (also in Azerbaijani or Russian):
  “How much did I spend on taxis this month?” — answers are looked up in your real data.
- **Also:** cash expenses with one tap (or by Telegram: `12.5 taxi`), PDF/CSV statement import with duplicate
  detection, select many transactions to recategorize / tag as transfers / hide / delete at once, CSV/JSON export,
  dark mode, installable on your phone.

## Cost

| | Cost |
|---|---|
| Cloudflare Workers + D1 database (free plan: 100k requests/day, 5 GB) | **$0** |
| GitHub (code + deployments) | **$0** |
| Telegram bot | **$0** |
| AI (Claude) — optional, with a hard monthly limit you choose (default $3) | typically **$0.20–$1 / month** |

Why so cheap: the everyday work (reading messages, recognizing merchants) is done by built‑in rules; AI only
sees each new merchant once with a small, fast model (Claude Haiku 5.5), and reports send pre‑computed statistics
rather than raw transactions to the more precise model (Claude Opus 5.5). Both models can be changed in Settings.

## Privacy & security

- Your data lives in a database in **your own** Cloudflare account. Export it any time.
- Login with your password (+ optional two‑step code), brute‑force lockout, secure HttpOnly session cookies,
  cross‑site request protection. The phone connection uses a separate revocable key.
- The app cannot move money or log in to ABB. It only reads notification texts.
- When AI is enabled, merchant names, message texts that need reading, and summary statistics are sent to
  Anthropic's API to produce results. Anthropic does not train on API data by default.

## How it's built

See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the architecture. In short: a Cloudflare Worker
(TypeScript, Hono) serves a JSON API and the React web app; data is in Cloudflare D1 (SQLite); an hourly cron
job handles background AI work, exchange rates (Central Bank of Azerbaijan) and reports.

### Local development

```bash
npm install
cp .dev.vars.example .dev.vars        # set APP_PASSWORD (and optionally ANTHROPIC_API_KEY)
npm run db:migrate:local
npm run build                          # build the web app once (served by wrangler)
npm run dev                            # API on :8787, web app with hot reload on :5173
npm run db:seed:demo                   # optional: 4 months of realistic demo data
npm test                               # unit tests (parser, categorization, budgets, …)
```
