import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { Transaction } from "@shared/types";
import { addDays, formatDay, formatMoney, localDate, shiftPeriod } from "@shared/money";
import { get } from "../lib/api";
import { useBootstrap, useCategories } from "../lib/data";
import { Empty, Section, Segmented, Spinner, clsx } from "../lib/ui";
import { PageHeader } from "../components/Layout";
import { BarList, Heatmap, Sparkline, TrendColumns } from "../components/charts";

interface TrendPeriod {
  start: string;
  end: string;
  label: string;
  income: number;
  spent: number;
  net: number;
  by_category: Record<number, number>;
}
interface Recurring {
  merchant_id: number;
  name: string;
  category_id: number | null;
  cadence: string;
  amount: number;
  variable: boolean;
  count: number;
  last_date: string;
  next_date: string;
  monthly_cost: number;
  active: boolean;
}

type Range = "month" | "last" | "3m" | "12m" | "custom";

export default function Analytics() {
  const boot = useBootstrap();
  const cats = useCategories();
  const navigate = useNavigate();
  const settings = boot.data?.settings;
  const today = localDate(new Date(), settings?.tz_offset_minutes ?? 240);
  const startDay = settings?.month_start_day ?? 1;
  const [range, setRange] = useState<Range>("month");
  const [custom, setCustom] = useState({ from: addDays(today, -29), to: today });
  const { from, to } = useMemo(() => {
    if (range === "custom") return custom.from <= custom.to ? custom : { from: custom.to, to: custom.from };
    if (range === "month") return { from: shiftPeriod(today, startDay, 0).start, to: today };
    if (range === "last") {
      const p = shiftPeriod(today, startDay, -1);
      return { from: p.start, to: p.end };
    }
    if (range === "3m") return { from: shiftPeriod(today, startDay, -2).start, to: today };
    return { from: shiftPeriod(today, startDay, -11).start, to: today };
  }, [range, today, startDay, custom]);

  const trends = useQuery({ queryKey: ["trends"], queryFn: () => get<TrendPeriod[]>("/analytics/trends?periods=12") });
  const recurring = useQuery({ queryKey: ["recurring"], queryFn: () => get<Recurring[]>("/analytics/recurring") });
  const categories = useQuery({
    queryKey: ["an-categories", from, to],
    queryFn: () => get<{ category_id: number; spent: number; children: { category_id: number; spent: number }[] }[]>(`/analytics/categories?from=${from}&to=${to}`),
    placeholderData: (p) => p,
  });
  const merchants = useQuery({
    queryKey: ["an-merchants", from, to],
    queryFn: () => get<{ merchant_id: number; name: string; category_id: number | null; spent: number; count: number; avg: number; last_date: string }[]>(`/analytics/merchants?from=${from}&to=${to}`),
    placeholderData: (p) => p,
  });
  const heat = useQuery({
    queryKey: ["an-heat", from, to],
    queryFn: () => get<{ weekday: number; hour: number; spent: number; count: number }[]>(`/analytics/heatmap?from=${from}&to=${to}`),
    placeholderData: (p) => p,
  });
  const odd = useQuery({
    queryKey: ["an-odd", from, to],
    queryFn: () => get<(Transaction & { typical: number | null })[]>(`/analytics/anomalies?from=${from}&to=${to}`),
    placeholderData: (p) => p,
  });

  const periods = (trends.data ?? []).filter((p, i, all) => p.spent > 0 || p.income > 0 || i === all.length - 1);
  const totalSpent = categories.data?.reduce((s, c) => s + c.spent, 0) ?? 0;
  const activeSubs = (recurring.data ?? []).filter((r) => r.active);
  const subsMonthly = activeSubs.reduce((s, r) => s + r.monthly_cost, 0);
  const refetching = categories.isFetching || merchants.isFetching;

  const categoryRows = useMemo(() => {
    if (!trends.data?.length) return [];
    const ids = new Set<number>();
    for (const p of trends.data) for (const id of Object.keys(p.by_category)) ids.add(Number(id));
    return [...ids]
      .map((id) => {
        const series = trends.data!.map((p) => Math.max(0, p.by_category[id] ?? 0));
        const current = series[series.length - 1];
        const history = series.slice(0, -1).filter((v) => v > 0);
        const avg = history.length ? history.reduce((a, b) => a + b, 0) / history.length : 0;
        return { id, series, current, avg };
      })
      .filter((r) => r.series.some((v) => v > 0))
      .sort((a, b) => b.avg + b.current - (a.avg + a.current))
      .slice(0, 10);
  }, [trends.data]);

  return (
    <div>
      <PageHeader title="Analytics" subtitle="Where your money goes, and how it changes" />

      <Section title="Month by month" className="mt-5">
        <div className="rounded-2xl border border-line bg-surface p-4">
          {trends.isLoading ? <Spinner /> : periods.length ? <TrendColumns periods={periods} /> : <Empty title="Not enough history yet" />}
        </div>
        {categoryRows.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-ink-3">
                  <th className="px-4 py-2.5 font-medium">Category</th>
                  <th className="px-2 py-2.5 text-right font-medium">This month</th>
                  <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">Usual</th>
                  <th className="px-4 py-2.5 text-right font-medium">12 months</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {categoryRows.map((r) => {
                  const info = cats.info(r.id);
                  const change = r.avg > 0 ? (r.current - r.avg) / r.avg : 0;
                  return (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5">
                        <span className="mr-1.5" aria-hidden>
                          {info?.icon}
                        </span>
                        {info?.name ?? "Uncategorized"}
                      </td>
                      <td className={clsx("num px-2 py-2.5 text-right font-medium", change > 0.25 && r.current > 2000 && "text-bad")}>
                        {formatMoney(r.current, "AZN", { decimals: false })}
                      </td>
                      <td className="num hidden px-2 py-2.5 text-right text-ink-2 sm:table-cell">{formatMoney(Math.round(r.avg), "AZN", { decimals: false })}</td>
                      <td className="px-4 py-1.5 text-right">
                        <span className="inline-block align-middle">
                          <Sparkline values={r.series} />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Subscriptions and regular bills">
        {recurring.isLoading ? (
          <Spinner />
        ) : activeSubs.length === 0 ? (
          <Empty title="None found yet">Payments that repeat every week, month or year show up here once they've happened a few times.</Empty>
        ) : (
          <div className="rounded-2xl border border-line bg-surface">
            <p className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm text-ink-2">
              <RefreshCw size={15} aria-hidden />
              About <strong className="num text-ink">{formatMoney(subsMonthly, "AZN", { decimals: false })}</strong> a month,{" "}
              <strong className="num text-ink">{formatMoney(subsMonthly * 12, "AZN", { decimals: false })}</strong> a year.
            </p>
            <ul className="divide-y divide-line">
              {activeSubs.map((r) => (
                <li key={r.merchant_id}>
                  <button onClick={() => navigate(`/activity?merchant=${r.merchant_id}`)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2">
                    <span className="w-6 text-center text-lg" aria-hidden>
                      {cats.info(r.category_id)?.icon ?? "🔁"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.name}</span>
                      <span className="block text-[13px] text-ink-3">
                        {r.cadence}
                        {r.variable ? ", amount varies" : ""} · next around {formatDay(r.next_date)}
                      </span>
                    </span>
                    <span className="num font-medium">
                      {r.variable ? "~" : ""}
                      {formatMoney(r.amount)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* Everything below follows this range */}
      <div className="sticky top-0 z-20 -mx-4 mt-10 border-b border-line bg-paper/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
        <div className="scroll-x -mx-4 overflow-x-auto px-4">
          <Segmented
            value={range}
            onChange={setRange}
            options={[
              { value: "month", label: "This month" },
              { value: "last", label: "Last month" },
              { value: "3m", label: "3 months" },
              { value: "12m", label: "12 months" },
              { value: "custom", label: "Custom" },
            ]}
          />
        </div>
        {range === "custom" ? (
          <div className="mt-2 flex max-w-md items-center gap-2">
            <input
              type="date"
              className="field min-h-10 py-1.5"
              value={custom.from}
              max={today}
              onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })}
              aria-label="From"
            />
            <span className="text-ink-3">–</span>
            <input
              type="date"
              className="field min-h-10 py-1.5"
              value={custom.to}
              max={today}
              onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })}
              aria-label="To"
            />
          </div>
        ) : (
          <p className="mt-1.5 text-[13px] text-ink-3">
            {formatDay(from, true)} – {formatDay(to, true)}
          </p>
        )}
      </div>

      <div className={clsx("transition-opacity", refetching && "opacity-60")}>
        <Section title="By category" className="mt-6">
          {categories.data?.length ? (
            <div className="rounded-2xl border border-line bg-surface p-2">
              <BarList
                total={totalSpent}
                rows={categories.data.map((c) => ({
                  key: c.category_id,
                  icon: cats.info(c.category_id)?.icon,
                  label: cats.info(c.category_id)?.name ?? "Uncategorized",
                  value: c.spent,
                  sub: c.children
                    .slice(0, 4)
                    .map((x) => `${cats.info(x.category_id)?.name} ${formatMoney(x.spent, "AZN", { decimals: false })}`)
                    .join(" · "),
                }))}
                onSelect={(id) => navigate(`/activity?category=${id}&from=${from}&to=${to}`)}
              />
            </div>
          ) : (
            <Empty title="No spending in this range" />
          )}
        </Section>

        <Section title="When you spend">
          <div className="rounded-2xl border border-line bg-surface p-4">{heat.data ? <Heatmap cells={heat.data} /> : <Spinner />}</div>
        </Section>

        <Section title="Top merchants">
          {merchants.data?.length ? (
            <div className="overflow-hidden rounded-2xl border border-line bg-surface">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-ink-3">
                    <th className="px-4 py-2.5 font-medium">Merchant</th>
                    <th className="px-2 py-2.5 text-right font-medium">Visits</th>
                    <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">Average</th>
                    <th className="px-4 py-2.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {merchants.data.slice(0, 20).map((m) => (
                    <tr key={m.merchant_id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate(`/activity?merchant=${m.merchant_id}&from=${from}&to=${to}`)}>
                      <td className="px-4 py-2.5">
                        <span className="mr-1.5" aria-hidden>
                          {cats.info(m.category_id)?.icon ?? "🏷️"}
                        </span>
                        {m.name}
                      </td>
                      <td className="num px-2 py-2.5 text-right text-ink-2">{m.count}</td>
                      <td className="num hidden px-2 py-2.5 text-right text-ink-2 sm:table-cell">{formatMoney(m.avg)}</td>
                      <td className="num px-4 py-2.5 text-right font-medium">{formatMoney(m.spent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No merchants in this range" />
          )}
        </Section>

        {odd.data && odd.data.length > 0 && (
          <Section title="Unusually large payments">
            <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
              {odd.data.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{t.merchant_name ?? t.merchant_raw}</span>
                    <span className="block text-[13px] text-ink-3">
                      {formatDay(t.local_date, true)}
                      {t.typical ? ` · usually ${formatMoney(t.typical)} there` : " · first time this large"}
                    </span>
                  </span>
                  <span className="num font-semibold">{formatMoney(-t.amount_base)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
      <p className="mt-8 text-center text-[13px] text-ink-3">Transfers between your own cards and items you've left out of statistics are not counted.</p>
    </div>
  );
}
