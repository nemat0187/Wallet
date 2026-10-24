import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Wand2 } from "lucide-react";
import type { BudgetStatus, Period } from "@shared/types";
import { daysBetween, formatMoney, localDate, parseAmount, shiftPeriod } from "@shared/money";
import { del, get, post, put } from "../lib/api";
import { useBootstrap, useCategories, useRefresh } from "../lib/data";
import { Button, Empty, ErrorNote, Label, Section, Sheet, Spinner, clsx, useToast } from "../lib/ui";
import { PageHeader } from "../components/Layout";
import { Meter } from "../components/charts";
import { rollupSpending } from "../lib/spending";

interface BudgetsData {
  period: Period;
  overall: BudgetStatus | null;
  categories: BudgetStatus[];
  total_spent: number;
  average_last_3: Record<number, number>;
}

export default function Budgets() {
  const boot = useBootstrap();
  const cats = useCategories();
  const refresh = useRefresh();
  const toast = useToast();
  const settings = boot.data?.settings;
  const today = localDate(new Date(), settings?.tz_offset_minutes ?? 240);
  const [anchor, setAnchor] = useState(today);
  const q = useQuery({ queryKey: ["budgets", anchor], queryFn: () => get<BudgetsData>(`/budgets?date=${anchor}`), placeholderData: (p) => p });
  const spending = useQuery({
    queryKey: ["category-spending", q.data?.period.start],
    enabled: Boolean(q.data),
    queryFn: () => get<{ category_id: number; spent: number; children: { category_id: number; spent: number }[] }[]>(
      `/analytics/categories?from=${q.data!.period.start}&to=${q.data!.period.end}`,
    ),
  });
  const [editing, setEditing] = useState<{ categoryId: number | null; amount: number | null; alert: number } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const suggest = useMutation({
    mutationFn: () => post<{ created: number }>("/budgets/suggest"),
    onSuccess: (r) => {
      toast(r.created ? `Created ${r.created} budgets from your last 3 months` : "Every category with regular spending already has a budget");
      refresh();
    },
  });

  if (!q.data || !settings) return <Spinner />;
  const d = q.data;
  const isCurrent = today >= d.period.start && today <= d.period.end;
  const totalDays = daysBetween(d.period.start, d.period.end) + 1;
  const elapsed = isCurrent ? daysBetween(d.period.start, today) + 1 : totalDays;
  const pace = isCurrent ? elapsed / totalDays : null;
  const budgeted = new Set(d.categories.map((b) => b.category_id));
  const spentById = rollupSpending(spending.data ?? []);
  const unbudgeted = cats.parents
    .filter((p) => p.kind === "expense" && !p.archived && !budgeted.has(p.id) && p.slug !== "uncategorized")
    .map((p) => ({ cat: p, spent: spentById.get(p.id) ?? 0, avg: d.average_last_3[p.id] ?? 0 }))
    .sort((a, b) => b.avg + b.spent - (a.avg + a.spent));
  const totalBudgeted = d.categories.reduce((s, b) => s + b.amount, 0);

  return (
    <div className={clsx(q.isFetching && q.isPlaceholderData && "opacity-60")}>
      <PageHeader
        title="Budgets"
        subtitle={
          <>
            Monthly limits, {settings.month_start_day === 1 ? "from the 1st of each month" : `starting on day ${settings.month_start_day}`}.{" "}
            <Link to="/settings#period" className="text-accent">
              Change
            </Link>
          </>
        }
      />
      <div className="mt-3 flex items-center gap-1">
        <button onClick={() => setAnchor(shiftPeriod(d.period.start, settings.month_start_day, -1).start)} className="rounded-full p-2 text-ink-2 hover:bg-surface-2" aria-label="Previous period">
          <ChevronLeft size={20} />
        </button>
        <span className="min-w-28 text-center font-medium">{d.period.label}</span>
        <button
          onClick={() => setAnchor(shiftPeriod(d.period.start, settings.month_start_day, 1).start)}
          disabled={isCurrent}
          className="rounded-full p-2 text-ink-2 hover:bg-surface-2 disabled:opacity-30"
          aria-label="Next period"
        >
          <ChevronRight size={20} />
        </button>
      </div>

      {/* Overall */}
      <section className="mt-3 rounded-3xl border border-line bg-surface p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-ink-2">Total monthly budget</p>
            {d.overall ? (
              <p className="mt-1 text-[26px] font-semibold tracking-tight sm:text-3xl">
                <span className={clsx("whitespace-nowrap", d.overall.status === "over" && "text-bad")}>{formatMoney(d.overall.spent, "AZN", { decimals: false })}</span>
                <span className="whitespace-nowrap text-ink-3"> / {formatMoney(d.overall.amount, "AZN", { decimals: false })}</span>
              </p>
            ) : (
              <p className="mt-1 text-ink-3">Not set — spent {formatMoney(d.total_spent)} so far</p>
            )}
          </div>
          <Button size="sm" onClick={() => setEditing({ categoryId: null, amount: settings.overall_budget, alert: 90 })}>
            {d.overall ? "Edit" : "Set"}
          </Button>
        </div>
        {d.overall && (
          <div className="mt-4">
            <Meter spent={d.overall.spent} amount={d.overall.amount} status={d.overall.status} paceFraction={pace} />
            <p className="mt-2 text-sm text-ink-2">
              {d.overall.remaining >= 0 ? `${formatMoney(d.overall.remaining)} left` : `${formatMoney(-d.overall.remaining)} over`}
              {isCurrent && d.overall.projected > d.overall.amount && (
                <span className="text-warn"> · at this pace you'll reach {formatMoney(d.overall.projected, "AZN", { decimals: false })}</span>
              )}
            </p>
          </div>
        )}
        {totalBudgeted > 0 && (
          <p className="mt-3 border-t border-line pt-3 text-sm text-ink-3">
            Category budgets add up to {formatMoney(totalBudgeted, "AZN", { decimals: false })}
            {d.overall && totalBudgeted > d.overall.amount ? " — more than your total budget." : "."}
          </p>
        )}
      </section>

      <Section
        title="By category"
        action={
          <Button size="sm" variant="ghost" onClick={() => suggest.mutate()} loading={suggest.isPending}>
            <Wand2 size={16} /> Suggest from my spending
          </Button>
        }
      >
        {d.categories.length === 0 ? (
          <Empty title="No category budgets yet">
            Tap “Suggest from my spending” to create budgets based on your last 3 months, or set one below.
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
            {d.categories.map((b) => {
              const info = cats.info(b.category_id);
              return (
                <li key={b.category_id}>
                  <button
                    className="block w-full px-4 py-3.5 text-left hover:bg-surface-2"
                    onClick={() => setEditing({ categoryId: b.category_id, amount: b.amount, alert: b.alert_pct })}
                  >
                    <div className="mb-2 flex items-center gap-3">
                      <span className="text-xl" aria-hidden>
                        {info?.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{info?.path}</span>
                        <span className="block text-[13px] text-ink-3">
                          {b.status === "over"
                            ? `${formatMoney(-b.remaining, "AZN", { decimals: false })} over`
                            : `${formatMoney(b.remaining, "AZN", { decimals: false })} left`}
                          {d.average_last_3[b.category_id ?? 0] ? ` · usually ${formatMoney(d.average_last_3[b.category_id ?? 0], "AZN", { decimals: false })}` : ""}
                        </span>
                      </span>
                      <span className="num text-right">
                        <span className={clsx("font-semibold", b.status === "over" ? "text-bad" : b.status === "warning" ? "text-warn" : "")}>
                          {formatMoney(b.spent, "AZN", { decimals: false })}
                        </span>
                        <span className="text-ink-3"> / {formatMoney(b.amount, "AZN", { decimals: false })}</span>
                      </span>
                    </div>
                    <Meter spent={b.spent} amount={b.amount} status={b.status} paceFraction={pace} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {pace !== null && d.categories.length > 0 && (
          <p className="mt-2 px-1 text-[13px] text-ink-3">The small mark shows where you'd be today if you spent evenly through the month.</p>
        )}
      </Section>

      {unbudgeted.length > 0 && (
        <Section title="Without a budget">
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
            {unbudgeted.filter((x) => showAll || x.spent > 0 || x.avg > 0).map(({ cat, spent, avg }) => (
              <li key={cat.id} className="flex items-center gap-3 px-4 py-3">
                <span className="text-xl" aria-hidden>
                  {cat.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{cat.name}</span>
                  <span className="block text-[13px] text-ink-3">
                    {formatMoney(spent, "AZN", { decimals: false })} this month
                    {avg ? ` · usually ${formatMoney(avg, "AZN", { decimals: false })}` : ""}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ categoryId: cat.id, amount: avg ? Math.ceil(avg / 1000) * 1000 : null, alert: 80 })}>
                  Set budget
                </Button>
              </li>
            ))}
          </ul>
          {!showAll && unbudgeted.some((x) => !x.spent && !x.avg) && (
            <button onClick={() => setShowAll(true)} className="mt-2 px-1 text-sm font-medium text-accent">
              Show categories with no spending
            </button>
          )}
        </Section>
      )}

      <BudgetEditor editing={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function BudgetEditor({ editing, onClose }: { editing: { categoryId: number | null; amount: number | null; alert: number } | null; onClose: () => void }) {
  const cats = useCategories();
  return (
    <Sheet open={Boolean(editing)} onClose={onClose} title={editing?.categoryId ? `Budget for ${cats.info(editing.categoryId)?.name}` : "Total monthly budget"}>
      {editing && <EditorForm key={String(editing.categoryId)} editing={editing} onClose={onClose} />}
    </Sheet>
  );
}

function EditorForm({ editing, onClose }: { editing: { categoryId: number | null; amount: number | null; alert: number }; onClose: () => void }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [amount, setAmount] = useState(editing.amount ? String(editing.amount / 100) : "");
  const [alert, setAlert] = useState(editing.alert);
  const save = useMutation({
    mutationFn: () => {
      const minor = parseAmount(amount || "0");
      if (minor === null || minor < 0) throw new Error("Enter an amount like 300");
      return editing.categoryId === null
        ? put("/budgets/overall", { amount: minor || null })
        : put("/budgets", { category_id: editing.categoryId, amount: minor, alert_pct: alert });
    },
    onSuccess: () => {
      toast("Budget saved");
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => (editing.categoryId === null ? put("/budgets/overall", { amount: null }) : del(`/budgets/${editing.categoryId}`)),
    onSuccess: () => {
      toast("Budget removed");
      refresh();
      onClose();
    },
  });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="block">
        <Label>Amount per month</Label>
        <div className="relative">
          <input inputMode="decimal" className="field h-14 pr-10 text-2xl font-semibold num" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xl text-ink-3">₼</span>
        </div>
      </label>
      {editing.categoryId !== null && (
        <label className="block">
          <Label hint="(Telegram alert)">Warn me at {alert}% of the budget</Label>
          <input type="range" min={50} max={100} step={5} value={alert} onChange={(e) => setAlert(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
        </label>
      )}
      <ErrorNote error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" className="flex-1" loading={save.isPending}>
          Save budget
        </Button>
        {editing.amount ? (
          <Button type="button" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </Button>
        ) : null}
      </div>
    </form>
  );
}
