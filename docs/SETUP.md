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
5. Test: move 1 ₼ between two of your cards in the ABB app — both sides appear in **Activity** within seconds,
   labelled “own transfer?”. Tap one and choose **Yes, my transfer** (see “Transfers between your cards” below).

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

## Transfers between your cards

ABB's notifications only show *your* card, never who sent or received the money. So the app treats each card on
its own: money leaving a card counts as spending, money arriving counts as income. Moving money between your own
cards changes nothing in total, but the app can't know it was yours until you say so:

- When the same amount leaves one of your cards and arrives on another within a few minutes, both are labelled
  **own transfer?** and a banner appears on Home and in Activity. Tap **Review** → **Yes, my transfer** for each
  pair (or **All are mine**), or **Not a transfer** to dismiss it for good.
- Any single transaction: open it → **Type** → **Between my cards** (the other side follows if it was paired).
- Many at once: Activity → **Select** → tap the transactions → **Between my cards**.
- Only confirmed transfers are left out of spending, income and budgets. Changing your mind: open it and pick
  **Expense** or **Income** again.
- A transfer you make often (e.g. to your savings card) can be confirmed automatically with a rule: **Merchants &
  rules → Rules → New rule** → *Transaction type is Transfer received* and *Card is …* → Type **Between my cards**.
  The matching payment out of your other card follows automatically.

## Make it yours: dashboards and rules

- **My dashboards** (sidebar, or **More** on the phone): start from a template (Monthly overview, Card money flow,
  Eating out & delivery, Year in review) or a blank one. **Add widget** → choose what to measure, how to split it,
  the period (incl. custom dates), filters and the chart; the preview updates as you go. Use a widget's **⋯** menu
  to edit, move, resize, duplicate or delete it, and **Dashboard settings → Show on Home** to pin a dashboard to
  the Home screen.
- **Rules** (Merchants & rules → Rules): combine several conditions and see straight away which past transactions
  match. **Save & apply** also updates those past transactions; **Save** only affects new ones. Rules are checked
  top to bottom (use the arrows to reorder) and can be switched off without deleting them. Shortcut: open any
  transaction → **Create a rule from this transaction**.
- **Custom dates:** Activity → **Custom dates**, and Analytics → **Custom**.
- **Customize Home:** on Home tap **Customize**. Every block (overview, things to check, where it went, latest,
  cards, budgets, AI coach, top places, pinned dashboards) can be moved up/down, moved between the main column, the
  side column and full width, or hidden. **Add widget** puts your own chart or number on Home; **Reset** brings the
  original layout back. Changes save automatically and apply on every device.
- **Notes** (More → Notes): free text with checklists (start a line with `- [ ]`, tap a box to tick it), pin the
  important ones, pick a colour. Closing a note saves it.
- **Themes:** Settings → Appearance. The choice is remembered on that device.

## Budgets for a date range

Budgets → **Date‑range budgets** → **Add**:

- **Applies to:** all spending, or one category (with its subcategories).
- **Days of every month:** e.g. from day 15 to day 30. If the last day is before the first (25 to 5) it runs into the
  next month; short months end on their last day.
- **Exact dates:** one time only, e.g. a holiday.
- Running ones also show on Home. Telegram warns you once per round at your chosen percentage and when you go over.
- Your normal monthly budgets are unchanged; both kinds can exist at the same time.

## Correcting a payment

Open a transaction → **Amount, date & time** → **Change**. You can change money in/out, the amount, the date and the
time, and the card. Your card balance moves by the difference. Deleting a transaction adds its amount back to (or
takes it off) the balance of that card.

Rules didn't fire because the bank's notification looked different? Open the transaction and tap **Run my rules
again** after fixing it. In a rule you can also match on **Notification heading** (the first line of the bank's
notification).

---

## Letting other people in (Google sign-in)

Other people sign in with their Google account. They ask for access, you approve them, then they can use their own private wallet (their own cards, categories and budgets; you cannot see their money screens and they cannot see yours). You still sign in with your password.

**One-time setup (about 10 minutes, free):**

1. Open <https://console.cloud.google.com>, create a project (any name), then go to **APIs & Services → OAuth consent screen**. Choose **External**, fill in an app name (e.g. “Wallet”) and your email, save. At the end set the publishing status to **In production**. Sign-in with only the basic profile and email needs no review from Google; if you leave it on “Testing”, only people you list as test users can sign in.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorized redirect URIs** add exactly: `https://YOUR-APP-ADDRESS/api/auth/google/callback` (your address is the link you open the app with, e.g. `https://wallet.yourname.workers.dev`). Create it and copy the **Client ID** and **Client secret**.
3. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Then **Actions → Deploy → Run workflow**.
4. Open the app, **Settings → Account → Link Google account** and choose your Google account. From now on you can sign in with Google as the same account too.
5. Open **More → Users & access** and switch on **Accept new sign-up requests**.

**Day to day:** tell a friend the address of the app. They tap **Continue with Google**; their request shows up in **Users & access** (you also get a Telegram message if you linked Telegram, and a badge on More). Tap **Approve** and they can sign in. You can **switch off** or **delete** anyone later (deleting removes all their data). Switch the sign-up switch off whenever you don't want new requests.

## Sign-in security

- **Two-step verification:** the first time someone signs in they are offered an authenticator app code (Google Authenticator, Microsoft Authenticator…) with 8 recovery codes. It can be skipped and turned on or off later in **Settings → Security**. Keep the recovery codes safe: each works once if the phone is lost.
- **PIN:** on every new phone or computer the app asks for a PIN (4 to 6 digits, entered twice). It opens the app on that device only and is kept on the device, never sent to the server. The app locks again after the time you choose (Settings → Security; default 1 minute). Five wrong tries sign you out of that device. Forgot it? Tap “Forgot PIN? Sign out”, sign in again and make a new one.
- **Devices:** **Settings → Security → Logged-in devices** lists where you are signed in; you can log out any of them. With Telegram linked, signing in from a new device sends you a message.

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
| Google says “redirect_uri_mismatch” | The address in Google Cloud must match exactly: `https://YOUR-APP-ADDRESS/api/auth/google/callback` (no trailing slash, https). |
| “Continue with Google” doesn't appear | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are missing in GitHub secrets, or you haven't run Deploy since adding them. |
| Someone signs in with Google but sees “Request sent” | That is normal: approve them in **More → Users & access**. If they never appear there, switch on “Accept new sign-up requests” first. |
| I changed phones and lost my authenticator | Sign in with a recovery code (type it instead of the 6-digit code), then turn two-step off and on again in Settings → Security. |
| Two-step or a stored secret says the app's encryption key is missing | Run the Deploy workflow again; it creates the key the first time and keeps it afterwards. |
| Login page says no password is set | Add `APP_PASSWORD` (step 3) and run Deploy again. |
| “Too many attempts” at login | Wait 15 minutes. This protects you against password guessing. |
| Payments don't appear | **Settings → Phone connection** shows when the last message arrived. If “never”, the phone automation isn't running (check permissions, battery settings on Android, “Run Immediately” on iPhone). If messages arrive but aren't understood, they're listed under **Bank messages** — tap *Try again* after AI is enabled, or send a sample (with numbers changed) so the parser can be improved. |
| A category is wrong | Open the transaction and pick the right one. Leave “Use for every … transaction” on — the app learns and fixes the others. |
| Money moved between my own cards counts as spending | Confirm it: Home or Activity → **Review** → **Yes, my transfer**, or open it → Type → **Between my cards**. Only confirmed transfers are left out. |
| Card balance is off after deleting or fixing a payment | Only payments that were part of the bank's last reported balance move it. For a fresh start, set the balance by hand on **Cards & accounts**; the next bank message corrects it anyway. |
| A pair was never suggested (e.g. more than 30 minutes apart) | Select both in Activity (**Select**) → **Between my cards**. |
| Error `exceeded resource limits` (rare, with huge imports) | Import a smaller file, or upgrade Cloudflare Workers to the $5/month plan. |

Changing your password: update the `APP_PASSWORD` secret in GitHub and run Deploy again.
