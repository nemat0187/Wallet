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
A private expense and budget tracker for one person, later opened to friends. A bank (ABB) shows every card
operation as a notification on the phone. The phone forwards that notification to the app's server, which reads it,
files it under a category and updates budgets, charts and AI advice. On Android the forwarder was the free app
MacroDroid; **the mobile app replaces MacroDroid** and wraps the web app.

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
| `GET /api/auth/google/start` | Browser redirect flow for Google. **Not usable inside a WebView** (see trap 1) |
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

1. **Google sign-in does not work inside a WebView.** Google rejects embedded browsers (`disallowed_useragent`).
   - Owner (password) login works in the WebView, so Phases 0–3 are unaffected.
   - Friends who use Google need a **Chrome Custom Tab plus a one-time-code hand-off**. That needs a small, tested
     *backend* addition that does not exist yet: `GET /api/auth/google/start?client=app` → after Google, redirect to
     `wallet://auth?code=<one-time code>` → `POST /api/auth/app-exchange {code}` returns a session token. **Phase 4 is
     blocked until the backend part exists; ask the owner to have it built in the web repository first. Do not
     emulate it in the app.**
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
6. **Forward only the bank.** An allow-list of Android package names (default: the ABB app). The package id must be
   **confirmed on a real phone** by logging `sbn.packageName` once during development (do not guess it). Ignore
   ongoing/group-summary notifications, notifications from this app itself, and anything not on the list. Never log
   notification text.
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

### Phase 2, Notification listener (replaces MacroDroid)
- `NotificationListenerService`, package allow-list, encrypted queue, WorkManager sender (contract in section 3),
  Capacitor plugin with `pair`, `status` (`listenerEnabled`, `queued`, `lastReceivedAt`, `lastUploadedAt`, `lastError`),
  `openListenerSettings`, `requestBatteryExemption`; a native onboarding screen (what, why, three steps with deep
  links, a "Test" button that sends a sample) shown until everything is green; the web Settings page keeps working.
- **Accept (all required):**
  1. Post a fake ABB-style notification with `adb shell cmd notification post -S bigtext -t '💸 Ödəniş: -5.86₼' abbtest 'Ödəniş: 5.86 AZN\nObyekt: TEST CAFE\nKart: *1234\nTarix: 03.11.2026 15:10'` (the posting package is the shell; add it temporarily to the allow-list in a debug build only) → a transaction appears in the web app within 10 s.
  2. Airplane mode on, post three different notifications, turn the network on → exactly three transactions appear, no duplicates.
  3. Kill the app (swipe away) and post one → it arrives. Reboot the phone and post one → it arrives.
  4. Post the same notification twice → one transaction (second answer is `duplicate`, queue empties).
  5. A one-time-password notification and a notification from a non-allowed package → nothing is stored, nothing is sent.
  6. Revoke the token in the web app → the app shows "needs re-pairing", keeps the queue, re-pairing delivers it.
  7. Notification access turned off → banner with a button that opens the right settings screen.
  8. Real device, real ABB notification, one real purchase end-to-end.

### Phase 3, Biometric lock
- `BiometricPrompt` shown on app start and after N minutes in the background **before** the WebView is shown; the web PIN
  screen remains the fallback and the only thing that unlocks the web app's own PIN gate.
- **Accept:** success, cancel (stays locked, offers retry), too many failures (falls back to the PIN/screen lock), no
  biometrics enrolled (feature quietly off), device without hardware.

### Phase 4, Google sign-in from the app (blocked until the backend piece exists, section 5 trap 1)
- Custom Tab → Google → `wallet://auth?code=…` → exchange → session token → load the site signed in.
- **Accept:** a pending user sees the "waiting for approval" message; an approved user signs in; a cancelled flow returns
  to the login screen; the one-time code works once and expires in minutes.

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
**For friends who sign in with Google (Phase 4):** build the backend hand-off in the web repository first (section 5).
**Costs:** the app itself is free; Cloudflare free plan; AI is paid by each person to their own provider (Gemini has a
free tier).

**Glossary.** *Worker*: the server program on Cloudflare. *D1*: its SQLite database. *Minor units*: qəpik/cents. *Webhook*:
the address a phone posts to. *Bearer token*: a secret sent in a header instead of a cookie. *Capacitor*: wraps a website
in a native app. *WebView*: the browser view inside an app. *Custom Tab*: Chrome shown inside an app (allowed for Google
sign-in). *Notification listener*: an Android service that may read other apps' notifications once the user allows it.
*WorkManager*: Android's reliable background-job scheduler. *Keystore*: Android's hardware-backed secret storage.
