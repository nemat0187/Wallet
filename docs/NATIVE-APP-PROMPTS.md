# Prompts for Claude Code (native Android app)

Open Claude Code in the repository root, on branch `android-native` (`git switch -c android-native` the first time).
Claude Code reads `android/CLAUDE.md` automatically when it works in `android/`. Use **plan mode** (Shift+Tab) for the first
message of every milestone, approve the plan, then let it build. One milestone per session; finish (green, committed, tagged)
before starting the next. If a session ends early, start a new one with: *"Continue milestone M<N> from `docs/NATIVE-APP-PLAN.md`;
check `git log` and `android/CHANGELOG.md` for what is already done."*

---

## Any milestone: opening line
Read `docs/NATIVE-APP-PLAN.md`, `docs/MOBILE-HANDOFF.md` and `android/CLAUDE.md`. Then do milestone **M<N>** below. Start with a
plan (files, risks, tests) and wait for my OK. Follow the definition of done in `android/CLAUDE.md`.

## M0, Server realtime and fixtures (web part of the repo)
Do **M0** ("Server work" in `docs/NATIVE-APP-PLAN.md`): the `UserHub` Durable Object and `GET /api/realtime`, `notifyChanged`
called from the API middleware, ingest, Telegram quick-add and cron, the website subscriber in `src/lib/realtime.ts`, the UA name,
`npm run export:contract` and `npm run export:vectors`, and `npm run check:realtime`. Check that `scripts/deploy.mjs` carries the
Durable Object binding and migration into `wrangler.generated.jsonc`. Keep every existing check green. Tell me exactly what I must
verify in the Cloudflare dashboard after deploying (Durable Objects on the Free plan must be SQLite-backed).

## M1, Foundation
Do **M1**: create `android/` (Gradle, Kotlin, Compose, Material 3, minSdk 26) with modules `:core` and `:app`, app id
`com.nematrahimli.wallet`, Gradle-property config for the Worker URL (debug `http://10.0.2.2:8787`, release
`https://wallet.nematrahimli.workers.dev`), theme tokens ported from `src/styles.css` (the seven themes, Onest font, ₼ formatting),
navigation shell with the bottom bar (Home, Activity, +, Budgets, More), `ApiClient`, JSON models for what M2 to M4 need, and the
`.github/workflows/android.yml` CI job. Wire the Kotlin tests to `android/vectors/*.json` and `android/contract/*.json`; every
money/period/range vector must match exactly.

## M2, Sign-in, PIN lock, optional fingerprint
Do **M2**: owner-password login and two-step (`mfa_token`), Google sign-in via a Chrome Custom Tab with PKCE and
`POST /api/auth/app-exchange` (recipe in `docs/MOBILE-HANDOFF.md` §3), session token in encrypted storage, the PIN lock with the
same rules as the website (read `src/lib/pin.ts` and `src/components/PinGate.tsx`; PIN vectors must match), an optional
fingerprint switch in Settings (BiometricPrompt, PIN always available as fallback, switch turns itself off if fingerprints change),
re-lock timeout, logout, 401 handling, and automatic creation of the post-only ingest token. Report every acceptance item from the
plan; I will test the fingerprint and the `wallet://` redirect on my phone.

## M3, Notification engine and macros (the main feature)
Do **M3** in three steps with a commit after each. **4a:** the rule engine as plain Kotlin in `:core` with its unit tests first
(model and evaluation rules exactly as in `docs/MOBILE-HANDOFF.md` §4), then the queue, the WorkManager sender and the
`NotificationListenerService`. **4b:** the screens (macro list, three-block editor, searchable app picker with "recently notified",
test panel, status and onboarding, macro export/import as a JSON file). **4c** only if I ask. Test with the `adb` commands in the
acceptance list; I will do the real-phone tests with two different apps.

## M4, Realtime, Home, Activity, Add
Do **M4**: `RealtimeClient` (OkHttp WebSocket, foreground only, reconnect with backoff, compare `v` on reconnect), read-through
cache with an offline banner, Home, Activity (list, search, filters, detail, edit, delete, bulk select, transfer pairs) and Add
transaction with the currency picker and live ≈ AZN preview. Acceptance: a change on the website shows on the phone within about two
seconds and the other way round; a forwarded notification shows on both.

## M5, Money setup
Do **M5**: monthly budgets (overall and per category) and date-range budgets with editing, savings goals, cards and accounts
(balances, ≈ AZN, include in total, merge), the exchange-rates card, multi-currency behaviour.

## M6, Organise
Do **M6**: categories, merchants and rules (rule editor with conditions, actions and preview), the bank-messages Inbox
(reprocess, ignore, delete), statement import (system file picker, PDF or CSV, existing `/api/import`), notes.

## M7, Insights
Do **M7**: analytics (categories, merchants, trends, heatmap, recurring, anomalies), AI insights and Ask-AI chat, AI keys, models
and limits, then dashboards and the widget builder on `/api/analytics/query` with Canvas charts (bar, column, line, area, donut,
table, heatmap). Do the widget builder last and keep it simple but complete.

## M8, People and settings completeness
Do **M8**: admin screens (approve, reject, disable, enable, role, registration switch), Telegram connection, signed-in devices,
two-step management and recovery codes, appearance and themes, data export, backup and reset (typed confirmation kept), the
Home "Customize" option, and the in-app "update available" banner.

## M9, Release
Do **M9**: signed release APK built by `android.yml` on tags `android-v*` (keystore in GitHub secrets; tell me how to back the
keystore up before you create it), R8/ProGuard rules, `versionCode` policy, a GitHub Release with the APK, and a short install guide
for friends (unknown sources, Play Protect). Remind me that friends can only download from a public repository; otherwise I send
the APK file directly. The release build must pass the whole acceptance list for M2 to M4 on my phone.

---

## If something goes wrong
Ask: *"Stop. Tell me the exact error, which acceptance item it relates to, what changed since the last green state, and revert to
the last tag if you cannot explain it."* Server problems are fixed in the server code of this repository, never worked around in
the app.
