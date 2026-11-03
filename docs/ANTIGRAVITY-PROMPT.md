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
secure storage). It replaces the MacroDroid app: like MacroDroid it listens to **any app the user chooses** and lets the
user build triggers, constraints and actions. Nothing about a specific bank is hard-coded.

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

## Phase 2a prompt: Listener engine (no screens)
Do **Phase 2a** (section 6) and the traps in section 5 (items 2 to 6b). Start with the rule engine as plain Kotlin with
no Android classes and its unit tests (data model and evaluation rules exactly as written in section 6), then the encrypted
queue and the sender, then the `NotificationListenerService`. Test with the `adb` commands in the acceptance list. All
eight acceptance tests must be reported individually. There is no bank package name to find: the user chooses apps.

## Phase 2b prompt: Macro screens
Do **Phase 2b** (section 6): macros list, three-block editor (Trigger, Constraints, Actions), searchable app picker with
"recently notified apps", test panel (notification text only in memory), status/onboarding screen. Follow MacroDroid's
mental model; keep screens simple. Report each acceptance item, and give me a manual script for my phone.

## Phase 2c prompt: SMS trigger (only if I ask for it)
Do **Phase 2c** only if I say so. Otherwise answer "not requested" and stop.

## Phase 3 prompt: Biometric lock
Do **Phase 3** (section 6). Biometrics only decide whether the web view is shown; the web PIN is untouched.

## Phase 4 prompt: Google sign-in
Do **Phase 4** (section 6) following section 5, trap 1 step by step: PKCE, Custom Tab, `wallet://auth` intent filter,
then load `/api/auth/app-open?code=…&verifier=…` in the WebView. The server side already exists and is tested; do not
change or re-implement it, and never open Google inside the WebView.

## Phase 5 prompt: Release
Do **Phase 5** (section 6). Explain how I should back up the signing keystore before you create it. The release build
must pass the whole Phase 0 to 3 acceptance list on my phone.

---

## If something goes wrong
- Ask the agent: "Stop. Tell me the exact error, which acceptance test it relates to, what you changed since the last
  green state, and revert to the last git tag if you cannot explain it."
- Never let it "fix" the website from the app repository. Bring website problems back to the Wallet repository.
