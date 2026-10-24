import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Sparkles, AlertCircle, Smartphone, ArrowRight } from "lucide-react";
import type { Account, BudgetStatus, Transaction } from "@shared/types";
import { addDays, daysBetween, formatMoney, localDate, shiftPeriod } from "@shared/money";
import { get } from "../lib/api";
import { useBootstrap, useCategories } from "../lib/data";
import { Empty, Money, Section, Spinner, clsx } from "../lib/ui";
import { BarList, Meter, PaceChart } from "../components/charts";
import { TxEditor, TxList } from "../components/Transactions";

interface DashboardData {
  period: { start: string; end: string; label: string; is_current: boolean; elapsed_days: number; total_days: number };
  totals: { spent: number; income: number; count: number };
  prev_same_point: { spent: number };
  prev_full: { spent: number };
  avg_daily_spent: number;
  safe_to_spend_per_day: number | null;
  categories: { category_id: number; spent: number; children: { category_id: number; spent: number }[] }[];
  daily: { date: string; spent: number; income: number }[];
  top_merchants: { merchant_id: number; name: string; spent: number; count: number; category_id: number | null }[];
  recent: Transaction[];
  accounts: Account[];
  budgets: { overall: BudgetStatus | null; categories: BudgetStatus[]; total_spent: number };
  counts: { review: number; failed: number; uncategorized: number };
  insight: { id: number; title: string; headline: string; created_at: string; tips: { title: string; potential_monthly_savings: number | null }[] } | null;
}

export default function Dashboard() {
  const boot = useBootstrap();
  const settings = boot.data?.settings;
  const today = localDate(new Date(), settings?.tz_offset_minutes ?? 240);
  const [anchor, setAnchor] = useState(today);
  const q = useQuery({
    queryKey: ["dashboard", anchor],
    queryFn: () => get<DashboardData>(`/analytics/dashboard?date=${anchor}`),
    placeholderData: (prev) => prev,
  });
  const [open, setOpen] = useState<Transaction | null>(null);
  const navigate = useNavigate();
  const cats = useCategories();
  const d = q.data;

  const days = useMemo(() => {
    if (!d) return [];
    const byDate = new Map(d.daily.map((x) => [x.date, x.spent]));
    const out: { date: string; spent: number }[] = [];
    for (let day = d.period.start; day <= d.period.end; day = addDays(day, 1)) out.push({ date: day, spent: byDate.get(day) ?? 0 });
    return out;
  }, [d]);

  if (!d || !settings) return q.error ? <Empty title="Couldn't load your overview">{String(q.error)}</Empty> : <Spinner />;

  const startDay = settings.month_start_day;
  const go = (delta: number) => setAnchor(shiftPeriod(d.period.start, startDay, delta).start);
  const overall = d.budgets.overall;
  const deltaPct = d.prev_same_point.spent > 0 ? Math.round(((d.totals.spent - d.prev_same_point.spent) / d.prev_same_point.spent) * 100) : null;
  const remainingDays = d.period.is_current ? daysBetween(today, d.period.end) + 1 : 0;
  const noData = (boot.data?.counts.transactions ?? 0) === 0;

  return (
    <div className={clsx("transition-opacity", q.isFetching && q.isPlaceholderData && "opacity-60")}>
      {/* Period switcher */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button onClick={() => go(-1)} className="rounded-full p-2 text-ink-2 hover:bg-surface-2" aria-label="Previous period">
            <ChevronLeft size={20} />
          </button>
          <span className="min-w-28 text-center font-medium">{d.period.label}</span>
          <button
            onClick={() => go(1)}
            disabled={d.period.is_current}
            className="rounded-full p-2 text-ink-2 hover:bg-surface-2 disabled:opacity-30"
            aria-label="Next period"
          >
            <ChevronRight size={20} />
          </button>
        </div>
        {!d.period.is_current && (
          <button onClick={() => setAnchor(today)} className="text-sm font-medium text-accent">
            Back to now
          </button>
        )}
      </div>

      {noData && <ConnectPrompt />}

      <div className="mt-2 grid gap-x-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          {/* Hero: what's left (or what's spent when there's no budget) */}
          <section className="rounded-3xl border border-line bg-surface px-5 pb-4 pt-5 sm:px-7">
            {overall ? (
              <>
                <p className="text-ink-2">{overall.remaining >= 0 ? "Left to spend" : "Over budget by"}</p>
                <p className={clsx("mt-1 text-[52px] font-semibold leading-none tracking-tight", overall.remaining < 0 && "text-bad")}>
                  {formatMoney(Math.abs(overall.remaining), "AZN", { decimals: Math.abs(overall.remaining) < 100000 })}
                </p>
                <p className="mt-3 text-[15px] text-ink-2">
                  {d.period.is_current ? (
                    overall.remaining > 0 && d.safe_to_spend_per_day !== null ? (
                      <>
                        That's <strong className="font-semibold text-ink num">{formatMoney(d.safe_to_spend_per_day)}</strong> a day for the next{" "}
                        {remainingDays} {remainingDays === 1 ? "day" : "days"}.
                      </>
                    ) : (
                      <>Try to keep the rest of {d.period.label} to essentials.</>
                    )
                  ) : (
                    <>
                      You spent <span className="num">{formatMoney(overall.spent)}</span> of <span className="num">{formatMoney(overall.amount)}</span>.
                    </>
                  )}
                </p>
              </>
            ) : (
              <>
                <p className="text-ink-2">Spent {d.period.is_current ? "so far" : ""} in {d.period.label}</p>
                <p className="mt-1 text-[52px] font-semibold leading-none tracking-tight">
                  {formatMoney(d.totals.spent, "AZN", { decimals: d.totals.spent < 100000 })}
                </p>
                <p className="mt-3 text-[15px] text-ink-2">
                  <Link to="/budgets" className="font-medium text-accent">
                    Set a monthly budget
                  </Link>{" "}
                  to see how much you can still spend each day.
                </p>
              </>
            )}
            <div className="mt-5">
              <PaceChart days={days} today={today} dailyBudget={overall ? Math.round(overall.amount / d.period.total_days) : null} />
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-3 border-t border-line pt-4 text-sm">
              <Stat label="Spent" value={<Money value={d.totals.spent} />} />
              <Stat label="Income" value={<Money value={d.totals.income} />} />
              <Stat
                label={d.period.is_current ? "vs last month" : "vs month before"}
                value={
                  deltaPct === null ? (
                    "—"
                  ) : (
                    <span className={clsx(deltaPct > 5 ? "text-bad" : deltaPct < -5 ? "text-good" : "")}>
                      {deltaPct > 0 ? "+" : ""}
                      {deltaPct}%
                    </span>
                  )
                }
              />
            </dl>
          </section>

          <Attention review={d.counts.review} failed={d.counts.failed} />

          <Section
            title="Where it went"
            action={
              <Link to="/analytics" className="text-sm font-medium text-accent">
                Analytics
              </Link>
            }
          >
            {d.categories.length ? (
              <div className="rounded-2xl border border-line bg-surface p-2">
                <BarList
                  total={d.totals.spent}
                  rows={d.categories.slice(0, 8).map((c) => ({
                    key: c.category_id,
                    icon: cats.info(c.category_id)?.icon,
                    label: cats.info(c.category_id)?.name ?? "Uncategorized",
                    value: c.spent,
                    sub: c.children
                      .slice(0, 3)
                      .map((x) => `${cats.info(x.category_id)?.name} ${formatMoney(x.spent, "AZN", { decimals: false })}`)
                      .join(" · "),
                  }))}
                  onSelect={(id) => navigate(`/activity?category=${id}&from=${d.period.start}&to=${d.period.end}`)}
                />
              </div>
            ) : (
              <Empty title="No spending yet this period" />
            )}
          </Section>

          <Section
            title="Latest"
            action={
              <Link to="/activity" className="text-sm font-medium text-accent">
                See all
              </Link>
            }
          >
            {d.recent.length ? (
              <TxList items={d.recent} onOpen={setOpen} tz={settings.tz_offset_minutes} />
            ) : (
              <Empty title="Nothing here yet">Transactions appear here as soon as your phone forwards a bank message, or when you add one with +.</Empty>
            )}
          </Section>
        </div>

        <aside className="min-w-0">
          <Section title="Cards" className="lg:mt-0">
            <div className="scroll-x -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:px-0">
              {d.accounts.map((a) => (
                <Link
                  to="/accounts"
                  key={a.id}
                  className="min-w-44 shrink-0 rounded-2xl border border-line bg-surface px-4 py-3 hover:bg-surface-2 lg:min-w-0"
                >
                  <span className="flex items-center gap-2 text-sm text-ink-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.color ?? "var(--accent)" }} />
                    {a.name}
                  </span>
                  <span className="mt-1 block text-lg font-semibold num">{a.balance !== null ? formatMoney(a.balance, a.currency) : "—"}</span>
                  {a.balance_at && <span className="block text-[12px] text-ink-3">as of {a.balance_at.slice(0, 10)}</span>}
                </Link>
              ))}
            </div>
          </Section>

          <Section
            title="Budgets"
            action={
              <Link to="/budgets" className="text-sm font-medium text-accent">
                Manage
              </Link>
            }
          >
            {d.budgets.categories.length ? (
              <ul className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4">
                {d.budgets.categories.slice(0, 5).map((b) => (
                  <li key={b.category_id}>
                    <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate">
                        {cats.info(b.category_id)?.icon} {cats.info(b.category_id)?.name}
                      </span>
                      <span className="num shrink-0 text-ink-2">
                        <span className={clsx("font-medium", b.status === "over" ? "text-bad" : "text-ink")}>{formatMoney(b.spent, "AZN", { decimals: false })}</span>
                        {" / "}
                        {formatMoney(b.amount, "AZN", { decimals: false })}
                      </span>
                    </div>
                    <Meter
                      spent={b.spent}
                      amount={b.amount}
                      status={b.status}
                      paceFraction={d.period.is_current ? d.period.elapsed_days / d.period.total_days : null}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="No category budgets" action={<Link to="/budgets" className="font-medium text-accent">Create budgets</Link>}>
                Budgets show how each category is doing during the month.
              </Empty>
            )}
          </Section>

          <Section title="AI coach">
            <InsightTeaser insight={d.insight} />
          </Section>

          {d.top_merchants.length > 0 && (
            <Section title="Top places">
              <ol className="divide-y divide-line rounded-2xl border border-line bg-surface">
                {d.top_merchants.map((m) => (
                  <li key={m.merchant_id}>
                    <Link to={`/activity?merchant=${m.merchant_id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                      <span className="w-6 text-center" aria-hidden>
                        {cats.info(m.category_id)?.icon ?? "🏷️"}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <span className="text-[13px] text-ink-3">{m.count}×</span>
                      <span className="num font-medium">{formatMoney(m.spent, "AZN", { decimals: false })}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            </Section>
          )}
        </aside>
      </div>
      <TxEditor tx={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-3">{label}</dt>
      <dd className="mt-0.5 font-semibold">{value}</dd>
    </div>
  );
}

function Attention({ review, failed }: { review: number; failed: number }) {
  if (!review && !failed) return null;
  return (
    <div className="mt-4 flex flex-col gap-2">
      {review > 0 && (
        <Link to="/activity?review=1" className="flex items-center gap-3 rounded-2xl bg-warn-soft px-4 py-3 hover:brightness-[0.98]">
          <Sparkles size={18} className="shrink-0 text-warn" aria-hidden />
          <span className="flex-1 text-sm">
            <strong className="font-semibold">{review}</strong> {review === 1 ? "transaction was" : "transactions were"} categorized by AI with low certainty. A quick check
            teaches the app.
          </span>
          <ArrowRight size={16} aria-hidden />
        </Link>
      )}
      {failed > 0 && (
        <Link to="/inbox" className="flex items-center gap-3 rounded-2xl bg-bad-soft px-4 py-3 hover:brightness-[0.98]">
          <AlertCircle size={18} className="shrink-0 text-bad" aria-hidden />
          <span className="flex-1 text-sm">
            <strong className="font-semibold">{failed}</strong> bank {failed === 1 ? "message" : "messages"} couldn't be read automatically.
          </span>
          <ArrowRight size={16} aria-hidden />
        </Link>
      )}
    </div>
  );
}

function ConnectPrompt() {
  return (
    <Link to="/settings#phone" className="mt-3 flex items-start gap-3 rounded-2xl border border-accent bg-accent-soft px-4 py-4">
      <Smartphone size={22} className="mt-0.5 shrink-0 text-accent" aria-hidden />
      <span>
        <span className="block font-semibold">Connect your phone to start</span>
        <span className="block text-sm text-ink-2">
          Your phone forwards ABB's card messages here, so every payment is recorded automatically. It takes about 5 minutes.
        </span>
      </span>
    </Link>
  );
}

function InsightTeaser({ insight }: { insight: DashboardData["insight"] }) {
  if (!insight)
    return (
      <Link to="/insights" className="block rounded-2xl border border-line bg-surface px-4 py-4 hover:bg-surface-2">
        <span className="flex items-center gap-2 font-medium">
          <Sparkles size={16} className="text-accent" aria-hidden /> Get your first spending review
        </span>
        <span className="mt-1 block text-sm text-ink-2">AI looks at your habits and suggests where to save. Reports also arrive automatically every week and month.</span>
      </Link>
    );
  return (
    <Link to="/insights" className="block rounded-2xl border border-line bg-surface px-4 py-4 hover:bg-surface-2">
      <span className="block text-[13px] text-ink-3">{insight.title}</span>
      <span className="mt-1 block font-medium leading-snug">{insight.headline}</span>
      {insight.tips.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5 text-sm text-ink-2">
          {insight.tips.map((t) => (
            <li key={t.title} className="flex gap-2">
              <span className="text-accent" aria-hidden>
                •
              </span>
              <span>
                {t.title}
                {t.potential_monthly_savings ? (
                  <span className="text-good num"> · save ~{formatMoney(Math.round(t.potential_monthly_savings * 100), "AZN", { decimals: false })}/mo</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Link>
  );
}
