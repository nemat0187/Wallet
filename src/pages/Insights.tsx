import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Sparkles, Send, Trash2, TrendingDown, AlertTriangle, Lightbulb, ThumbsUp, PiggyBank } from "lucide-react";
import type { InsightReport } from "@shared/types";
import { formatMoney } from "@shared/money";
import { del, get, post, put } from "../lib/api";
import { useBootstrap, useCategories, useRefresh } from "../lib/data";
import { Button, Empty, ErrorNote, Segmented, Spinner, clsx, errorText, useToast } from "../lib/ui";
import { PageHeader } from "../components/Layout";

interface InsightListItem {
  id: number;
  kind: string;
  title: string;
  period_start: string;
  period_end: string;
  created_at: string;
  headline: string;
  health_score: number | null;
  cost_usd: number | null;
}

export default function Insights() {
  const [tab, setTab] = useState<"reports" | "ask">("reports");
  const boot = useBootstrap();
  const usage = useQuery({ queryKey: ["ai-usage"], queryFn: () => get<{ status: string; status_text: string; month_spend_usd: number; cap_usd: number }>("/ai/usage") });
  const blocked = usage.data && usage.data.status !== "ok";

  return (
    <div>
      <PageHeader
        title="Insights"
        subtitle={
          usage.data && !blocked
            ? `AI spend this month: $${usage.data.month_spend_usd.toFixed(usage.data.month_spend_usd < 0.1 ? 3 : 2)} of your $${usage.data.cap_usd} limit`
            : "Your AI money coach"
        }
      />
      <Segmented
        className="mt-3"
        value={tab}
        onChange={setTab}
        options={[
          { value: "reports", label: "Reports" },
          { value: "ask", label: "Ask AI" },
        ]}
      />
      {blocked && (
        <div className="mt-4 rounded-2xl bg-warn-soft px-4 py-3 text-sm">
          {usage.data?.status_text}{" "}
          <Link to="/settings#ai" className="font-medium text-accent">
            Open AI settings
          </Link>
        </div>
      )}
      <div className="mt-5">{tab === "reports" ? <Reports disabled={Boolean(blocked)} /> : <Ask disabled={Boolean(blocked)} hasData={(boot.data?.counts.transactions ?? 0) > 0} />}</div>
    </div>
  );
}

function Reports({ disabled }: { disabled: boolean }) {
  const toast = useToast();
  const list = useQuery({ queryKey: ["insights"], queryFn: () => get<InsightListItem[]>("/ai/insights") });
  const [selected, setSelected] = useState<number | null>(null);
  const currentId = selected ?? list.data?.[0]?.id ?? null;
  const report = useQuery({
    queryKey: ["insight", currentId],
    enabled: currentId !== null,
    queryFn: () => get<{ id: number; title: string; data: InsightReport; created_at: string; model: string; cost_usd: number | null }>(`/ai/insights/${currentId}`),
  });
  const generate = useMutation({
    mutationFn: (kind: "manual" | "monthly" | "weekly") => post<{ id: number }>("/ai/insights", { kind }),
    onSuccess: (r) => {
      setSelected(r.id);
      list.refetch();
      toast("Your report is ready");
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/ai/insights/${id}`),
    onSuccess: () => {
      setSelected(null);
      list.refetch();
    },
  });

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={disabled} loading={generate.isPending && generate.variables === "manual"} onClick={() => generate.mutate("manual")}>
          <Sparkles size={16} /> Review this month so far
        </Button>
        <Button disabled={disabled} loading={generate.isPending && generate.variables === "monthly"} onClick={() => generate.mutate("monthly")}>
          Review last month
        </Button>
      </div>
      {generate.isPending && <p className="mt-3 text-sm text-ink-3">Reading your spending… this takes about half a minute.</p>}

      <div className="mt-6">
        {list.isLoading ? (
          <Spinner />
        ) : !list.data?.length ? (
          <Empty title="No reports yet">
            Reports arrive automatically every Monday (weekly) and at the start of each month. You can also create one now.
          </Empty>
        ) : report.data ? (
          <ReportView report={report.data.data} meta={report.data} onDelete={() => window.confirm("Delete this report?") && remove.mutate(report.data!.id)} />
        ) : (
          <Spinner />
        )}
      </div>

      {list.data && list.data.length > 1 && (
        <section className="mt-10">
          <h2 className="mb-3 px-1 text-[17px] font-semibold">Earlier reports</h2>
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {list.data.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => {
                    setSelected(r.id);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  className={clsx("flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2", r.id === currentId && "bg-accent-soft")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-ink-3">{r.title}</span>
                    <span className="block truncate">{r.headline}</span>
                  </span>
                  {r.health_score !== null && <span className="num text-sm font-semibold text-ink-2">{r.health_score}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function scoreLabel(score: number) {
  if (score >= 75) return { text: "Healthy", cls: "text-good" };
  if (score >= 50) return { text: "Okay, room to improve", cls: "text-warn" };
  return { text: "Needs attention", cls: "text-bad" };
}

function ReportView({ report, meta, onDelete }: { report: InsightReport; meta: { title: string; created_at: string; cost_usd: number | null }; onDelete: () => void }) {
  const cats = useCategories();
  const refresh = useRefresh();
  const toast = useToast();
  const label = scoreLabel(report.health_score);
  const findCategory = (path: string) => {
    const leaf = path.split(/›|>/).pop()?.trim().toLowerCase();
    return cats.list.find((c) => c.name.toLowerCase() === leaf);
  };
  const applyBudget = useMutation({
    mutationFn: ({ id, amount }: { id: number; amount: number }) => put("/budgets", { category_id: id, amount: Math.round(amount * 100) }),
    onSuccess: () => {
      toast("Budget set");
      refresh();
    },
  });

  return (
    <article>
      <div className="rounded-3xl border border-line bg-surface p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <p className="text-[13px] text-ink-3">{meta.title}</p>
          <button onClick={onDelete} className="-mr-2 -mt-2 rounded-full p-2 text-ink-3 hover:bg-surface-2" aria-label="Delete report">
            <Trash2 size={16} />
          </button>
        </div>
        <h2 className="mt-1 text-[22px] font-semibold leading-snug tracking-tight">{report.headline}</h2>
        <div className="mt-4 flex items-center gap-3">
          <span className="text-4xl font-semibold tracking-tight">{report.health_score}</span>
          <span className="text-sm leading-tight">
            <span className="block text-ink-3">health score out of 100</span>
            <span className={clsx("block font-medium", label.cls)}>{label.text}</span>
          </span>
        </div>
        <p className="mt-4 max-w-prose leading-relaxed text-ink-2">{report.summary}</p>
      </div>

      {report.highlights.length > 0 && (
        <Block icon={<ThumbsUp size={18} className="text-good" />} title="Going well">
          <ul className="flex flex-col gap-2">
            {report.highlights.map((h) => (
              <li key={h} className="leading-relaxed">
                {h}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {report.bad_habits.length > 0 && (
        <Block icon={<TrendingDown size={18} className="text-bad" />} title="Habits costing you money">
          <ul className="flex flex-col gap-4">
            {report.bad_habits.map((h) => (
              <li key={h.title}>
                <p className="flex items-baseline justify-between gap-3 font-medium">
                  <span>{h.title}</span>
                  {h.monthly_cost ? <span className="num shrink-0 text-sm text-bad">~{formatMoney(Math.round(h.monthly_cost * 100), "AZN", { decimals: false })}/mo</span> : null}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-ink-2">{h.detail}</p>
                <p className="mt-1.5 text-sm leading-relaxed">
                  <span className="font-medium">Try: </span>
                  {h.suggestion}
                </p>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {report.recommendations.length > 0 && (
        <Block icon={<Lightbulb size={18} className="text-warn" />} title="Recommendations">
          <ul className="flex flex-col gap-4">
            {report.recommendations.map((r) => (
              <li key={r.title}>
                <p className="flex items-baseline justify-between gap-3 font-medium">
                  <span>{r.title}</span>
                  {r.potential_monthly_savings ? (
                    <span className="num shrink-0 text-sm text-good">save ~{formatMoney(Math.round(r.potential_monthly_savings * 100), "AZN", { decimals: false })}/mo</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-ink-2">{r.detail}</p>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {report.anomalies.length > 0 && (
        <Block icon={<AlertTriangle size={18} className="text-warn" />} title="Unusual this period">
          <ul className="flex flex-col gap-3">
            {report.anomalies.map((a) => (
              <li key={a.title}>
                <p className="font-medium">{a.title}</p>
                <p className="text-sm text-ink-2">{a.detail}</p>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {report.budget_suggestions.length > 0 && (
        <Block icon={<PiggyBank size={18} className="text-accent" />} title="Suggested budgets">
          <ul className="flex flex-col divide-y divide-line">
            {report.budget_suggestions.map((b) => {
              const cat = findCategory(b.category);
              return (
                <li key={b.category} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {cat?.icon} {b.category} · <span className="num">{formatMoney(Math.round(b.suggested_monthly_amount * 100), "AZN", { decimals: false })}</span>
                    </span>
                    <span className="block text-sm text-ink-2">{b.reason}</span>
                  </span>
                  {cat && (
                    <Button size="sm" variant="ghost" onClick={() => applyBudget.mutate({ id: cat.id, amount: b.suggested_monthly_amount })}>
                      Use
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Block>
      )}
      {meta.cost_usd !== null && <p className="mt-4 px-1 text-[12px] text-ink-3">This report cost about ${meta.cost_usd.toFixed(3)}.</p>}
    </article>
  );
}

function Block({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 rounded-2xl border border-line bg-surface p-5">
      <h3 className="mb-3 flex items-center gap-2 font-semibold">
        <span aria-hidden>{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Ask AI

type ChatMessage = { role: "user" | "assistant"; content: string };
const STORAGE_KEY = "wallet-chat";
const SUGGESTIONS = [
  "How much did I spend on taxis this month?",
  "What are my biggest expenses compared to last month?",
  "Which subscriptions am I paying for?",
  "Where can I realistically save 100 AZN a month?",
  "Bu ay restoranlara nə qədər xərcləmişəm?",
];

function loadChat(): ChatMessage[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function Ask({ disabled, hasData }: { disabled: boolean; hasData: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>(loadChat);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-30)));
    } catch {
      // storage unavailable
    }
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const ask = useMutation({
    mutationFn: (history: ChatMessage[]) => post<{ reply: string }>("/ai/chat", { messages: history }),
    onSuccess: (r) => setMessages((m) => [...m, { role: "assistant", content: r.reply }]),
  });
  const send = (text: string) => {
    const q = text.trim();
    if (!q || ask.isPending) return;
    const history = [...messages, { role: "user" as const, content: q }];
    setMessages(history);
    setInput("");
    ask.mutate(history);
  };

  return (
    <div className="flex flex-col">
      {messages.length === 0 ? (
        <div>
          <p className="text-ink-2">Ask anything about your money. The AI looks up the exact numbers in your transactions before answering.</p>
          {!hasData && <p className="mt-2 text-sm text-warn">You don't have any transactions yet, so answers will be short.</p>}
          <div className="mt-4 flex flex-col items-start gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                disabled={disabled}
                onClick={() => send(s)}
                className="rounded-2xl border border-line bg-surface px-4 py-2.5 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {messages.map((m, i) => (
            <div
              key={i}
              className={clsx(
                "max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 leading-relaxed",
                m.role === "user" ? "self-end bg-accent text-accent-ink" : "self-start border border-line bg-surface",
              )}
            >
              {m.content}
            </div>
          ))}
          {ask.isPending && (
            <div className="self-start rounded-2xl border border-line bg-surface px-4 py-2.5 text-ink-3">Looking at your transactions…</div>
          )}
          <ErrorNote error={ask.error} />
          <button onClick={() => setMessages([])} className="self-center text-sm text-ink-3 hover:text-ink">
            Start a new conversation
          </button>
        </div>
      )}
      <div ref={endRef} />
      <form
        className="sticky bottom-24 mt-6 flex gap-2 rounded-2xl border border-line bg-surface p-2 shadow-sheet lg:bottom-6"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          className="min-w-0 flex-1 bg-transparent px-2 outline-none"
          placeholder={disabled ? "AI is not available right now" : "Ask about your spending…"}
          value={input}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Your question"
        />
        <Button type="submit" variant="primary" size="sm" disabled={disabled || !input.trim()} loading={ask.isPending} aria-label="Send">
          <Send size={16} />
        </Button>
      </form>
    </div>
  );
}
