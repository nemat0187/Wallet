# Wallet: hand-off for the Android app

This document is written for two readers: **the owner** (to understand what exists) and **an AI coding agent such as
Antigravity** (to build the Android app without guessing). Everything in it was checked against the code in this
repository (branch `claude/sharp-tesla-cf8p5c`, database migrations `0001`–`0008`). If something you need is not
here, **ask the owner; do not invent it.**

Contents: [1 What exists](#1-what-exists) · [2 How it works](#2-how-it-works) · [3 API contract](#3-api-contract-the-app-may-rely-on) ·
[4 Architecture decision](#4-architecture-decision) · [5 Known traps](#5-known-traps-and-their-fixes) ·
[6 Phased plan](#6-phased-plan-with-acceptance-tests) · [7 Anti-bug protocol](#7-anti-bug-protocol-for-the-coding-agent) ·
[8 Owner checklist](#8-owner-checklist-and-glossary)

---

## 1. What exists

### The idea
A private expense and budget tracker for one person, later opened to friends. Banks and payment apps (ABB today,
**any app the user chooses**) show every card operation as a notification on the phone. The phone forwards the
notifications the user selected to the app's server, which reads them, files them under a category and updates
budgets, charts and AI advice. On Android the forwarder was the free app MacroDroid; **the mobile app replaces
MacroDroid, and works like it: the user picks any apps to listen to and builds triggers (conditions) and actions,
with no hard-coded bank.** The app also wraps the web app.

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
4. **Phase 1, per-user data.** Everything belongs to a user; a database wrapper makes it impossible for a request to
   see another user's rows.
5. **Phase 2, people and security.** "Continue with Google", owner approves each newcomer, two-step login with an
   authenticator app plus recovery codes (offered, can be skipped), a PIN on each device, a list of signed-in devices
   with a Telegram alert for new ones.
6. **Phase 3, bring your own AI.** Each person adds their own Claude, ChatGPT or Gemini key in Settings → AI.
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
- **PIN** (`src/lib/pin.ts`): 4–6 digits, set twice, **per device, kept in the browser/WebView storage** as a salted
  PBKDF2 hash. The server never sees it. If the app's data is cleared, the PIN is simply set again.
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
| `GET /api/auth/google/start` | Browser redirect flow for Google (web). **Never open it inside the WebView** (Google refuses embedded browsers). For the app use the next two rows |
| `GET /api/auth/google/start?client=app&challenge=<PKCE>` | Open this in a **Chrome Custom Tab**. `challenge` = base64url(SHA-256(verifier)) (43 chars; the app keeps the random `verifier`, at least 43 characters, secret). Google then returns the person to the app by redirecting the tab to `wallet://auth?code=<one-time code>` or `wallet://auth?status=<pending\|closed\|disabled\|busy\|cancelled\|error>`. `400` if the challenge is malformed |
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
  - `401 {"error":"Invalid token"}` / `401 "Missing token"`: the token was revoked or is wrong → **keep the queue**, ask the owner to re-pair.
  - `400 {"error":"No message text found…"}` nothing to send.
- **Queue rule:** remove a queued notification only after a 200 with `ok:true`. Retry network errors and 5xx later.

### Webhook tokens (created in the web app)
`GET /api/messages/tokens/list`, `POST /api/messages/tokens {name}` → `{id, token}` (the full token `wlt_…` is shown
**once**), `DELETE /api/messages/tokens/:id`. The web app's *Settings → Phone connection* page creates one and shows the
link; native code must receive it via the bridge (trap 5), not by asking the user to type it.

### Other endpoints the web app uses (the app shell does not call these itself)
`/api/transactions`, `/api/accounts`, `/api/budgets`, `/api/analytics/*`, `/api/dashboards`, `/api/notes`, `/api/goals`,
`/api/ai/*`, `/api/import/*`, `/api/admin/*` (owner only), `/api/rates`, `/api/export/transactions.csv`,
`/api/export/backup.json`. The mobile app **loads the web app**, so it never needs to re-implement them.

**Rule:** the native code may call only `/api/ingest` (and, in the optional bundled mode, the sign-in calls above). Any
other need is a request to the owner.

---

## 4. Architecture decision

**Recommended: a Capacitor (Android) shell that loads the deployed website (`server.url`), plus a small native layer.**

Why this is the lowest-bug route:
- **Zero duplicated UI.** The whole product (charts, budgets, rules, goals, multi-currency, AI) already works and is
  tested. Re-writing it natively would take months and create new bugs.
- **Same-origin, so nothing special is needed for sign-in**: cookies, the CSP in `public/_headers`, WebCrypto (PIN),
  local storage all behave exactly as in the browser. Bearer tokens and CORS stay as plan B.
- **Every web release reaches the app instantly** (Deploy once; no app update needed for UI changes).
- Native code is limited to what a web page *cannot* do: read notifications, queue them offline, biometric lock,
  secure token storage, deep links, share/download.

Rejected, with reasons:
- *Full rewrite in Kotlin/Compose, Flutter or React Native:* months of work, two codebases to keep in sync, high bug risk.
- *Only the installed web app (PWA):* cannot read other apps' notifications, which is the whole point of the app.
- *Bundling the web files inside the app:* needs CORS, Bearer sessions and a second release channel; use only if a
  published-app policy forces it (then follow `docs/SETUP.md` → "Wrapping the app in a phone app").

**iPhone** stays the web app plus iOS Shortcuts (instructions already in Settings → Phone connection). No Apple build.

---

## 5. Known traps and their fixes

1. **Google sign-in does not work inside a WebView** (Google rejects embedded browsers, `disallowed_useragent`).
   **This is solved on the server and tested** (`npm run check:auth`); the app only has to follow this exact recipe:
   1. Generate a random `verifier` (at least 43 URL-safe characters) and keep it in memory (or in a bundle that survives
      the Custom Tab round trip). `challenge = base64url(SHA-256(verifier))` without padding (43 characters).
   2. Open `<site>/api/auth/google/start?client=app&challenge=<challenge>` in a **Chrome Custom Tab** (never the WebView).
   3. An intent filter for `wallet://auth` receives either `?code=<one-time code>` or `?status=<pending|closed|disabled|busy|cancelled|error>`.
      Close the Custom Tab and show a clear message for every `status`.
   4. With a `code`, load **in the WebView** `<site>/api/auth/app-open?code=<code>&verifier=<verifier>`. The server checks
      both, sets the normal session cookie in the WebView and redirects to the website, already signed in (a person with
      two-step verification lands on the code screen, which the website already handles). **No token passes through
      JavaScript.** Then discard the verifier.
   - `POST /api/auth/app-exchange` (token instead of cookie) exists for the optional bundled mode only; the recommended
     shell does not use it.
   - The owner's password login works inside the WebView without any of this, so Phases 0–3 do not depend on it.
2. **Notification access is a special permission** the user grants in system settings (Settings → Notifications →
   Device & app notifications). Open it with `Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS`, and detect "not granted"
   (`NotificationManagerCompat.getEnabledListenerPackages`) to show a banner.
3. **Phone makers kill background listeners** (Xiaomi, Huawei, Samsung "sleeping apps"). Ask for battery-optimization
   exemption (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, with an explanation screen), show "last notification
   received" and "last upload" in the app, and provide a "repair" button that re-binds the listener
   (`NotificationListenerService.requestRebind`).
4. **Never lose a transaction.** On every notification: write it to a local queue (Room/SQLite, encrypted) **first**,
   then try to send. Use WorkManager with exponential backoff and a network constraint. Delete from the queue only
   after HTTP 200 with `ok:true`. The server de-duplicates identical text, so resending is safe. Order of sending does
   not matter.
5. **Token handling.** The webhook token comes from the web app (Settings → Phone connection). Hand it to native code
   through a Capacitor plugin call (for example `WalletNative.pair({ token, baseUrl })`), store it only in
   Keystore-backed `EncryptedSharedPreferences`, never log it, never put it in the URL of anything that is logged.
6. **Listen universally, forward only what the user configured.** There is **no hard-coded bank or package name.** The
   user chooses the apps (a searchable list of installed apps from `PackageManager`) and builds triggers (section 6,
   Phase 2). A notification from an app that no enabled trigger selects is dropped immediately in memory: never
   stored, never sent, never logged. Always ignore this app's own notifications, ongoing/foreground-service
   notifications and group summaries (unless a trigger explicitly asks for them). Never log notification text. On
   Android 11+ the app needs `QUERY_ALL_PACKAGES` (or a `<queries>` launcher-intent filter) to list installed apps;
   declare it and explain why in the onboarding text.
6b. **Other banks' messages may not parse.** The server parser (`worker/services/parser.ts`) understands ABB's layout and
   common Azerbaijani/English/Russian wording. A different app can produce a message that lands in the web app's
   Inbox as `failed` (status in the ingest reply). That is a *parsing* task for the web repository (new sample →
   parser/test), not something the Android app should work around; the app's job is to deliver the raw title and
   text faithfully and to include the app's package name in `package` so the server records the sender.
7. **Lifecycle details**: Android 13+ runtime notification permission is for *showing* notifications (not needed for
   listening); the listener is a bound system service, no foreground service required; handle the WebView back button
   (go back in history, then exit); `FLAG_SECURE` on the app window so screenshots/recents hide money; no cleartext
   HTTP; `server.allowNavigation` only for the Worker host; open every other link in a Custom Tab; **no certificate
   pinning** (breaks on certificate rotation); keep `minSdk 26`+.
8. **Do not touch** `worker/`, `shared/`, `migrations/`, cookie flags, the PIN screen's logic or `public/_headers` from the
   mobile repository. If the website needs a change, request it from the owner as a task in the web repository.
9. **PIN storage lives in the WebView.** "Clear app data" removes the PIN (the user sets a new one); updating the app
   does not. Biometric unlock must *gate the display of the WebView*, never replace or read the PIN.
10. **Dates and amounts in notifications** are Baku time and `.`-decimal AZN; do not parse them in the app. Send the
    raw text and let the server parse (it is covered by unit tests).

---

## 6. Phased plan with acceptance tests

Do the phases **in order, one per task**. A phase is done only when every acceptance test passes and the results are
pasted into the task. Tag the repository after each phase (`phase-0`, `phase-1`, …) so any phase can be rolled back.

**Repository:** a new repository (suggested name `wallet-android`), not this one. Keep the Worker URL in a single config
file (`config.json` or a Gradle property), never scattered.

### Phase 0, Scaffold
- Capacitor Android project, `appId` of the owner's choice, `server.url` = Worker URL, `cleartext: false`, icons from
  `public/icon-192.png` / `icon-512.png` (maskable), splash and status-bar colour `#006f7c`, portrait only.
- **Accept:** (1) debug APK installs on an emulator (Android 14) **and** on the owner's phone; (2) the login screen
  appears; owner-password login works; (3) PIN creation (4–6 digits, twice) and unlock after killing the app work;
  (4) with airplane mode on, cold start shows a friendly offline screen with a Retry button, not a blank page or the
  Chrome error; (5) `./gradlew assembleDebug lint` passes.

### Phase 1, Shell hygiene
- Back button behaviour, external links in a Custom Tab, disable pull-to-refresh conflicts, safe-area insets,
  `wallet://` deep-link scheme registered, `FLAG_SECURE`, file downloads (CSV and JSON backup) via DownloadManager or
  the share sheet, no camera/microphone/location permissions.
- **Accept:** on three screen sizes (small phone, large phone, tablet emulator): no content under the status/navigation
  bars, keyboard never hides the amount field of "Add transaction", back button never closes the app from a sub-page,
  exporting CSV produces a file the user can open, rotation is locked.

### Phase 2, Universal notification listener with triggers and actions (replaces MacroDroid)
Split into three shippable steps. Each ends with its own acceptance tests and a git tag (`phase-2a`, `2b`, `2c`).

**2a, Engine: listener, queue, sender (no screens yet).** `NotificationListenerService`; a **rule engine**; an
encrypted queue (Room/SQLite, encrypted); a WorkManager sender (contract in section 3); a Capacitor plugin with `pair`,
`status` (`listenerEnabled`, `queued`, `lastReceivedAt`, `lastUploadedAt`, `lastError`), `openListenerSettings`,
`requestBatteryExemption`. Until 2b exists a single built-in rule "forward everything from package X" configured in a
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

**2b, Screens (native Material 3, opened from a menu item in the web app via the Capacitor bridge).**
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
  test text to `/api/ingest` and shows the server's reply), and a "re-pair" button.

**2c, Optional: SMS trigger.** Banks also send SMS. A second trigger type `sms` (sender number/text conditions) using
`RECEIVE_SMS`; the app is installed from GitHub (not Google Play), so the permission is allowed. Same actions, same queue,
`source:"sms"`. Do it only if the owner asks.

- **Accept, 2a (all required):**
  1. With a rule that forwards package `com.android.shell` (debug build only), post `adb shell cmd notification post -S bigtext -t '💸 Ödəniş: -5.86₼' abbtest 'Ödəniş: 5.86 AZN\nObyekt: TEST CAFE\nKart: *1234\nTarix: 03.11.2026 15:10'` → a transaction appears in the web app within 10 s.
  2. Airplane mode on, post three different notifications, turn the network on → exactly three transactions appear, no duplicates.
  3. Swipe the app away and post one → it arrives. Reboot the phone and post one → it arrives.
  4. Post the same notification twice → one queued item; a repeat that does reach the server answers `duplicate`.
  5. A notification from an app no rule selects → nothing stored, nothing sent, nothing logged.
  6. Revoke the token in the web app → the app shows "needs re-pairing", keeps the queue, re-pairing delivers it.
  7. Notification access turned off → banner with a button that opens the right settings screen.
  8. Rule engine unit tests (pure Kotlin/JVM, no emulator): ordering, `stopAfter`, empty `apps` = any app, every operator,
     case sensitivity, invalid regex, the default template, every variable, and 20+ real-shape samples from section 7.
- **Accept, 2b:** create, edit, disable and delete a macro; the picker finds an app by name and by package; a macro with
  an `ignore` rule placed above a `sendToWallet` rule blocks promos but lets purchases through; editing a macro changes
  behaviour on the next notification without restarting the app; the Test panel shows exactly what would be sent;
  rotating the phone or leaving the screen never loses unsaved edits (or asks before discarding).
- **Accept, 2c (if built):** an SMS from a chosen sender arrives as a transaction; SMS permission denied → clear message.
- **Finally, on the owner's phone:** two **different** real apps (ABB and one other bank or wallet app) each produce one
  real purchase end-to-end.

### How the owner will use it (this is the behaviour the screens in Phase 2b must deliver)

**One-time setup (about two minutes):**
1. Open the app, sign in (password or Google), open **Settings → Phone connection** in the website part. Press
   **Pair this phone**: the website creates a connection token and hands it to the native layer (the user never types or
   copies it). The status screen shows "Paired".
2. Open **Wallet listener** (menu entry that opens the native screens). The status screen walks through three
   green ticks: **Notification access** (button opens Android's settings page; the user switches Wallet on),
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
   leaves the queue. A `401` keeps the queue and shows "needs re-pairing".
5. The **server** parses the text, removes duplicates, matches the card to an account, categorizes the merchant (rules,
   built-in dictionary, then the person's AI), saves the transaction and updates budgets and balances. The web part of the
   app shows it immediately; a message the parser cannot read waits in the website's **Inbox** with the reason.
6. The status screen shows "last received", "last uploaded" and the queue size, so a silently failing setup is visible.

### Phase 3, Biometric lock
- `BiometricPrompt` shown on app start and after N minutes in the background **before** the WebView is shown; the web PIN
  screen remains the fallback and the only thing that unlocks the web app's own PIN gate.
- **Accept:** success, cancel (stays locked, offers retry), too many failures (falls back to the PIN/screen lock), no
  biometrics enrolled (feature quietly off), device without hardware.

### Phase 4, Google sign-in from the app (the server side is ready; follow section 5, trap 1 exactly)
- PKCE verifier/challenge → Custom Tab → `wallet://auth` intent filter → load `/api/auth/app-open` in the WebView.
- **Accept:** a pending user sees the "waiting for approval" message; an approved user ends up signed in inside the
  WebView; a person with two-step verification is asked for the code; a cancelled flow returns to the login screen with a
  message; the one-time link works once and expires in minutes; opening the `wallet://auth?code=…` link from another app
  or with a wrong verifier does **not** sign anyone in; the Custom Tab is closed after returning; killing the app during
  the flow leaves it in a clean state.

### Phase 5, Release
- Signed release APK/AAB built by GitHub Actions in the new repository (keystore in GitHub secrets, **a backup copy of
  the keystore stored by the owner outside GitHub**), R8/ProGuard rules, `versionCode` increments every release,
  GitHub Release with the APK, an update check (the app reads a small `version.json` from the release and shows a
  banner), an install guide (allow installs from the browser, Play Protect screen).
- **Accept:** a release build passes the whole Phase 0–3 acceptance list on a real phone; the update banner appears when
  `version.json` is newer; `./gradlew lint test assembleRelease` passes.

---

## 7. Anti-bug protocol for the coding agent

Copy these rules into the agent's rules:
1. Read this whole document first. Do not use any API, field or behaviour that is not written here; ask instead.
2. One phase per task. Write a short plan, list the files you will touch, then wait for the owner's OK.
3. Never edit outside the phase's scope. Never modify the website's repository.
4. Add no dependency without saying why; prefer AndroidX/Jetpack and the Capacitor core plugins.
5. Everything risky sits behind a build-time flag (`ENABLE_LISTENER`, `ENABLE_BIOMETRIC`) so a bad build can be shipped
   without it.
6. A phase ends with: all acceptance tests run and pasted (with the device, Android version and app version), `./gradlew
   assembleDebug lint` green, a `CHANGELOG.md` entry, a git tag.
7. Test on an emulator **and** on the owner's real phone. Notification features are never "done" on an emulator alone.
8. Never log notification text, tokens, cookies or amounts. Logs go through one helper that redacts.
9. When something fails, find the root cause; never remove a check, widen a permission or disable a security setting
   to make it pass.
10. Report honestly: what was tested, what was not, what could not be verified.

### Test data (real shapes)
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

## 8. Owner checklist and glossary

**Before starting:** the Worker URL (the address shown after Deploy); the web app working end-to-end on the phone;
a phone with USB debugging for testing; a Google account for a signing key (Phase 5); decide the `appId`.
**Keep safe:** the Android signing keystore and its passwords (losing them means users cannot update the app); the
`APP_PASSWORD`; the Cloudflare token.
**For friends who sign in with Google (Phase 4):** the server side is built and tested. In Google Cloud no extra client is
needed: the existing web client is used because the Custom Tab goes through the website's own
`/api/auth/google/callback`.
**Costs:** the app itself is free; Cloudflare free plan; AI is paid by each person to their own provider (Gemini has a
free tier).

**Glossary.** *Worker*: the server program on Cloudflare. *D1*: its SQLite database. *Minor units*: qəpik/cents. *Webhook*:
the address a phone posts to. *Bearer token*: a secret sent in a header instead of a cookie. *Capacitor*: wraps a website
in a native app. *WebView*: the browser view inside an app. *Custom Tab*: Chrome shown inside an app (allowed for Google
sign-in). *Notification listener*: an Android service that may read other apps' notifications once the user allows it.
*WorkManager*: Android's reliable background-job scheduler. *Keystore*: Android's hardware-backed secret storage.
