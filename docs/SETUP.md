# Setting up your Wallet (no coding needed)

This guide takes about **20–30 minutes** the first time. You only click buttons and copy‑paste a few values.
Everything runs for free on Cloudflare; the only optional cost is the AI (usually well under $1 a month).

**What you'll end up with:** a private web app at an address like `https://wallet.yourname.workers.dev`
that only you can open, which records every ABB card payment automatically from the SMS/notifications
your phone already receives.

```
ABB sends SMS ──► your phone forwards it ──► your Wallet app (Cloudflare) ──► AI categorizes, budgets, reports
                  (Shortcuts / MacroDroid)        stores data in your own database
```

You'll need:

- This GitHub repository (you have it).
- A free **Cloudflare** account (we create it in step 1).
- Optional: an **Anthropic** account for the AI features (step 6).
- Optional: **Telegram** for instant notifications (step 8).

---

## Step 1 — Create a free Cloudflare account

1. Go to **https://dash.cloudflare.com/sign-up** and sign up with your email. Verify the email.
2. In the left menu open **Compute (Workers) → Workers & Pages** (on some accounts it's just **Workers & Pages**).
   The first time, Cloudflare asks you to choose a **subdomain** (for example `nemat`). Pick something you like —
   your app will live at `https://wallet.<subdomain>.workers.dev`.
   You don't need to create anything else here.

## Step 2 — Get two values from Cloudflare

**a) Account ID**

- On the **Workers & Pages** page (or the account home page) look on the right side for **Account ID**
  and click **Copy**. Paste it somewhere temporarily (e.g. Notes).

**b) API token** (lets GitHub deploy the app to your account)

1. Click your profile icon (top right) → **My Profile** → **API Tokens** → **Create Token**.
2. Next to **Edit Cloudflare Workers**, click **Use template**.
3. Under **Permissions** click **+ Add more** and add: **Account** → **D1** → **Edit**.
4. Under **Account Resources** choose your account. Under **Zone Resources** you can leave **All zones**.
5. Click **Continue to summary** → **Create Token** → **Copy** the token and keep it with the Account ID.
   (Cloudflare shows it only once. If you lose it, just create a new one.)

## Step 3 — Save your secrets in GitHub

In this repository on GitHub: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
Create these, one by one (name exactly as written, value = what you copied):

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 2b |
| `CLOUDFLARE_ACCOUNT_ID` | the Account ID from step 2a |
| `APP_PASSWORD` | **the password you'll use to log in to your Wallet.** Make it long (at least 12 characters), e.g. a short sentence. |

Optional (you can add these later, then redeploy):

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | enables AI — see step 6 |
| `TELEGRAM_BOT_TOKEN` | enables Telegram notifications — see step 8 |

> Secrets are encrypted by GitHub and passed straight to Cloudflare. Nobody — including people who can see
> the code — can read them.

## Step 4 — Deploy (publish) the app

1. Open the **Actions** tab of this repository. If GitHub asks, click **I understand my workflows, go ahead and enable them**.
2. Click **Deploy** in the left list → **Run workflow** → **Run workflow** (green button).
3. Wait 2–3 minutes until the run shows a green check ✅. Click the run: the summary shows
   **“Wallet is live”** with your address, e.g. `https://wallet.nemat.workers.dev`.

If it fails ❌, open the failed step and read the last lines — the most common causes are listed in
[Troubleshooting](#troubleshooting).

## Step 5 — Open it on your phone

1. Open your address on your phone and log in with your `APP_PASSWORD`.
2. Add it to your home screen so it opens like a normal app:
   - **iPhone (Safari):** Share button → **Add to Home Screen**.
   - **Android (Chrome):** ⋮ menu → **Add to Home screen** / **Install app**.
3. Recommended: **Settings → Security → Set up two‑step login** (adds a 6‑digit code from an authenticator app).

## Step 6 — Turn on AI (optional, recommended)

AI categorizes merchants it hasn't seen before, reads unusual SMS formats, writes weekly/monthly reports about
your habits, and answers questions like *“How much did I spend on taxis this month?”*.

1. Go to **https://console.anthropic.com**, create an account, open **Billing** and add a small prepaid credit
   (e.g. **$5** — typical use is well under $1/month).
2. Open **API Keys** → **Create Key** → copy it.
3. In GitHub, add the secret `ANTHROPIC_API_KEY` with that value (step 3), then **run Deploy again** (step 4).
4. In the app, **Settings → AI** shows the status and this month's AI spend. A monthly limit (default **$3**)
   pauses AI automatically if it's ever reached.

## Step 7 — Connect your phone to ABB messages

Open **Settings → Phone connection** in the app — best on your phone, so you can copy‑paste. Create a
connection key there; the page then shows your personal link and the steps for your phone.

**Android (MacroDroid) in short** — ABB reports every operation as a notification from the ABB app, e.g.
`💸 Ödəniş: -5.86₼ / APUS PAYMENT / Kart: **4882 / Balans: 3.05₼`:

1. Install **MacroDroid** (Google Play) → **Add Macro**.
2. Trigger: **Notification Received** → application **ABB** → text content **Any**. Allow *Notification access*.
3. Action: **HTTP Request** → method **POST** → URL = the link from Settings → body type **text/plain** →
   body = magic text **Notification title**, new line, magic text **Notification text**
   (the title holds the amount, so don't leave it out).
4. Save the macro, and set MacroDroid's battery usage to **Unrestricted** in Android settings.
5. Test: move 1 ₼ between two of your cards in the ABB app — both sides appear on Home within seconds, marked as a
   transfer between your own cards.

**iPhone:** the Shortcuts app's *Message* automation forwards ABB's SMS (the in‑app guide shows each tap).

Your cards are added automatically the first time they appear (recognized by their last 4 digits, e.g. `**4882`)
— give them names on **Cards & accounts**.

> **Read‑only by design:** the app never asks for your bank login and has no way to make payments.
> It only reads the notification texts you already receive. One‑time passwords (3‑D Secure codes) are detected
> and never stored.

### Add your history (optional)

In the ABB app, download a card statement as PDF (one month at a time works best) and upload it on
**Import statement**. The app reads it (with AI), shows you every row, and skips anything already recorded.
CSV/Excel exports work too (no AI needed).

## Step 8 — Telegram notifications (optional)

Get a message for every payment, warnings when a budget is nearly used up, your weekly report — and add cash
expenses by sending your bot messages like `12.5 taxi`.

1. In Telegram, open **@BotFather** → send `/newbot` → choose a name and a username ending in `bot`.
   BotFather replies with a **token** like `123456789:AA…`.
2. Add it as the GitHub secret `TELEGRAM_BOT_TOKEN` and run **Deploy** again.
3. In the app: **Settings → Telegram → Connect Telegram** → open the link → press **Start**.

Only your own Telegram account can use the bot; everyone else is ignored.

## Step 9 — Set up budgets

- **Settings → Budget month:** if your salary arrives e.g. on the 25th, set the month to start on the 25th.
- **Budgets:** tap **Suggest from my spending** after a few weeks, or set amounts yourself.

---

## Updating the app

When new code is added to this repository, open **Actions → Deploy → Run workflow** again.
Your data stays where it is. (If your default branch is `main`, deploys also run automatically.)

## Extra protection (optional, for the cautious)

The app is already protected by your password, optional two‑step codes, login attempt limits, and it can't touch
your bank account. If you want a second lock in front of it, Cloudflare Zero Trust (free for 1 person) can require
an email code before the login page even loads:

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self‑hosted**.
2. Domain: `wallet.<subdomain>.workers.dev`. Policy: **Allow**, rule **Emails** = your email address.
3. Add **a second application** for the same domain with path `api/ingest` and a **Bypass** policy for **Everyone**
   (otherwise your phone can't deliver messages). Do the same for `api/telegram` if you use Telegram.

## Troubleshooting

| Problem | What to do |
|---|---|
| Deploy says secrets are missing | Check the secret names in step 3 (exact spelling, no spaces). |
| `Authentication error` / `10000` | The API token is wrong or lacks permissions. Create a new one (step 2b) — don't forget **D1 → Edit**. |
| `You need to register a workers.dev subdomain` | Do step 1.2: open Workers & Pages once and choose a subdomain. Then run Deploy again. |
| Login page says no password is set | Add `APP_PASSWORD` (step 3) and run Deploy again. |
| “Too many attempts” at login | Wait 15 minutes. This protects you against password guessing. |
| Payments don't appear | **Settings → Phone connection** shows when the last message arrived. If “never”, the phone automation isn't running (check permissions, battery settings on Android, “Run Immediately” on iPhone). If messages arrive but aren't understood, they're listed under **Bank messages** — tap *Try again* after AI is enabled, or send a sample (with numbers changed) so the parser can be improved. |
| A category is wrong | Open the transaction and pick the right one. Leave “Use for every … transaction” on — the app learns and fixes the others. |
| Error `exceeded resource limits` (rare, with huge imports) | Import a smaller file, or upgrade Cloudflare Workers to the $5/month plan. |

Changing your password: update the `APP_PASSWORD` secret in GitHub and run Deploy again.
