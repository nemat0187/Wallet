// Settings -> AI: choose Claude, ChatGPT or Gemini, add your own API key, pick models, set limits, see usage.

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, KeyRound, RefreshCw, Sparkles } from "lucide-react";
import type { Settings } from "@shared/types";
import { del, get, patch, post, put } from "../lib/api";
import { Button, Chip, ErrorNote, Label, Toggle, clsx, errorText, useToast } from "../lib/ui";

type ProviderId = "anthropic" | "openai" | "gemini";

interface ProviderStatus {
  provider: ProviderId;
  label: string;
  has_key: boolean;
  last4: string | null;
  source: "own" | "installation" | null;
  models: string[];
  selected: boolean;
}

interface Usage {
  month_spend_usd: number;
  month_tokens: number;
  token_cap: number;
  status: string;
  status_text: string;
  by_purpose: { purpose: string; provider: string; model: string; calls: number; cost_usd: number; cost_known: number }[];
}

const HELP: Record<ProviderId, { where: ReactNode; url: string; note: string }> = {
  anthropic: {
    where: (
      <>
        Sign in at <strong>console.anthropic.com</strong>, add a small prepaid credit (for example $5), open <strong>API keys</strong> and create a key.
      </>
    ),
    url: "https://console.anthropic.com/settings/keys",
    note: "Pay as you go. Typical use costs well under $1 a month.",
  },
  openai: {
    where: (
      <>
        Sign in at <strong>platform.openai.com</strong>, add a small credit under <strong>Billing</strong>, open <strong>API keys</strong> and create a new secret key. A ChatGPT
        subscription is separate and doesn't include API use.
      </>
    ),
    url: "https://platform.openai.com/api-keys",
    note: "Pay as you go.",
  },
  gemini: {
    where: (
      <>
        Open <strong>aistudio.google.com/apikey</strong> with your Google account and choose <strong>Create API key</strong>.
      </>
    ),
    url: "https://aistudio.google.com/apikey",
    note: "Google offers a free tier, so this can cost nothing for light use.",
  },
};

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function AiCard({ s, card }: { s: Settings; card: (props: { id: string; icon: ReactNode; title: string; intro?: ReactNode; children: ReactNode }) => ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const providers = useQuery({ queryKey: ["ai-providers"], queryFn: () => get<{ providers: ProviderStatus[] }>("/ai/providers") });
  const usage = useQuery({ queryKey: ["ai-usage"], queryFn: () => get<Usage>("/ai/usage") });
  const [view, setView] = useState<ProviderId | null>(null);
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [cap, setCap] = useState(String(s.ai_monthly_cap_usd));
  const [tokenCap, setTokenCap] = useState(String(s.ai_monthly_token_cap));
  const [tested, setTested] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ai-providers"] });
    qc.invalidateQueries({ queryKey: ["ai-usage"] });
    qc.invalidateQueries({ queryKey: ["bootstrap"] });
  };
  const current = view ?? s.ai_provider;
  const list = providers.data?.providers ?? [];
  const p = list.find((x) => x.provider === current);
  const help = HELP[current];

  const setSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch("/settings", body),
    onSuccess: () => {
      refresh();
      toast("Saved");
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  const saveKey = useMutation({
    mutationFn: () => put(`/ai/keys/${current}`, { key }),
    onSuccess: () => {
      setKey("");
      setReplacing(false);
      setTested(null);
      refresh();
      toast("Key saved. It is stored encrypted and won't be shown again.");
    },
  });
  const removeKey = useMutation({
    mutationFn: () => del(`/ai/keys/${current}`),
    onSuccess: () => {
      setConfirmRemove(false);
      refresh();
      toast("Key removed");
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  const useProvider = useMutation({
    mutationFn: () => put("/ai/provider", { provider: current }),
    onSuccess: () => {
      setView(null);
      refresh();
      toast(`${p?.label} is now used for AI`);
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  const refreshModels = useMutation({
    mutationFn: () => post(`/ai/models/${current}`),
    onSuccess: () => {
      refresh();
      toast("Model list updated");
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  const test = useMutation({
    mutationFn: () => post<{ ok: boolean; model: string; provider: string }>("/ai/test"),
    onSuccess: (r) => {
      setTested(r.ok ? `Works. Answered by ${r.model}.` : "Connected, but the answer wasn't what we expected.");
      refresh();
    },
    onError: (e) => {
      setTested(null);
      toast(errorText(e), "error");
      refresh();
    },
  });
  const categorize = useMutation({
    mutationFn: () => post<{ categorized_merchants: number }>("/ai/categorize"),
    onSuccess: (r) => toast(r.categorized_merchants ? `Categorized ${r.categorized_merchants} merchants` : "Nothing was waiting for AI"),
    onError: (e) => toast(errorText(e), "error"),
  });

  const active = current === s.ai_provider;
  const modelSelect = (label: string, hint: string, field: "ai_fast_model" | "ai_smart_model") => {
    const value = s[field];
    const models = p?.models ?? [];
    const fits = models.includes(value);
    return (
      <label className="block">
        <Label hint={hint}>{label}</Label>
        <select className="field" value={fits ? value : ""} disabled={!active || models.length === 0} onChange={(e) => setSettings.mutate({ [field]: e.target.value })}>
          {!fits && <option value="">Choose a model…</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return card({
    id: "ai",
    icon: <Sparkles size={20} />,
    title: "AI",
    intro: (
      <>
        AI is asked about merchants the app hasn't seen before (each one once), messages it can't read, and your reports and questions; everything else uses built-in rules for free.
        Bring your own key from Claude, ChatGPT or Gemini: you pay your provider directly, and nobody else uses your key.
      </>
    ),
    children: (
      <>
        <p className="text-sm">
          <span className="text-ink-2">Status:</span>{" "}
          <strong className={clsx(usage.data && usage.data.status !== "ok" && "text-warn")}>{usage.data?.status_text ?? "…"}</strong>
        </p>

        <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="AI provider">
          {list.map((x) => (
            <Chip key={x.provider} active={current === x.provider} onClick={() => { setView(x.provider); setReplacing(false); setConfirmRemove(false); setKey(""); setTested(null); }}>
              {x.label}
              {x.has_key && <CheckCircle2 size={14} className="ml-1.5 inline text-good" aria-label="has a key" />}
              {x.selected && <span className="ml-1.5 text-[12px] text-ink-3">· in use</span>}
            </Chip>
          ))}
        </div>

        {p && (
          <div className="mt-4 rounded-2xl border border-line p-4">
            {!p.has_key || replacing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  saveKey.mutate();
                }}
              >
                {!p.has_key && (
                  <>
                    <p className="text-sm font-medium">Add your {p.label} API key</p>
                    <p className="mt-1 text-sm leading-relaxed text-ink-2">{help.where}</p>
                    <a className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-accent" href={help.url} target="_blank" rel="noreferrer">
                      Open the page <ExternalLink size={13} aria-hidden />
                    </a>
                    <p className="mt-1 text-[13px] text-ink-3">{help.note}</p>
                  </>
                )}
                <label className="mt-3 block">
                  <Label>{p.has_key ? `New ${p.label} API key` : "API key"}</Label>
                  <input
                    className="field"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste the key here"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                </label>
                <p className="mt-1 text-[13px] text-ink-3">We check it with {p.label} first. It is stored encrypted and never shown again.</p>
                <div className="mt-2">
                  <ErrorNote error={saveKey.error} />
                </div>
                <div className="mt-3 flex gap-2">
                  <Button type="submit" variant="primary" loading={saveKey.isPending} disabled={key.trim().length < 8}>
                    <KeyRound size={16} /> Check and save key
                  </Button>
                  {replacing && (
                    <Button type="button" variant="ghost" onClick={() => { setReplacing(false); setKey(""); }}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            ) : (
              <>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <KeyRound size={16} className="text-accent" aria-hidden />
                  {p.source === "installation" ? (
                    <span>Using this installation's shared Claude key</span>
                  ) : (
                    <span>
                      Your key <code className="num">••••{p.last4}</code>
                    </span>
                  )}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {!active && (
                    <Button variant="primary" size="sm" loading={useProvider.isPending} onClick={() => useProvider.mutate()}>
                      Use {p.label}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setReplacing(true)}>
                    {p.source === "installation" ? "Use my own key instead" : "Replace key"}
                  </Button>
                  {p.source === "own" &&
                    (confirmRemove ? (
                      <>
                        <Button size="sm" variant="danger" loading={removeKey.isPending} onClick={() => removeKey.mutate()}>
                          Yes, remove it
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
                        Remove
                      </Button>
                    ))}
                </div>
                {active && (
                  <>
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      {modelSelect("Everyday model", "(categorizing, reading messages)", "ai_fast_model")}
                      {modelSelect("Smart model", "(reports and questions)", "ai_smart_model")}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button size="sm" loading={refreshModels.isPending} onClick={() => refreshModels.mutate()}>
                        <RefreshCw size={15} /> Refresh models
                      </Button>
                      <Button size="sm" loading={test.isPending} onClick={() => test.mutate()}>
                        Test connection
                      </Button>
                      {tested && <span className="text-sm text-good">{tested}</span>}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        <Toggle checked={s.ai_enabled} onChange={(v) => setSettings.mutate({ ai_enabled: v })} label="Use AI" hint="When off, only rules and your own corrections are used." />
        <Toggle checked={s.ai_auto_reports} onChange={(v) => setSettings.mutate({ ai_auto_reports: v })} label="Automatic weekly and monthly reports" />

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <Label hint="(tokens a month)">Usage limit</Label>
            <div className="flex gap-2">
              <input className="field num" inputMode="numeric" value={tokenCap} onChange={(e) => setTokenCap(e.target.value.replace(/\D/g, ""))} />
              <Button onClick={() => setSettings.mutate({ ai_monthly_token_cap: Number(tokenCap) })} disabled={Number(tokenCap) === s.ai_monthly_token_cap || Number(tokenCap) < 10000}>
                Save
              </Button>
            </div>
            <span className="mt-1 block text-[13px] text-ink-3">AI pauses when this is reached. A token is roughly ¾ of a word; 2,000,000 is a lot for personal use.</span>
          </label>
          <label className="block">
            <Label hint="(USD, Claude only)">Spending limit</Label>
            <div className="flex gap-2">
              <input className="field num" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
              <Button onClick={() => setSettings.mutate({ ai_monthly_cap_usd: Number(cap.replace(",", ".")) || 0 })} disabled={Number(cap) === s.ai_monthly_cap_usd}>
                Save
              </Button>
            </div>
            <span className="mt-1 block text-[13px] text-ink-3">Prices are only known for Claude, so this limit applies to it. ChatGPT and Gemini use the token limit.</span>
          </label>
          <div className="sm:col-span-2">
            <Label>This month</Label>
            <p className="text-2xl font-semibold num">
              {fmtTokens(usage.data?.month_tokens ?? 0)} <span className="text-base font-normal text-ink-3">tokens</span>
              {(usage.data?.month_spend_usd ?? 0) > 0 && <span className="ml-3 text-base font-normal text-ink-2">${(usage.data?.month_spend_usd ?? 0).toFixed(3)} on Claude</span>}
            </p>
            <p className="text-[13px] text-ink-3">{usage.data?.by_purpose.reduce((n, r) => n + r.calls, 0) ?? 0} AI requests</p>
          </div>
        </div>

        {s.ai_configured && (
          <Button className="mt-4" size="sm" loading={categorize.isPending} onClick={() => categorize.mutate()}>
            Categorize waiting transactions now
          </Button>
        )}
      </>
    ),
  });
}
