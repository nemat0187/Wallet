# Prompts for Antigravity (Android app for Wallet)

How to use: create a **new, empty repository** (suggested name `wallet-android`). Put a copy of
`docs/MOBILE-HANDOFF.md` from the Wallet repository into it (as `docs/MOBILE-HANDOFF.md`) and paste the **Master
prompt** below as the agent's standing instructions. Then give it **one phase prompt at a time**. Do not start the next
phase until the current one's acceptance tests are pasted and you have tried the app on your phone.

---

## Master prompt (standing instructions, paste once)

You are building the Android app for "Wallet", a private expense tracker. The web app and server already exist and work;
they live in another repository and **must not be changed or re-implemented**. The app is a Capacitor Android shell that
loads the deployed website, plus a small native layer (notification listener with an offline queue, biometric lock,
secure storage). It replaces the MacroDroid app that used to forward bank notifications.

Rules, in priority order:
1. Read `docs/MOBILE-HANDOFF.md` completely before doing anything. It is the single source of truth for the API
   contract (section 3), the architecture (4), the traps (5), the phases and acceptance tests (6) and your protocol (7).
2. Never invent an endpoint, field, package name or behaviour. If it is not in the document, stop and ask me.
3. Work on exactly one phase per task. Start every task with a short plan: files you will create or change, risks, and
   how you will test. Wait for my OK before writing code.
4. Do not modify the Wallet web/server repository, its cookies, its PIN logic or its security headers. The native code
   may call only `POST /api/ingest` (and the sign-in calls in the optional bundled mode).
5. A transaction must never be lost: queue first (encrypted), send second, delete only after HTTP 200 with `ok:true`.
   Resending is safe because the server de-duplicates.
6. Never log or display tokens, cookies, notification text or amounts. Use one redacting log helper.
7. Dependencies: Capacitor core plus AndroidX/Jetpack only. Justify anything else before adding it.
8. Risky features sit behind build flags (`ENABLE_LISTENER`, `ENABLE_BIOMETRIC`).
9. A phase is finished only when: every acceptance test of that phase has been run and its result pasted (device, Android
   version, app version), `./gradlew assembleDebug lint` passes, `CHANGELOG.md` is updated, and a git tag `phase-N` exists.
10. Notification features are verified on my real phone, not only on an emulator. If you cannot verify something, say so
    plainly instead of claiming it works.
11. When something fails, fix the root cause. Never remove a check, widen a permission, or relax a security setting to
    make a test pass.
12. Keep the Worker URL in one config file. Do not hard-code it elsewhere.

---

## Phase 0 prompt: Scaffold
Do **Phase 0** of `docs/MOBILE-HANDOFF.md` section 6. Worker URL: `<paste my Wallet address here>`. App id:
`<paste, for example az.nemat.wallet>`. First give me your plan. Acceptance tests are exactly the five listed for
Phase 0; paste each result.

## Phase 1 prompt: Shell hygiene
Do **Phase 1** (section 6). Test on the three screen sizes listed. Include a short manual test script I can follow on my
phone for back button, export download and keyboard behaviour.

## Phase 2 prompt: Notification listener
Do **Phase 2** (section 6) and the traps in section 5 (items 2 to 6). Before coding, tell me exactly how you will find
the bank app's package name on my phone (logging `sbn.packageName` once in a debug build); I will confirm it. Build the
queue and sender first and test them with the `adb` commands in the acceptance list; then the onboarding screen. All
eight acceptance tests must be reported individually; test 8 is done by me on my phone with one real purchase.

## Phase 3 prompt: Biometric lock
Do **Phase 3** (section 6). Biometrics only decide whether the web view is shown; the web PIN is untouched.

## Phase 4 prompt: Google sign-in (only after the backend piece exists)
Do **Phase 4** only if I tell you the server now offers `GET /api/auth/google/start?client=app`, redirect to
`wallet://auth?code=…`, and `POST /api/auth/app-exchange`. If I have not said so, answer "blocked" and stop.

## Phase 5 prompt: Release
Do **Phase 5** (section 6). Explain how I should back up the signing keystore before you create it. The release build
must pass the whole Phase 0 to 3 acceptance list on my phone.

---

## If something goes wrong
- Ask the agent: "Stop. Tell me the exact error, which acceptance test it relates to, what you changed since the last
  green state, and revert to the last git tag if you cannot explain it."
- Never let it "fix" the website from the app repository. Bring website problems back to the Wallet repository.
