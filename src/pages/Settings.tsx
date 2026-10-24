import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Copy, KeyRound, Smartphone, Sparkles, Send, CalendarDays, ShieldCheck, Database, Palette, Trash2, LogOut, CheckCircle2 } from "lucide-react";
import type { Settings as SettingsT } from "@shared/types";
import { del, get, patch, post } from "../lib/api";
import { useBootstrap, useRefresh } from "../lib/data";
import { Button, ErrorNote, Label, Segmented, Spinner, Toggle, clsx, errorText, useCopy, useToast } from "../lib/ui";
import { PageHeader } from "../components/Layout";

export default function SettingsPage() {
  const boot = useBootstrap();
  const location = useLocation();
  useEffect(() => {
    if (location.hash) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth" }), 100);
  }, [location.hash, boot.data]);
  if (!boot.data) return <Spinner />;
  const s = boot.data.settings;
  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />
      <PhoneConnection origin={boot.data.origin} lastMessageAt={s.last_message_at} />
      <AiSettings s={s} />
      <TelegramSettings s={s} />
      <PeriodSettings s={s} />
      <Security s={s} />
      <Appearance />
      <DataSection />
    </div>
  );
}

function Card({ id, icon, title, children, intro }: { id: string; icon: ReactNode; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mt-6 scroll-mt-6 rounded-3xl border border-line bg-surface p-5 sm:p-6">
      <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
        <span className="text-accent" aria-hidden>
          {icon}
        </span>
        {title}
      </h2>
      {intro && <div className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-2">{intro}</div>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function useSaveSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: Partial<Record<keyof SettingsT, unknown>>) => patch<SettingsT>("/settings", body),
    onSuccess: () => {
      qc.invalidateQueries();
      toast("Saved");
    },
    onError: (e) => toast(errorText(e), "error"),
  });
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

// ---------------------------------------------------------------------------
// Phone connection

function PhoneConnection({ origin, lastMessageAt }: { origin: string; lastMessageAt: string | null }) {
  const copy = useCopy();
  const refresh = useRefresh();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => get<{ id: number; name: string; token_hint: string; created_at: string; last_used_at: string | null }[]>("/messages/tokens/list") });
  const [newToken, setNewToken] = useState<string | null>(null);
  const [phone, setPhone] = useState<"iphone" | "android">(() => (/Android/i.test(navigator.userAgent) ? "android" : "iphone"));
  const create = useMutation({
    mutationFn: () => post<{ token: string }>("/messages/tokens", { name: phone === "iphone" ? "iPhone" : "Android phone" }),
    onSuccess: (r) => {
      setNewToken(r.token);
      tokens.refetch();
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/messages/tokens/${id}`),
    onSuccess: () => tokens.refetch(),
  });
  const url = `${origin}/api/ingest`;
  const token = newToken ?? "YOUR-KEY";
  const urlWithKey = `${url}?token=${token}`;

  return (
    <Card
      id="phone"
      icon={<Smartphone size={20} />}
      title="Phone connection"
      intro={
        <>
          ABB sends you an SMS (or app notification) for every card payment. Your phone forwards that text to this app, which records it. The app never logs in
          to your bank and can't move money — it only reads the messages you already receive.
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface-2 px-4 py-3 text-sm">
        {lastMessageAt ? <CheckCircle2 size={16} className="text-good" aria-hidden /> : <span className="h-2 w-2 rounded-full bg-ink-3" aria-hidden />}
        <span>
          Last message received: <strong className="font-semibold">{ago(lastMessageAt)}</strong>
        </span>
        <button onClick={refresh} className="ml-auto font-medium text-accent">
          Refresh
        </button>
      </div>

      <h3 className="mt-6 font-semibold">1. Create a connection key</h3>
      <p className="mt-1 text-sm text-ink-2">The key proves to the app that messages really come from your phone. Keep it private, like a password.</p>
      {newToken ? (
        <div className="mt-3 rounded-2xl border border-accent bg-accent-soft p-4">
          <p className="text-sm font-medium">Your new key (shown only once — copy it now):</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-surface px-3 py-2 text-[13px]">{newToken}</code>
            <Button size="sm" onClick={() => copy(newToken, "Key copied")}>
              <Copy size={15} /> Copy
            </Button>
          </div>
        </div>
      ) : (
        <Button className="mt-3" variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
          <KeyRound size={16} /> Create key
        </Button>
      )}
      {tokens.data && tokens.data.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded-2xl border border-line text-sm">
          {tokens.data.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex-1">
                {t.name} <span className="text-ink-3">· ends …{t.token_hint}</span>
                <span className="block text-[12px] text-ink-3">last used {ago(t.last_used_at)}</span>
              </span>
              <button
                onClick={() => window.confirm("Delete this key? A phone using it will stop sending messages.") && remove.mutate(t.id)}
                className="rounded-full p-2 text-ink-3 hover:bg-surface-2 hover:text-bad"
                aria-label={`Delete key ${t.name}`}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-6 font-semibold">2. Set up your phone</h3>
      <Segmented
        className="mt-2"
        value={phone}
        onChange={setPhone}
        options={[
          { value: "iphone", label: "iPhone" },
          { value: "android", label: "Android" },
        ]}
      />
      <div className="mt-3 rounded-2xl border border-line p-4">
        {phone === "iphone" ? (
          <>
            <p className="text-sm text-ink-2">You'll need these two values (tap to copy). Doing this on your phone makes copying easier: open this page there.</p>
            <CopyRow label="Address" value={url} />
            <CopyRow label="Key" value={newToken ?? "create a key above first"} disabled={!newToken} />
            <IphoneSteps url={url} />
          </>
        ) : (
          <>
            <p className="text-sm text-ink-2">You'll need this link — it already contains your key (tap to copy). Doing this on your phone makes copying easier.</p>
            <CopyRow label="Link" value={newToken ? urlWithKey : "create a key above first"} disabled={!newToken} />
            <AndroidSteps />
          </>
        )}
      </div>

      <h3 className="mt-6 font-semibold">3. Check it works</h3>
      <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-sm text-ink-2">
        <li>Make any small card payment, or wait for the next one. Within a few seconds “Last message received” above changes, and the payment appears on Home.</li>
        <li>
          Nothing arriving? On Android, check that the ABB app's notifications are on and that MacroDroid has notification access and unrestricted battery use. On
          iPhone, check that ABB sends you SMS for each card (ABB app settings or a branch).
        </li>
        <li>If a message arrives but isn't understood, it appears under Bank messages, where you can fix it. One-time passwords are always ignored and never stored.</li>
      </ul>
    </Card>
  );
}

function CopyRow({ label, value, disabled }: { label: string; value: string; disabled?: boolean }) {
  const copy = useCopy();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => copy(value, `${label} copied`)}
      className="mt-2 flex w-full items-center gap-3 rounded-xl bg-surface-2 px-3 py-2 text-left text-sm disabled:opacity-60"
    >
      <span className="w-16 shrink-0 text-ink-3">{label}</span>
      {disabled ? <span className="min-w-0 flex-1 text-ink-3">{value}</span> : <code className="min-w-0 flex-1 break-all">{value}</code>}
      {!disabled && <Copy size={15} className="shrink-0 text-ink-3" aria-hidden />}
    </button>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="mt-4 flex list-decimal flex-col gap-2.5 pl-5 text-sm leading-relaxed marker:font-semibold marker:text-ink-3">{children}</ol>;
}

function IphoneSteps({ url }: { url: string }) {
  return (
    <Steps>
      <li>
        Open the <strong>Shortcuts</strong> app → <strong>Automation</strong> tab → <strong>+</strong> (or “New Automation”) → choose <strong>Message</strong>.
      </li>
      <li>
        At <strong>Sender</strong>, choose ABB's sender (as it appears in Messages, e.g. “ABB”). Also set <strong>Message Contains</strong> to <code>AZN</code>. Select{" "}
        <strong>Run Immediately</strong> and turn off “Notify When Run”. Tap <strong>Next</strong>.
      </li>
      <li>
        Choose <strong>New Blank Automation</strong>, then <strong>Add Action</strong> and search for <strong>Get Contents of URL</strong>.
      </li>
      <li>
        Tap the blue “URL” and paste the <strong>Address</strong>: <code className="break-all">{url}</code>
      </li>
      <li>
        Tap the arrow to show more options:
        <ul className="mt-1 list-disc pl-5">
          <li>
            <strong>Method</strong>: POST
          </li>
          <li>
            <strong>Headers</strong> → Add new header: key <code>Authorization</code>, value <code>Bearer </code> followed by your key (one space after “Bearer”).
          </li>
          <li>
            <strong>Request Body</strong>: JSON → Add new field → Text → key <code>text</code>, and for the value tap the variable button and pick{" "}
            <strong>Shortcut Input</strong> (then tap it and choose <strong>Content</strong>).
          </li>
        </ul>
      </li>
      <li>
        Tap <strong>Done</strong>. From now on each ABB message is forwarded silently.
      </li>
    </Steps>
  );
}

function AndroidSteps() {
  return (
    <>
      <p className="mt-4 text-sm text-ink-2">
        ABB shows every card operation as a notification from the ABB app (“💸 Ödəniş: −5.86₼ …”). The free app <strong>MacroDroid</strong> forwards each one
        here the moment it appears.
      </p>
      <Steps>
        <li>
          Install <strong>MacroDroid</strong> from Google Play, open it and tap <strong>Add Macro</strong>.
        </li>
        <li>
          <strong>Triggers</strong> → <strong>+</strong> → find <strong>Notification</strong> (use the search icon if you don't see it) →{" "}
          <strong>Notification Received</strong> → <strong>Select Application(s)</strong> → tick the <strong>ABB</strong> app → OK. Text content: <strong>Any</strong>.
          When asked, turn on <strong>Notification access</strong> for MacroDroid.
        </li>
        <li>
          <strong>Actions</strong> → <strong>+</strong> → <strong>Connectivity</strong> (or Web) → <strong>HTTP Request</strong>:
          <ul className="mt-1 list-disc pl-5">
            <li>
              Request method: <strong>POST</strong>
            </li>
            <li>
              URL: paste the <strong>Link</strong> above.
            </li>
            <li>
              Content / body type: <strong>text/plain</strong>. In the body, tap the magic text button (<strong>…</strong>) and choose{" "}
              <strong>Notification title</strong>, start a new line, then magic text again → <strong>Notification text</strong>. The title is important: it holds the
              amount.
            </li>
          </ul>
        </li>
        <li>
          Name the macro “Wallet” and save it (✓).
        </li>
        <li>
          In Android settings → Apps → <strong>MacroDroid</strong> → Battery → <strong>Unrestricted</strong>, so Android never puts it to sleep. Keep notifications
          for the ABB app turned on.
        </li>
        <li>
          Test it: in the ABB app move 1 ₼ from one of your cards to another. Both sides appear on Home within seconds, marked as a transfer between your own
          cards (not counted as spending).
        </li>
      </Steps>
      <p className="mt-3 text-[13px] text-ink-3">
        Getting ABB SMS instead of app notifications? Use the trigger <strong>Phone/SMS → SMS Received</strong> (from ABB) and put the <strong>SMS message</strong>{" "}
        magic text in the body. Any other “forward to URL” app works too: POST the text to the link above.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// AI

const MODEL_LABEL: Record<string, string> = {
  "claude-haiku-5-5": "Claude Haiku 5.5 — cheapest, fast",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 — balanced",
  "claude-opus-5-5": "Claude Opus 5.5 — most precise",
};

function AiSettings({ s }: { s: SettingsT }) {
  const save = useSaveSettings();
  const toast = useToast();
  const usage = useQuery({
    queryKey: ["ai-usage"],
    queryFn: () =>
      get<{ month_spend_usd: number; cap_usd: number; status_text: string; by_purpose: { purpose: string; model: string; calls: number; cost_usd: number }[]; months: { month: string; cost_usd: number }[] }>("/ai/usage"),
  });
  const [cap, setCap] = useState(String(s.ai_monthly_cap_usd));
  const categorize = useMutation({
    mutationFn: () => post<{ categorized_merchants: number }>("/ai/categorize"),
    onSuccess: (r) => toast(r.categorized_merchants ? `Categorized ${r.categorized_merchants} merchants` : "Nothing was waiting for AI"),
    onError: (e) => toast(errorText(e), "error"),
  });

  return (
    <Card
      id="ai"
      icon={<Sparkles size={20} />}
      title="AI"
      intro={
        <>
          AI is only asked about merchants the app hasn't seen before (each one once), for messages it can't read, and for your reports and questions. Everything else is
          handled by built-in rules for free. Typical cost: well under $1 a month.
        </>
      }
    >
      {!s.ai_configured ? (
        <div className="rounded-2xl bg-warn-soft p-4 text-sm leading-relaxed">
          <p className="font-medium">AI isn't connected yet.</p>
          <ol className="mt-2 list-decimal pl-5">
            <li>
              Create an account at <strong>console.anthropic.com</strong>, add a small prepaid credit (e.g. $5 lasts months), and create an API key.
            </li>
            <li>
              In your GitHub repository: Settings → Secrets and variables → Actions → New repository secret, name <code>ANTHROPIC_API_KEY</code>, paste the key.
            </li>
            <li>Run the “Deploy” workflow again (Actions tab). That's it.</li>
          </ol>
        </div>
      ) : (
        <p className="text-sm">
          <span className="text-ink-2">Status:</span> <strong>{usage.data?.status_text ?? "…"}</strong>
        </p>
      )}

      <Toggle checked={s.ai_enabled} onChange={(v) => save.mutate({ ai_enabled: v })} label="Use AI" hint="When off, only rules and your own corrections are used." />
      <Toggle checked={s.ai_auto_reports} onChange={(v) => save.mutate({ ai_auto_reports: v })} label="Automatic weekly and monthly reports" />

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <Label hint="(USD)">Monthly spending limit</Label>
          <div className="flex gap-2">
            <input className="field num" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
            <Button onClick={() => save.mutate({ ai_monthly_cap_usd: Number(cap.replace(",", ".")) || 0 })} disabled={Number(cap) === s.ai_monthly_cap_usd}>
              Save
            </Button>
          </div>
          <span className="mt-1 block text-[13px] text-ink-3">AI pauses automatically when this is reached.</span>
        </label>
        <div>
          <Label>This month</Label>
          <p className="text-2xl font-semibold num">${(usage.data?.month_spend_usd ?? 0).toFixed(3)}</p>
          <p className="text-[13px] text-ink-3">{usage.data?.by_purpose.reduce((n, p) => n + p.calls, 0) ?? 0} AI requests</p>
        </div>
        <label className="block">
          <Label hint="(categorizing, reading messages)">Everyday model</Label>
          <select className="field" value={s.ai_fast_model} onChange={(e) => save.mutate({ ai_fast_model: e.target.value })}>
            {Object.entries(MODEL_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <Label hint="(reports, Ask AI)">Advice model</Label>
          <select className="field" value={s.ai_smart_model} onChange={(e) => save.mutate({ ai_smart_model: e.target.value })}>
            {Object.entries(MODEL_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      {s.ai_configured && (
        <Button className="mt-4" size="sm" loading={categorize.isPending} onClick={() => categorize.mutate()}>
          Categorize waiting transactions now
        </Button>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Telegram

function TelegramSettings({ s }: { s: SettingsT }) {
  const save = useSaveSettings();
  const toast = useToast();
  const refresh = useRefresh();
  const [link, setLink] = useState<{ link: string; bot_username: string } | null>(null);
  const connect = useMutation({ mutationFn: () => post<{ link: string; bot_username: string }>("/telegram/connect"), onSuccess: setLink, onError: (e) => toast(errorText(e), "error") });
  const test = useMutation({ mutationFn: () => post("/telegram/test"), onSuccess: () => toast("Test message sent"), onError: (e) => toast(errorText(e), "error") });
  const disconnect = useMutation({ mutationFn: () => post("/telegram/disconnect"), onSuccess: refresh });

  return (
    <Card
      id="telegram"
      icon={<Send size={20} />}
      title="Telegram notifications"
      intro="Optional. Get a message for each payment, budget warnings and your reports — and add cash expenses by typing “12.5 taxi” to your bot."
    >
      {!s.telegram_configured ? (
        <ol className="list-decimal pl-5 text-sm leading-relaxed text-ink-2">
          <li>
            In Telegram, open <strong>@BotFather</strong>, send <code>/newbot</code>, and follow the prompts. You'll get a token like <code>123456:ABC…</code>.
          </li>
          <li>
            Add it as a GitHub repository secret named <code>TELEGRAM_BOT_TOKEN</code> and run the “Deploy” workflow again.
          </li>
          <li>Come back here and press “Connect”.</li>
        </ol>
      ) : !s.telegram_connected ? (
        <div>
          {link ? (
            <div className="rounded-2xl border border-accent bg-accent-soft p-4 text-sm">
              <p>
                Open your bot and press <strong>Start</strong> (link valid for 15 minutes):
              </p>
              <a href={link.link} target="_blank" rel="noreferrer" className="mt-2 inline-block font-semibold text-accent underline">
                Open @{link.bot_username}
              </a>
              <p className="mt-2 text-ink-2">Then refresh this page.</p>
              <Button size="sm" className="mt-3" onClick={refresh}>
                I've pressed Start
              </Button>
            </div>
          ) : (
            <Button variant="primary" loading={connect.isPending} onClick={() => connect.mutate()}>
              Connect Telegram
            </Button>
          )}
        </div>
      ) : (
        <div>
          <p className="flex items-center gap-2 text-sm text-good">
            <CheckCircle2 size={16} aria-hidden /> Connected
          </p>
          <Toggle checked={s.notify_each_transaction} onChange={(v) => save.mutate({ notify_each_transaction: v })} label="Message for every transaction" />
          <Toggle checked={s.notify_budget_alerts} onChange={(v) => save.mutate({ notify_budget_alerts: v })} label="Budget warnings" />
          <Toggle checked={s.notify_reports} onChange={(v) => save.mutate({ notify_reports: v })} label="Weekly and monthly reports" />
          <div className="mt-3 flex gap-2">
            <Button size="sm" loading={test.isPending} onClick={() => test.mutate()}>
              Send a test message
            </Button>
            <Button size="sm" variant="ghost" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Budget period & preferences

function PeriodSettings({ s }: { s: SettingsT }) {
  const save = useSaveSettings();
  return (
    <Card id="period" icon={<CalendarDays size={20} />} title="Budget month" intro="If your salary arrives on, say, the 25th, start your budget month on the 25th so each month matches one paycheck.">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <Label>Month starts on day</Label>
          <select className="field" value={s.month_start_day} onChange={(e) => save.mutate({ month_start_day: Number(e.target.value) })}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d === 1 ? "1 (calendar month)" : d}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <Label>Time zone</Label>
          <select className="field" value={s.tz_offset_minutes} onChange={(e) => save.mutate({ tz_offset_minutes: Number(e.target.value) })}>
            {[180, 210, 240, 270, 300, 0, 60, 120].map((m) => (
              <option key={m} value={m}>
                UTC{m >= 0 ? "+" : "−"}
                {Math.floor(Math.abs(m) / 60)}
                {m % 60 ? ":30" : ""}
                {m === 240 ? " (Baku)" : m === 180 ? " (Istanbul, Moscow)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Toggle
        checked={s.atm_as_transfer}
        onChange={(v) => save.mutate({ atm_as_transfer: v })}
        label="Treat cash withdrawals as a transfer to my Cash wallet"
        hint="Turn on if you log cash spending by hand; otherwise withdrawals count as spending."
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Security

function Security({ s }: { s: SettingsT }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => get<{ id: string; created_at: string; last_seen_at: string; user_agent: string | null; ip: string | null; current: boolean }[]>("/auth/sessions"),
  });
  const start = useMutation({
    mutationFn: async () => {
      const r = await post<{ secret: string; uri: string }>("/auth/totp/setup");
      return { ...r, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 220 }) };
    },
    onSuccess: setSetup,
  });
  const enable = useMutation({
    mutationFn: () => post("/auth/totp/enable", { code }),
    onSuccess: () => {
      toast("Two-step login is on");
      setSetup(null);
      setCode("");
      qc.invalidateQueries();
    },
  });
  const disable = useMutation({
    mutationFn: () => post("/auth/totp/disable", { code }),
    onSuccess: () => {
      toast("Two-step login is off");
      setCode("");
      qc.invalidateQueries();
    },
  });
  const revoke = useMutation({ mutationFn: () => post("/auth/sessions/revoke-others"), onSuccess: () => sessions.refetch() });
  const logout = useMutation({ mutationFn: () => post("/auth/logout"), onSuccess: () => window.location.reload() });

  return (
    <Card id="security" icon={<ShieldCheck size={20} />} title="Security" intro="Only you can open this app. To change your password, update the APP_PASSWORD secret in GitHub and run Deploy again.">
      <h3 className="font-semibold">Two-step login</h3>
      <p className="mt-1 text-sm text-ink-2">Ask for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator…) in addition to your password.</p>
      {s.totp_enabled ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <p className="w-full text-sm text-good">On</p>
          <input className="field w-36 num" inputMode="numeric" maxLength={6} placeholder="Code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          <Button variant="danger" loading={disable.isPending} disabled={code.length !== 6} onClick={() => disable.mutate()}>
            Turn off
          </Button>
          <ErrorNote error={disable.error} />
        </div>
      ) : setup ? (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <img src={setup.qr} alt="QR code for your authenticator app" className="h-44 w-44 rounded-xl bg-white p-2" />
          <div className="flex-1 text-sm">
            <p>Scan this with your authenticator app, or enter this key by hand:</p>
            <code className="mt-1 block break-all rounded-lg bg-surface-2 px-3 py-2">{setup.secret}</code>
            <label className="mt-3 block">
              <Label>Then type the 6-digit code it shows</Label>
              <div className="flex gap-2">
                <input className="field w-36 num" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                <Button variant="primary" loading={enable.isPending} disabled={code.length !== 6} onClick={() => enable.mutate()}>
                  Turn on
                </Button>
              </div>
            </label>
            <ErrorNote error={enable.error} />
          </div>
        </div>
      ) : (
        <Button className="mt-3" loading={start.isPending} onClick={() => start.mutate()}>
          Set up two-step login
        </Button>
      )}

      <h3 className="mt-6 font-semibold">Logged-in devices</h3>
      <ul className="mt-2 divide-y divide-line rounded-2xl border border-line text-sm">
        {sessions.data?.map((x) => (
          <li key={x.id} className="px-4 py-2.5">
            <span className="block truncate">{describeAgent(x.user_agent)}</span>
            <span className="block text-[12px] text-ink-3">
              {x.current ? "This device · " : ""}last active {ago(x.last_seen_at)}
              {x.ip ? ` · ${x.ip}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" loading={revoke.isPending} onClick={() => revoke.mutate()}>
          Log out other devices
        </Button>
        <Button size="sm" variant="ghost" loading={logout.isPending} onClick={() => logout.mutate()}>
          <LogOut size={15} /> Log out
        </Button>
      </div>
    </Card>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : ua.split(" ")[0];
  return [browser, os].filter(Boolean).join(" on ") || ua.slice(0, 60);
}

// ---------------------------------------------------------------------------

function Appearance() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => {
    try {
      return (localStorage.getItem("wallet-theme") as "light" | "dark" | null) ?? "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem("wallet-theme");
      else localStorage.setItem("wallet-theme", theme);
    } catch {
      // storage unavailable
    }
  }, [theme]);
  return (
    <Card id="appearance" icon={<Palette size={20} />} title="Appearance">
      <Segmented
        value={theme}
        onChange={setTheme}
        options={[
          { value: "system", label: "Automatic" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />
      <p className="mt-3 text-sm text-ink-2">
        Tip: add this app to your home screen (Safari: Share → Add to Home Screen; Chrome: ⋮ → Add to Home screen) to open it like a normal app.
      </p>
    </Card>
  );
}

function DataSection() {
  const toast = useToast();
  const refresh = useRefresh();
  const [confirm, setConfirm] = useState("");
  const reset = useMutation({
    mutationFn: () => post("/data/reset", { confirm }),
    onSuccess: () => {
      toast("All transactions deleted");
      setConfirm("");
      refresh();
    },
  });
  return (
    <Card id="data" icon={<Database size={20} />} title="Your data" intro="Your data is stored in your own Cloudflare account. Download a copy whenever you like.">
      <div className="flex flex-wrap gap-2">
        <a href="/api/export/transactions.csv">
          <Button>Download transactions (CSV)</Button>
        </a>
        <a href="/api/export/backup.json">
          <Button>Download full backup (JSON)</Button>
        </a>
      </div>
      <details className="mt-6 rounded-2xl border border-bad/40 p-4">
        <summary className={clsx("cursor-pointer text-sm font-medium text-bad")}>Delete all transactions…</summary>
        <p className="mt-2 text-sm text-ink-2">Removes every transaction, message, merchant and report. Categories, budgets, cards and settings stay. This can't be undone.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input className="field max-w-xs" placeholder='Type "DELETE EVERYTHING"' value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button variant="danger" disabled={confirm !== "DELETE EVERYTHING"} loading={reset.isPending} onClick={() => reset.mutate()}>
            Delete
          </Button>
        </div>
        <ErrorNote error={reset.error} />
      </details>
    </Card>
  );
}
