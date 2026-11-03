# Wallet: what exists and the server contract

Reference for building the native Android app (see `docs/NATIVE-APP-PLAN.md` for the plan). It is written for **the owner**
(to understand what exists) and for **Claude Code** (to build without guessing). Everything in it was checked against the code
in this repository (branch `claude/sharp-tesla-cf8p5c`, database migrations `0001`–`0009`). If something you need is not
here, **read the code, or ask the owner; do not invent it.**

Contents: [1 What exists](#1-what-exists) · [2 How it works](#2-how-it-works) · [3 API contract](#3-api-contract-the-app-may-rely-on) ·
[4 Notification engine specification](#4-notification-engine-specification) · [5 Listener traps](#5-listener-traps-and-their-fixes) ·
[6 Test data](#6-test-data-real-shapes)

---

## 1. What exists

### The idea
A private expense and budget tracker for one person, later opened to friends. Banks and payment apps (ABB today,
**any app the user chooses**) show every card operation as a notification on the phone. The phone forwards the
notifications the user selected to the app's server, which reads them, files them under a category and updates
budgets, charts and AI advice. On Android the forwarder was the free app MacroDroid; **the native Android app
replaces MacroDroid, and works like it: the user picks any apps to listen to and builds triggers (conditions) and
actions, with no hard-coded bank.**

### What was built, in the order it was built
1. **Core.** Cloudflare Worker + D1 (SQLite) + React web app. Bank message parser (Azerbaijani, English, Russian),
   duplicate protection, automatic categories, merchants, rules, budgets, Telegram alerts, cost-capped AI
   (categorizing, weekly/monthly reports, "ask AI" chat), one-click GitHub deploy.
2. **Real ABB format.** Notifications have a title (`💸 Ödəniş: -5.86₼`) that carries the amount plus body lines
   (`Obyekt: …`, `Kart: *1234`, `Tarix: …`, `Mövcud balans: …`). The parser reads both.
3. **Transfers** between own cards (label-only suggestions, manual tagging), **advanced rules** (many conditions,
   many actions, preview), **custom dashboards** with widgets and custom dates, **card balances** that follow
   transactions (deleting or editing a transaction undoes or adjusts its effect), **budgets for a date range**,
   **notes**, a **customizable Home**, seven **themes**.
4. **Step 1, per-user data.** Everything belongs to a user; a database wrapper makes it impossible for a request to
   see another user's rows.
5. **Step 2, people and security.** "Continue with Google", owner approves each newcomer, two-step login with an
   authenticator app plus recovery codes (offered, can be skipped), a PIN on each device, a list of signed-in devices
   with a Telegram alert for new ones.
6. **Step 3, bring your own AI.** Each person adds their own Claude, ChatGPT or Gemini key in Settings → AI.
7. **Later additions.** Dashboard ranges *Today / Yesterday / This week*; support for an app shell (Bearer sessions,
   optional CORS); **savings goals**; **multi-currency** with automatic conversion to AZN (Central Bank of Azerbaijan
   rates, `open.er-api.com` as backup). A "cash after bills" forecast was built and then removed at the owner's request.

### How we worked (so you can continue the same way)
- Small checkpoints. Each ends with type-check, unit tests, relevant end-to-end check, commit and push. Nothing is left
  half-done in the repository.
- Automated checks run against a local server with **mock** Google, AI providers and rate sources (`scripts/*-check.mjs`).
  Real third-party calls could not be made in the build sandbox, so the owner confirms those after deploying.
- Credit was limited, so work was split into phases and each phase was kept shippable.

---

## 2. How it works

### Picture
```
 ABB app ─notification─► Android phone ──HTTPS POST /api/ingest (token)──► Cloudflare Worker "wallet"
                           (today: MacroDroid                              ├ parse → dedupe → account → categorize → D1
                            future: this app)                              ├ budgets, alerts (Telegram), hourly cron
 Web app (React PWA) ◄──── HTTPS, session cookie or Bearer token ───────► ├ JSON API  /api/*
                                                                           └ serves the built web app (dist/)
                                                                              │ only when needed
                                                                              ▼  AI (the person's own key), rate sources
```
One Worker serves both the API (`worker/`) and the web app (`src/` built into `dist/`). `/api/*` runs code; every other
path serves static files and falls back to the single-page app.

### Repository map
| Path | What is in it |
|---|---|
| `worker/index.ts` | Entry: routing, security headers, CORS for app origins, session check, per-user database scoping, cron |
| `worker/routes/` | HTTP endpoints (`auth`, `ingest`, `transactions`, `accounts`, `budgets`, `analytics`, `dashboards`, `notes`, `goals`, `ai`, `imports`, `settings` (also `/bootstrap`, `/rates`, exports), `admin`, `catalog`) |
| `worker/services/` | Parser, categorization, AI layer (`aiproviders/`), analytics, budgets, rates (`fx.ts`), Telegram, cron |
| `worker/auth/` | Sessions, two-step (TOTP), rate limiting |
| `worker/lib/scoped.ts` | **Per-user isolation** (see below) |
| `src/` | React 19 web app (Vite, Tailwind v4, TanStack Query, React Router) |
| `shared/` | Code used by both sides (types, money/date helpers, widgets, goals, home layout) |
| `migrations/` | D1 schema `0001`–`0008`, applied automatically on every deploy |
| `scripts/` | `deploy.mjs` (used by the workflow), `*-check.mjs` end-to-end checks, mocks, demo data |
| `tests/` | Unit tests (vitest) |
| `.github/workflows/` | `ci.yml` (typecheck + tests + build), `deploy.yml` (one-click Deploy) |
| `docs/` | `SETUP.md` (owner's step-by-step), `HOW-IT-WORKS.md` (technical), this file |

### Key rules of the codebase
- **Money** is stored as **integers in minor units** (qəpik, cents). Each transaction has `amount` in its account's
  currency and `amount_base` in AZN. Statistics and budgets always use `amount_base`. Never use floating point for money.
- **Time**: the app works in Baku time (UTC+4, no daylight saving, `tz_offset_minutes` setting). `local_date` is the
  Baku calendar date of a transaction. A "budget month" can start on any day 1–28 (`month_start_day`).
- **Per-user isolation** (`worker/lib/scoped.ts`): after sign-in, every request gets a database that can only see that
  user's rows (it rewrites SQL; anything it cannot make safe throws). Never bypass it. `npm run check:isolation` proves it.
- **Sessions** (`worker/auth/session.ts`): a random token, only its SHA-256 hash is stored, 30 days sliding. A browser
  gets cookie `wallet_session` (HttpOnly, SameSite=Strict). An **app client sends header `x-client: app`** to get the
  token back in JSON instead, and then sends `Authorization: Bearer <token>`. Bearer requests skip the cross-site
  `Origin` check (they carry no cookie).
- **Sign-in methods**: owner password (`APP_PASSWORD` secret, owner is user 1) and Google (server-side OAuth code flow;
  newcomers wait as *pending* until the owner approves them in the web app, Admin → Users). With **two-step**
  enabled, login returns `{ok:false, mfa_required:true}` (plus `mfa_token` for app clients) and
  `POST /api/auth/mfa/verify` completes it with a 6-digit code or a recovery code.
- **PIN** (`src/lib/pin.ts`): 4–6 digits, set twice, **per device, kept in the device's own storage** (browser storage on the web, app-private storage in the native app) as a salted
  PBKDF2 hash. The server never sees it. If the data is cleared, the PIN is simply set again.
- **AI** (`worker/services/ai.ts`): each person's own sealed key (AES-GCM with the `ENCRYPTION_KEY` secret); providers
  Claude, ChatGPT, Gemini behind one interface; monthly token and dollar caps. The owner alone may fall back to the
  `ANTHROPIC_API_KEY` secret.
- **Exchange rates** (`worker/services/fx.ts`): global table `fx_rates`; Central Bank of Azerbaijan first, then
  `open.er-api.com` for today/yesterday, then the nearest earlier rate, then fixed estimates (flagged "approximate").

### Secrets and settings (GitHub secrets → passed to Cloudflare by Deploy)
| Secret | Needed | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | yes | lets the Deploy workflow publish |
| `APP_PASSWORD` | yes | owner's password (12+ characters) |
| `ENCRYPTION_KEY` | auto | created once by Deploy, never replaced (encrypts two-step and AI secrets) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google sign-in | web OAuth client; redirect URI `<site>/api/auth/google/callback` |
| `ANTHROPIC_API_KEY` | optional | owner-only AI fallback |
| `TELEGRAM_BOT_TOKEN` | optional | notifications and quick add |
| `APP_ORIGINS` | optional | comma-separated origins of a *bundled* app shell allowed to call the API |

### Run it locally and run every check
```
npm ci
npm run db:migrate:local          # applies migrations to the local D1
cp .dev.vars.example .dev.vars    # set APP_PASSWORD etc. (never commit)
npm run dev                       # API on :8787, web app on :5173 (proxied)
npm run typecheck && npm test     # type check + unit tests (must stay green)
npm run build                     # web app into dist/
npm run dev:api                   # needed by the next four (they talk to http://127.0.0.1:8787)
npm run check:isolation           # users cannot see each other's data
npm run check:auth                # Google/approval/two-step/devices/Bearer+CORS (needs the mock vars in scripts/auth-check.mjs header)
npm run check:ai                  # three AI providers with mock servers
npm run check:fx                  # exchange rates with mock sources
```

---

## 3. API contract the app may rely on

All paths are under the Worker origin (for example `https://wallet.<name>.workers.dev`). JSON in, JSON out. Errors are
`{"error":"…"}` with an HTTP status. **Money fields are integers in minor units.**

### Sign-in
| Call | Notes |
|---|---|
| `GET /api/auth/me` | No sign-in needed. `{authenticated, password_configured, google_configured, registration_open}` |
| `POST /api/auth/login` `{password}` | Owner password. Success `{ok:true}` (+ `token` with `x-client: app`). With two-step: `{ok:false, mfa_required:true}` (+ `mfa_token` for app clients). `401` wrong password, `429` too many attempts |
| `POST /api/auth/mfa/verify` `{code, mfa_token?}` | Code from the authenticator app or a recovery code. `mfa_token` is only honoured when `x-client: app` is sent. Success `{ok:true}` (+ `token`) |
| `POST /api/auth/logout` | Ends the session (cookie or Bearer) |
| `GET /api/auth/google/start` | Browser redirect flow for Google (website). The native app uses the next two rows |
| `GET /api/auth/google/start?client=app&challenge=<PKCE>` | Open this in a **Chrome Custom Tab** (Google refuses embedded WebViews). `challenge` = base64url(SHA-256(verifier)) (43 chars; the app keeps the random `verifier`, at least 43 characters, secret). Google then returns the person to the app by redirecting the tab to `wallet://auth?code=<one-time code>` or `wallet://auth?status=<pending\|closed\|disabled\|busy\|cancelled\|error>`. `400` if the challenge is malformed |
| `POST /api/auth/app-exchange` `{code, verifier}` + header `x-client: app` | Trades the one-time code for a session. Success `{ok:true, token}`; with two-step on `{ok:false, mfa_required:true, mfa_token}` then `POST /api/auth/mfa/verify {code, mfa_token}` (header `x-client: app`) returns the token. The code lives 5 minutes, works **once** (even a wrong verifier burns it) and is useless without the verifier. `400` = expired / used / wrong verifier, `429` = too many attempts. Verified by `npm run check:auth` |
| `GET /api/bootstrap` | After sign-in: settings, counts, security state (`security.skipped`, two-step status), accounts summary, `origin` |

### The phone webhook (what replaces MacroDroid)
`POST /api/ingest` (no session; **token** in `Authorization: Bearer <token>`, or `X-Api-Key`, `?token=`, or body field `token`).

Send JSON (`content-type: application/json`) or plain text (`text/plain`; the whole body is then the message).
**Do not send `application/x-www-form-urlencoded` with a raw sentence**; it would be read as form fields.

```json
{
  "title": "💸 Ödəniş: -5.86₼",
  "text": "Ödəniş: 5.86 AZN\nObyekt: DOC CHECK CAFE\nKart: *1234\nTarix: 03.11.2026 15:10",
  "package": "<android package name of the bank app>",
  "received_at": 1762182600000,
  "source": "push"
}
```
- `title` **must be included**: for ABB it carries the amount (the server joins `title` and `text`).
- Accepted names: text (`text`, `message`, `body`, …), title (`title`, `notification_title`), sender (`from`, `sender`,
  `package`, `app`), time (`received_at` in ms or s, ISO text also fine; ignored if more than 7 days off), `source`
  (`push` or `sms`).
- Responses (all HTTP 200 with `ok:true` unless noted), verified against a local server:
  - `{"ok":true,"status":"parsed","transaction_id":449,"error":null}` saved.
  - `{"ok":true,"status":"duplicate","transaction_id":449,"error":null}` the identical text was already received. **Resending is always safe.**
  - `{"ok":true,"status":"ignored","transaction_id":null,"error":"Not a transaction"}` (also one-time-password messages, which are never stored).
  - `{"ok":true,"status":"failed","transaction_id":null,"error":"…"}` stored in the app's Inbox for the owner to fix; resending will not help.
  - `401 {"error":"Invalid token"}` / `401 "Missing token"`: the token was revoked or is wrong → **keep the queue**, create a new token (needs the signed-in session) and resend.
  - `400 {"error":"No message text found…"}` nothing to send.
- **Queue rule:** remove a queued notification only after a 200 with `ok:true`. Retry network errors and 5xx later.

### Webhook (ingest) tokens
`GET /api/messages/tokens/list`, `POST /api/messages/tokens {name}` → `{id, token}` (the full token `wlt_…` is shown
**once**; only its hash is stored), `DELETE /api/messages/tokens/:id`. These need a signed-in session. A token can **only**
post messages to `/api/ingest`; it cannot read anything. The native app creates its own token automatically after the first
sign-in (name it like `Android app <phone model>`) and recreates it if the server answers `401`; the user never sees or types it.

### Endpoints the native app uses (all behind the signed-in session unless noted)
`/api/bootstrap`, `/api/transactions`, `/api/accounts`, `/api/budgets`, `/api/analytics/*`, `/api/dashboards`, `/api/notes`,
`/api/goals`, `/api/ai/*`, `/api/import/*`, `/api/admin/*` (owner only), `/api/rates`, `/api/export/*`, `/api/auth/*`,
`/api/messages/*` (inbox + tokens). Their exact request/response shapes are in `worker/routes/*.ts`, `shared/types.ts`, and
(after milestone M0) in `android/contract/*.json`, which are real captured responses. **Never guess a field: read the route
or the fixture.**

### New in the native-app work (does not exist yet; built in milestone M0)
`GET /api/realtime` (WebSocket) for live updates. Specified in `docs/NATIVE-APP-PLAN.md`.

---

## 4. Notification engine specification
The app replaces MacroDroid: any app can be listened to, rules are built inside the app. Built as milestone M3 of `docs/NATIVE-APP-PLAN.md` (steps 4a engine, 4b screens, 4c optional SMS).

**4a, Engine: listener, queue, sender (no screens yet).** `NotificationListenerService`; a **rule engine**; an
persistent queue (Room/SQLite in app-private storage); a WorkManager sender (contract in section 3); a `status` API for the screens (`listenerEnabled`, `queued`, `lastReceivedAt`, `lastUploadedAt`, `lastError`), `openListenerSettings`,
`requestBatteryExemption`. Until 4b exists a single built-in rule "forward everything from package X" configured in a
debug build is enough.

*Rule data model (stored locally, JSON-serializable, versioned with a `schema` number so it can migrate):*
```
Rule   { id, name, enabled, trigger: Trigger, constraints: Constraint[], actions: Action[], stopAfter: boolean }
Trigger{ type: "notification", apps: string[] /* package names; empty = any app */,
         when: "posted" /* posted | removed is optional later */ }
Constraint { field: "title"|"text"|"titleOrText"|"app", op: "contains"|"notContains"|"startsWith"|"endsWith"|"regex"|"equals",
             value: string, ignoreCase: boolean }          // all constraints must match (AND); groups with OR are optional later
Action { type: "sendToWallet", template: string }   // default template "{title}\n{text}"; variables {title} {text} {bigText} {app} {package} {time}
       | { type: "ignore" }                         // drop silently (use with stopAfter to exclude things like OTP or promos)
       | { type: "httpRequest", url, method, headers, body }   // advanced, OFF by default behind a warning; never carries the Wallet token
```
*Evaluation rules (these are the bug-prone part, test them as pure unit tests with no Android classes):*
1. Rules run in list order; for each enabled rule: trigger apps match, then all constraints match, then run its actions
   in order. If `stopAfter` is true, stop evaluating further rules for this notification.
2. If **no** rule fires, the notification is dropped (default deny). Nothing is stored for dropped notifications.
3. `sendToWallet` builds the JSON body of `POST /api/ingest` (`title`, `text`, `package`, `received_at`, `source:"push"`)
   from the *template*; the default template must reproduce the notification title and text unchanged (the server
   needs the title). It writes to the queue, never directly to the network.
4. Regex uses a safe engine with a time limit; an invalid regex disables that rule and shows an error on it (never crashes).
5. One-time-password-looking notifications are *not* filtered in the app (the server already discards them), but the
   user may add an `ignore` rule.
6. Deduplicate on the device: the same (package, title, text, post time) is queued once even if Android posts it twice.

**4b, Screens (native Compose / Material 3).**
- **Macros list**: name, on/off switch, short summary ("Notification from ABB, Kapital Bank → Send to Wallet"), add,
  duplicate, delete, reorder. A first-run template "Forward bank notifications" that the user fills in with apps.
- **Editor with three blocks, like MacroDroid:** *Trigger* (app picker), *Constraints* (add/remove, field, operator,
  value, ignore-case switch), *Actions* (add/remove/reorder, template editor with variable chips and a live preview).
- **App picker**: searchable list of installed apps (icon, name, package), multi-select, "any app" option with a warning,
  a "recently posted notifications" shortcut that lists apps that notified in the last hour so the user can tap one
  (requires the listener to be connected).
- **Test panel**: shows the last 20 notifications seen from the selected apps (title/text kept **in memory only** for
  this screen, wiped when it closes) and, per notification, which rules fire and what the body would be. This is how the
  user debugs a rule; it never reaches the network.
- **Status screen** (onboarding): permission steps with deep links (notification access, battery exemption), "last
  notification received", "last upload", queue size, last error, a "Send test message" button (posts a clearly labelled
  test text to `/api/ingest` and shows the server's reply), and a "reconnect" button that creates a fresh token.

**4c, Optional: SMS trigger.** Banks also send SMS. A second trigger type `sms` (sender number/text conditions) using
`RECEIVE_SMS`; the app is installed from GitHub (not Google Play), so the permission is allowed. Same actions, same queue,
`source:"sms"`. Do it only if the owner asks.

- **Accept, 4a (all required):**
  1. With a rule that forwards package `com.android.shell` (debug build only), post `adb shell cmd notification post -S bigtext -t '💸 Ödəniş: -5.86₼' abbtest 'Ödəniş: 5.86 AZN\nObyekt: TEST CAFE\nKart: *1234\nTarix: 03.11.2026 15:10'` → a transaction appears in the web app within 10 s.
  2. Airplane mode on, post three different notifications, turn the network on → exactly three transactions appear, no duplicates.
  3. Swipe the app away and post one → it arrives. Reboot the phone and post one → it arrives.
  4. Post the same notification twice → one queued item; a repeat that does reach the server answers `duplicate`.
  5. A notification from an app no rule selects → nothing stored, nothing sent, nothing logged.
  6. Revoke the token in the website → the app keeps the queue, creates a new token the next time it is unlocked, and delivers it.
  7. Notification access turned off → banner with a button that opens the right settings screen.
  8. Rule engine unit tests (pure Kotlin/JVM, no emulator): ordering, `stopAfter`, empty `apps` = any app, every operator,
     case sensitivity, invalid regex, the default template, every variable, and 20+ real-shape samples from section 7.
- **Accept, 4b:** create, edit, disable and delete a macro; the picker finds an app by name and by package; a macro with
  an `ignore` rule placed above a `sendToWallet` rule blocks promos but lets purchases through; editing a macro changes
  behaviour on the next notification without restarting the app; the Test panel shows exactly what would be sent;
  rotating the phone or leaving the screen never loses unsaved edits (or asks before discarding).
- **Accept, 4c (if built):** an SMS from a chosen sender arrives as a transaction; SMS permission denied → clear message.
- **Finally, on the owner's phone:** two **different** real apps (ABB and one other bank or wallet app) each produce one
  real purchase end-to-end.


### How the owner will use it (the behaviour the screens in step 4b must deliver)

**One-time setup (about two minutes):**
1. Sign in. The app creates its own ingest token automatically (no pairing screen, nothing to copy). The status screen
   shows "Connected to your wallet".
2. Open **Notifications** in the app. The status screen walks through three green ticks: **Notification access** (button opens Android's settings page; the user switches Wallet on),
   **Battery: unrestricted** (button opens the battery page), **Connected** (the app confirms the listener is bound).
3. Press **Send test message**: a clearly marked test goes to the server and the screen shows the server's answer.

**Building a macro (same mental model as MacroDroid):**
1. **Macros → +** → name it, for example "ABB purchases".
2. **Trigger: Notification posted.** Tap **Select apps**: a searchable list of installed apps appears; tick ABB (and any
   other bank or wallet app: Kapital, Birbank, PASHA, Revolut, PayPal, an Amex app…). Shortcut: "Recently notified apps"
   lists apps that posted in the last hour so a tap picks them. "Any app" exists but warns.
3. **Constraints (optional, all must match):** for example *Title contains "Ödəniş"*, *Text does not contain "kampaniya"*,
   or a regex. Used to skip promos and chat messages.
4. **Actions:** **Send to Wallet** (default; body template `{title}` newline `{text}`, with variable chips {title}, {text},
   {bigText}, {app}, {package}, {time} and a live preview) and optionally **Ignore** (stop quietly). Several macros can
   exist, for example one that sends ABB purchases and a higher one that ignores ABB promos and stops.
5. Save, switch on. The macro works immediately. The **Test panel** shows the last notifications from the chosen apps and
   which macros would fire for each, so a wrong condition is found in seconds.

**What happens to a notification (ingestion, step by step):**
1. Android delivers every notification to Wallet's `NotificationListenerService` (the user allowed that in step 2 above).
   Nothing leaves memory yet.
2. The **rule engine** checks the notification against the enabled macros in order: app matches, constraints match, then
   the actions run. No macro fires = the notification is **dropped on the spot** (never stored, never sent, never logged).
3. `Send to Wallet` renders the body from the template and writes `{title, text, package, received_at, source:"push"}` into
   the **encrypted local queue** (this write is the point of no return: from here the transaction cannot be lost).
4. **WorkManager** sends queued items to `POST /api/ingest` with the token, one at a time, with retry and backoff when
   offline. The server answers `parsed` / `duplicate` / `ignored` / `failed`; for any HTTP 200 with `ok:true` the item
   leaves the queue. A `401` keeps the queue; the app creates a new token and resends.
5. The **server** parses the text, removes duplicates, matches the card to an account, categorizes the merchant (rules,
   built-in dictionary, then the person's AI), saves the transaction and updates budgets and balances. The web part of the
   app shows it immediately; a message the parser cannot read waits in the website's **Inbox** with the reason.
6. The status screen shows "last received", "last uploaded" and the queue size, so a silently failing setup is visible.

---

## 5. Listener traps and their fixes

2. **Notification access is a special permission** the user grants in system settings (Settings → Notifications →
   Device & app notifications). Open it with `Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS`, and detect "not granted"
   (`NotificationManagerCompat.getEnabledListenerPackages`) to show a banner.
3. **Phone makers kill background listeners** (Xiaomi, Huawei, Samsung "sleeping apps"). Ask for battery-optimization
   exemption (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, with an explanation screen), show "last notification
   received" and "last upload" in the app, and provide a "repair" button that re-binds the listener
   (`NotificationListenerService.requestRebind`).
4. **Never lose a transaction.** On every notification: write it to a local queue (Room/SQLite, app-private storage) **first**,
   then try to send. Use WorkManager with exponential backoff and a network constraint. Delete from the queue only
   after HTTP 200 with `ok:true`. The server de-duplicates identical text, so resending is safe. Order of sending does
   not matter.
6. **Listen universally, forward only what the user configured.** There is **no hard-coded bank or package name.** The
   user chooses the apps (a searchable list of installed apps from `PackageManager`) and builds triggers (section 4). A notification from an app that no enabled trigger selects is dropped immediately in memory: never
   stored, never sent, never logged. Always ignore this app's own notifications, ongoing/foreground-service
   notifications and group summaries (unless a trigger explicitly asks for them). Never log notification text. On
   Android 11+ the app needs `QUERY_ALL_PACKAGES` (or a `<queries>` launcher-intent filter) to list installed apps;
   declare it and explain why in the onboarding text.
6b. **Other banks' messages may not parse.** The server parser (`worker/services/parser.ts`) understands ABB's layout and
   common Azerbaijani/English/Russian wording. A different app can produce a message that lands in the web app's
   Inbox as `failed` (status in the ingest reply). That is a *parsing* task for the web repository (new sample →
   parser/test), not something the Android app should work around; the app's job is to deliver the raw title and
   text faithfully and to include the app's package name in `package` so the server records the sender.
10. **Dates and amounts in notifications** are Baku time and `.`-decimal AZN; do not parse them in the app. Send the
    raw text and let the server parse (it is covered by unit tests).

---

## 6. Test data (real shapes)
Use these in tests. The bodies come from `tests/parser.test.ts` (the server's parser handles them); the titles are illustrative, so confirm real titles from the owner's phone:
```
Title: 💸 Ödəniş: -12.50₼     Body: Məxaric: 12.50 AZN / BRAVO SUPERMARKET / Kart: 4169***1234 / Tarix: 24.10.2026 14:32 / Balans: 1 000.00 AZN
Title: 💸 Ödəniş: -7.90₼      Body: Ödəniş: 7.90 AZN / Obyekt: WOLT AZERBAIJAN / Kart: *5678 / Tarix: 24.10.26 09:05 / Mövcud balans: 250.10 AZN
Title: Mədaxil +1500.00₼      Body: Mədaxil: 1500.00 AZN / Kart: 4169****9012 / Tarix: 24.10.2026 10:00 / Balans: 2750.00 AZN
OTP (must be ignored): "Your one-time password is 482913"
```
Device matrix: Android 10, 13 and 14; one Samsung and one Xiaomi/Huawei-class phone if available (battery policies
differ); screen sizes small/large/tablet; system languages English and Azerbaijani.

---
