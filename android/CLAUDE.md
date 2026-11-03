# Rules for working on the Android app (`android/`)

This folder holds the native Android app for the Wallet server in the rest of this repository. Read these first, in order:
1. `docs/NATIVE-APP-PLAN.md` (decisions, milestones, acceptance tests)
2. `docs/MOBILE-HANDOFF.md` (what exists, how the server works, API contract, notification engine spec, test data)
3. `docs/NATIVE-APP-PROMPTS.md` (the prompt for the milestone you were given)

## Hard rules
- **One milestone per session.** Start with a short plan (files, risks, how you will test) and wait for the owner's OK before writing code.
- **Never invent an endpoint, field or behaviour.** Read `worker/routes/*.ts`, `shared/types.ts` and the real captured responses in `android/contract/*.json`. If the server lacks something, say so and propose a server change; do not work around it in the app.
- **Server changes** (only those described in the plan, milestone M0, or explicitly approved) get a script check under `scripts/` and must keep `npm run typecheck`, `npm test`, `npm run build`, `npm run check:isolation`, `npm run check:auth`, `npm run check:ai`, `npm run check:fx` green.
- **Money is an integer in minor units** (qəpik/cents), never a float. Dates and "budget months" follow `shared/money.ts`; the Kotlin versions must reproduce `android/vectors/*.json` exactly.
- **Credentials:** the *session token* (full access) lives in encrypted storage and is reachable only after the PIN lock; the *ingest token* (post-only) is separate so notifications keep flowing while the phone is locked. Never put either in a URL, a log, a crash report or a screenshot.
- **Never log notification text, tokens, cookies or amounts.** Use one redacting log helper. Set `FLAG_SECURE` on screens that show money.
- **PIN lock is mandatory behaviour** (4-6 digits, per device, wrong-try limit) ported from `src/lib/pin.ts` and `src/components/PinGate.tsx`. **Fingerprint is an optional switch** in Settings that can only unlock the lock screen; the PIN always works and is never replaced or revealed.
- **Notifications are default-deny:** a notification that no enabled macro selects is dropped in memory (never stored, sent or logged). Queue first, send second, delete from the queue only after HTTP 200 with `ok:true` (see `docs/MOBILE-HANDOFF.md` §3 and §4).
- No cleartext HTTP and no certificate pinning in release builds. No new dependency without a stated reason. Risky features sit behind build flags.
- When something fails, find the root cause. Never remove a check, widen a permission or relax a security setting to get green.

## Definition of done (every milestone)
1. `cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug` is green.
2. Every acceptance item of the milestone in `docs/NATIVE-APP-PLAN.md` was run and its result written down (device, Android version, app version). Listener and fingerprint items are verified on the owner's real phone: an emulator alone never counts.
3. A line in `android/CHANGELOG.md`, a commit on branch `android-native`, and a git tag `android-m<N>`.
4. Report plainly what was tested, what was not, and what could not be verified.

## Layout (created in milestone M1)
`:core` (pure Kotlin, no Android classes: models, money/period/range logic, rule engine) and `:app` (Compose UI, ViewModels, data layer, listener service, workers). Config values (worker URL) come from Gradle properties; debug builds talk to `http://10.0.2.2:8787`, release builds to the https Worker URL.
