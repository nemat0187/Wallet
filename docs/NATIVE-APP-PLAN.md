# Native Android app: plan

**What this is.** A fully native Android app (Kotlin, Jetpack Compose; not a web wrapper) for the Wallet server in this
repository. It has the same PIN lock as the website with an **optional fingerprint unlock**, **trigger / action rules built
inside the app that read notifications directly (no MacroDroid)**, **real-time sync with the website**, and **everything the
website does except what a phone app makes unnecessary**. It is built step by step with Claude Code, in `android/` of this
repository, on branch `android-native`.

**How to use these documents.** Read this file, then `docs/MOBILE-HANDOFF.md` (what exists, how it works, API contract,
notification engine specification). Work one milestone at a time with the prompts in `docs/NATIVE-APP-PROMPTS.md`. The
standing rules for Claude Code are in `android/CLAUDE.md`.

**Environment (owner's computer).** Android Studio (or the command-line SDK) with JDK 17, an emulator (Android 14) and the
owner's phone with USB debugging; Node 22 for the server checks (`npm ci`; `npm run dev:api` serves the API on `:8787`,
reachable from the emulator at `http://10.0.2.2:8787`). Worker URL: `https://wallet.nematrahimli.workers.dev`.

## Decisions (made so the next sessions do not have to re-decide)
- **Stack:** Kotlin + Jetpack Compose + Material 3, minSdk 26, current targetSdk; OkHttp (REST + WebSocket) + kotlinx.serialization; Room (notification queue); WorkManager; DataStore (rules, settings); `androidx.biometric`; Keystore/EncryptedSharedPreferences. Manual dependency injection (no Hilt/KSP complexity). Pure-Kotlin `core` module (rule engine, money/date logic, models) unit-tested on the JVM.
- **Where:** the **same repository**, folder `android/`, branch `android-native`. Claude Code then sees the server code and can change server and app together, so the server contract can never be guessed. CI gets a separate workflow `android.yml`. App id `com.nematrahimli.wallet`; Worker URL `https://wallet.nematrahimli.workers.dev` (debug build uses `http://10.0.2.2:8787` against `npm run dev:api`; both come from Gradle properties, never hard-coded).
- **Not an online-only thin client for notifications:** the listener works with the app closed; everything else is online with a read-through cache (last data shown with an "offline" banner); writes need a connection except forwarded notifications, which are queued.
- **Two credentials, least privilege:** (1) *session token* (full access) obtained by sign-in, stored in Keystore-backed EncryptedSharedPreferences, used by the screens and only reachable after the app lock is passed; (2) *ingest token* (can only post messages) created automatically by the app through `POST /api/messages/tokens` after first sign-in, stored in EncryptedSharedPreferences **not** behind the app lock, used only by the background sender so notifications flow while the phone is locked. If the ingest token is revoked (401) the app recreates it the next time it is unlocked. No manual pairing, no key typing.
- **PIN lock stays, fingerprint is an optional extra.** The native app has the same per-device PIN as the web app: 4-6 digits, entered twice on first use, kept only on the device as a salted PBKDF2 hash, wrong-try limit and the same lockout behaviour, with the exact rules ported from `src/lib/pin.ts` and `src/components/PinGate.tsx` (read both; test with vectors). **Fingerprint unlock is a switch in Settings (off by default):** when on, the lock screen offers `BiometricPrompt` (BIOMETRIC_STRONG) first and the PIN is always available as the fallback; turning it on asks for the PIN and a fingerprint confirmation; if the phone's fingerprints change or biometrics are removed, the switch turns itself off and the PIN keeps working. Biometrics only decide whether the lock screen opens; they never replace or reveal the PIN. First sign-in = Google (Custom Tab + PKCE, server side already built: `start?client=app`, `wallet://auth`, `POST /api/auth/app-exchange`) or owner password (+ two-step code via `mfa_token`). Re-lock after N minutes in background (setting).
- **Real-time sync:** see "Server work". The mobile app and the website both listen; any change by either, by a forwarded notification, by Telegram or by cron shows on the other within about a second.
- **Feature scope = full parity minus what mobile makes unnecessary.** Not rebuilt: *Phone connection page (MacroDroid steps, connection keys, iPhone Shortcuts text)*, *"add to home screen"/PWA hints*. Everything else is rebuilt natively (map below). Native screens may be simpler than the web ones where the web screen is a power-user tool (stated per item).

## Server work (in the web part of this repo; do first, small, with tests)
1. **`UserHub` Durable Object** (WebSocket hibernation API), one instance per user. `wrangler.jsonc` gets the binding and a `new_sqlite_classes` migration; check `scripts/deploy.mjs` passes it into `wrangler.generated.jsonc`. Endpoint `GET /api/realtime` (Upgrade: websocket): authenticates exactly like the API (cookie with `Origin` equal to the site, or `Authorization: Bearer`), then forwards to that user's hub. Messages: server→client `{"t":"hello","v":N}` on connect and `{"t":"changed","v":N,"scope":["transactions","accounts",...]}`; client→server `{"t":"ping"}` (answered `pong`). `v` is a per-user counter kept in the hub.
2. **Emit changes:** one helper `notifyChanged(env, userId, scope)` called (a) by the main `/api/*` middleware after every successful non-GET request (scope derived from the path prefix), (b) by `/api/ingest` and `afterTransactions`, (c) by the Telegram quick-add and the cron jobs that write data (categorization, rates, reports). Failures never break the request (fire-and-forget via `waitUntil`).
3. **Website subscribes:** `src/lib/realtime.ts` opens the socket after sign-in, reconnects with backoff, and on `changed` invalidates the matching TanStack queries (the existing focus-refetch stays as the safety net).
4. **UA name:** `worker/lib/ua.ts` recognises `WalletAndroid/<ver> (...)` so the device list shows "Wallet Android app".
5. **Contract fixtures for the app (anti-drift):** `npm run export:contract` runs a script against the local dev server with demo data and writes real JSON responses of every endpoint the app uses to `android/contract/*.json`; `npm run export:vectors` writes golden test vectors produced by the TypeScript implementations (`shared/money.ts`: `parseAmount`, `formatMoney`, `periodFor`, `shiftPeriod`; `shared/widgets.ts`: `resolveRange`; `shared/goals.ts`; the parser samples) to `android/vectors/*.json`. The Kotlin unit tests parse the fixtures and must reproduce every vector exactly.
6. **Tests:** `scripts/realtime-check.mjs` (`npm run check:realtime`): two sockets for user A and one for user B; A's mutation reaches A's sockets only; ingest triggers a change; bad token and cross-origin cookie are refused; reconnect gets `hello` with the latest `v`. Existing checks stay green. Note for the owner: Durable Objects on the Workers Free plan must be SQLite-backed (the migration uses that); verify after deploy in the Cloudflare dashboard.

## Native app architecture
`android/` Gradle project: `:core` (pure Kotlin: models, money/period/range logic, rule engine, parsers of API JSON, no Android classes), `:app` (Compose UI, ViewModels, data layer, listener service, workers). Layers: `ApiClient` (OkHttp, Bearer, `x-client: app`, `User-Agent: WalletAndroid/<ver> (Android <os>; <model>)`, 401 → re-auth flow), `Repository` per area (read-through cache in DataStore/Room), `RealtimeClient` (OkHttp WebSocket; foreground only; on `changed` refetch the visible screens; on reconnect compare `v`), ViewModels with `StateFlow`, Compose screens. Theme: port the web design tokens (colors, radii, the seven themes, Onest font, ₼ formatting) so it looks like the owner's screenshots. Charts (bar, column, line, area, donut, table, heatmap) are small custom Canvas composables.

## Notification engine (the core of the app; build early)
- `NotificationListenerService` (works with the app closed) → rule engine (pure Kotlin) → Room queue → WorkManager sender → `POST /api/ingest` with the ingest token. Contract and reply handling are in `docs/MOBILE-HANDOFF.md` §3 (parsed/duplicate/ignored/failed; delete from queue only on HTTP 200 with `ok:true`; 401 keeps the queue).
- Macro model, evaluation order, default-deny, templates and variables: `docs/MOBILE-HANDOFF.md` §4 is the specification (Rule{trigger apps, constraints AND, actions: sendToWallet / ignore / optional httpRequest, stopAfter}); keep it, with these additions: rules stored as versioned JSON in DataStore, **export/import of macros as a JSON file** (new phone), and a **test panel** (last 20 notifications in memory only, shows which macros fire and the exact body).
- Screens: macro list, three-block editor (Trigger → Constraints → Actions), searchable installed-apps picker with "recently notified", status/onboarding (notification access, battery exemption, last received/uploaded, queue size, "Send test message"), optional SMS trigger as a later add-on (`RECEIVE_SMS`, sideloaded APK).
- Traps handled (from §5 of the reference): OEM battery killers (rebind + repair button), `QUERY_ALL_PACKAGES` for the picker, never log notification text/tokens, ignore own/ongoing/group-summary notifications, no cleartext in release, no certificate pinning, `FLAG_SECURE` on money screens.

## Feature parity map (web → native)
| Web area | Native | Notes |
|---|---|---|
| Sign-in (password, Google, two-step, recovery codes) | yes | Custom Tab + PKCE, `app-exchange`, `mfa_token` |
| PIN gate | yes, same behaviour | per-device PIN, plus an optional fingerprint switch |
| Home (hero, chart, where it went, latest, cards, budgets, coach teaser, top places) | yes | fixed layout; "Customize" (move/hide blocks) later |
| Activity list, filters/search, transaction detail, edit (category, amount, date/time, note, tags, direction, exclude), delete, bulk actions, transfer pairs | yes | bulk = multi-select |
| Add transaction (currency picker, live ≈ AZN) | yes | |
| Budgets: monthly (overall + category), date-range budgets | yes | edit limits natively |
| Savings goals | yes | |
| Cards & accounts (balances, ≈ AZN, include in total, merge) | yes | |
| Categories, merchants & rules (conditions, actions, preview) | yes | rule editor is a simplified but complete form |
| Bank messages Inbox (failed/ignored, reprocess, ignore, delete) | yes | |
| Import statement (PDF/CSV) | yes | system file picker → existing `/api/import` |
| Analytics (categories, merchants, trends, heatmap, recurring, anomalies) | yes | |
| Dashboards + widget builder | yes, last | uses `/api/analytics/query`; native editor for the same widget model |
| Notes | yes | |
| AI insights, Ask-AI chat, AI keys/models/limits | yes | |
| Admin: approve/reject/disable users, registration switch | yes | admin only |
| Settings: account, devices, two-step, Telegram, budget month, exchange rates, appearance, data export/backup/reset | yes | `reset` keeps its typed confirmation |
| Phone connection (MacroDroid/keys/Shortcuts) | **no** | replaced by listener + macros |
| PWA install hints | **no** | |

## Milestones (one per Claude Code session or two; each ends green, committed, tagged)
- **M0 Server realtime + fixtures** (above). *Accept:* `check:realtime`, `check:isolation`, `check:auth`, vitest, build all green; the website updates live when a second browser changes data.
- **M1 Foundation:** Gradle project, `:core`, theme, navigation shell, `ApiClient`, config via Gradle properties, CI workflow, contract/vector tests wired. *Accept:* `./gradlew testDebugUnitTest lintDebug assembleDebug` green; money/period/range vectors all match.
- **M2 Auth + PIN lock + optional fingerprint:** password + two-step, Google via Custom Tab/PKCE, session token in encrypted storage, PIN setup/unlock identical to the web rules, optional `BiometricPrompt` switch, re-lock timeout, logout, 401 handling, auto-created ingest token. *Accept:* PIN vectors match the web implementation; wrong-try limit; fingerprint on/off, cancel falls back to PIN, no biometrics enrolled (switch unavailable), fingerprints changed (switch turns off, PIN works); notifications still upload while the app is locked; another app catching `wallet://` cannot sign in (verifier).
- **M3 Notification engine + macros UI** (the differentiator, so before the rest). *Accept:* the eight engine tests, the macro-screen tests and the two-real-apps test from reference §4; airplane-mode, reboot, duplicate, revoked-token, access-off banner; engine unit tests (ordering, `stopAfter`, empty apps, every operator, invalid regex, templates, 20+ real-shape samples).
- **M4 Realtime + Home + Activity + Add:** `RealtimeClient`, Home, Activity with edit/delete/add. *Accept:* add on web → appears on phone ≤ 2 s and vice versa; a forwarded notification appears on both; airplane toggle reconnects and catches up; offline shows cached data with a banner.
- **M5 Money setup:** Budgets (monthly + range), Goals, Cards & accounts, exchange rates card, multi-currency.
- **M6 Organise:** Categories, Merchants & rules (with preview), Inbox, Import, Notes.
- **M7 Insights:** Analytics, AI insights + chat + AI keys, dashboards and widget builder (Canvas charts).
- **M8 People + settings completeness:** Admin screens, Telegram, devices, two-step management, data export/backup/reset, appearance/themes, macro export/import, app update banner.
- **M9 Release:** signed APK via `android.yml` on tag `android-v*` (keystore in GitHub secrets; owner keeps an offline backup), R8/ProGuard rules, `versionCode` policy, GitHub Release, in-app "update available" banner (reads the latest release), install guide for friends (unknown sources, Play Protect). Friends can download only from a **public** repo or a separately public releases repo; otherwise send the APK file directly.
Honest size: this is a large build (weeks of part-time work). M0-M4 give a daily-usable app (notifications, Home, Activity, PIN lock with optional fingerprint, real-time); M5-M8 reach parity.

## Anti-bug protocol (in `android/CLAUDE.md`)
Read `docs/NATIVE-APP-PLAN.md` and the `docs/MOBILE-HANDOFF.md` §2/§3 first; one milestone per session; plan before code; never invent endpoints (read `worker/routes/*.ts` and `android/contract/*.json`); server changes only as described, each with a script check; every milestone ends with `./gradlew testDebugUnitTest lintDebug assembleDebug`, the milestone's acceptance list, a `CHANGELOG.md` line and a git tag; real-phone verification for listener and fingerprint (emulator alone never counts); money only as integers in minor units; never log notification text, tokens or amounts; no new dependency without a reason; risky features behind build flags; when something fails fix the root cause, never relax security or remove a check; report what was and was not verified.
