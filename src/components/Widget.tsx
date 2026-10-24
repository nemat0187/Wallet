import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import type { QueryResult, Widget } from "@shared/widgets";
import { resolveRange, TIME_GROUPS } from "@shared/widgets";
import { formatDay } from "@shared/money";
import { post } from "../lib/api";
import { useCategories } from "../lib/data";
import { Spinner, clsx } from "../lib/ui";
import { BarList, ColumnChart, DonutChart, Heatmap, LineChart, countFmt, moneyFmt, type Fmt } from "./charts";

export function widgetRange(w: Pick<Widget, "range" | "from" | "to">, today: string, monthStartDay: number) {
  return resolveRange(w.range, today, monthStartDay, { from: w.from, to: w.to });
}

export function useWidgetData(w: Widget, today: string, monthStartDay: number) {
  const { from, to } = widgetRange(w, today, monthStartDay);
  const body = { metric: w.metric, group_by: w.group_by, from, to, filters: w.filters, limit: w.limit, compare: w.compare };
  return useQuery({
    queryKey: ["widget", body],
    queryFn: () => post<QueryResult>("/analytics/query", body),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

export function WidgetCard({
  widget,
  today,
  monthStartDay,
  onMenu,
  className,
}: {
  widget: Widget;
  today: string;
  monthStartDay: number;
  onMenu?: () => void;
  className?: string;
}) {
  const q = useWidgetData(widget, today, monthStartDay);
  const { from, to } = widgetRange(widget, today, monthStartDay);
  const rangeText = from <= "2001-01-01" ? "All time" : `${formatDay(from, from.slice(0, 4) !== to.slice(0, 4))} – ${formatDay(to, true)}`;
  return (
    <section className={clsx("min-w-0 rounded-2xl border border-line bg-surface p-4", widget.size === "full" && "md:col-span-2", className)}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{widget.title || "Untitled widget"}</h3>
          <p className="text-[13px] text-ink-3">{rangeText}</p>
        </div>
        {onMenu && (
          <button onClick={onMenu} className="-mr-2 -mt-1 rounded-full p-2 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={`Options for ${widget.title}`}>
            <MoreHorizontal size={18} />
          </button>
        )}
      </header>
      <div className={clsx("transition-opacity", q.isFetching && q.isPlaceholderData && "opacity-60")}>
        {q.data ? <WidgetBody widget={widget} data={q.data} /> : q.error ? <p className="text-sm text-bad">{String((q.error as Error).message)}</p> : <Spinner />}
      </div>
    </section>
  );
}

export function WidgetBody({ widget, data }: { widget: Widget; data: QueryResult }) {
  const navigate = useNavigate();
  const cats = useCategories();
  const format: Fmt = widget.metric === "count" ? countFmt : moneyFmt;
  // Shares only make sense when rows add up to the total (a transaction can carry several tags).
  const additive = widget.metric !== "average" && widget.metric !== "net" && widget.group_by !== "tag";
  const rows = data.rows;
  const empty = data.count === 0;

  if (widget.chart === "number" || widget.group_by === "none") {
    const delta = data.previous_total !== null && data.previous_total !== 0 ? Math.round(((data.total - data.previous_total) / Math.abs(data.previous_total)) * 100) : null;
    const upIsBad = widget.metric === "spent" || widget.metric === "flow_out" || widget.metric === "average";
    return (
      <div>
        <p className={clsx("text-[40px] font-semibold leading-none tracking-tight", widget.metric === "net" && data.total < 0 && "text-bad")}>{format(data.total)}</p>
        <p className="mt-2 text-sm text-ink-2">
          {data.count} {data.count === 1 ? "transaction" : "transactions"}
          {delta !== null && (
            <span className={clsx("ml-2 font-medium", delta === 0 ? "" : (delta > 0) === upIsBad ? "text-bad" : "text-good")}>
              {delta > 0 ? "+" : ""}
              {delta}% vs previous period
            </span>
          )}
        </p>
      </div>
    );
  }
  if (empty) return <p className="py-6 text-center text-sm text-ink-3">No transactions match in this period.</p>;

  const select = (key: string | number) => {
    const k = String(key);
    if (k === "__other") return;
    const range = `from=${data.from > "2001-01-01" ? data.from : ""}&to=${data.to}`;
    if (widget.group_by === "category" || widget.group_by === "subcategory") navigate(`/activity?category=${k}&${range}`);
    else if (widget.group_by === "account") navigate(`/activity?account=${k}&${range}`);
    else if (widget.group_by === "merchant") navigate(`/activity?q=${encodeURIComponent(k)}&${range}`);
  };
  const icon = (key: string) => (widget.group_by === "category" || widget.group_by === "subcategory" ? cats.info(Number(key))?.icon : undefined);

  switch (widget.chart) {
    case "bar":
      return (
        <BarList
          rows={rows.map((r) => ({ key: r.key, label: r.label, value: r.value, icon: icon(r.key) }))}
          total={additive ? data.total : undefined}
          format={format}
          onSelect={["category", "subcategory", "account", "merchant"].includes(widget.group_by) ? select : undefined}
        />
      );
    case "column":
      return <ColumnChart rows={rows} format={format} />;
    case "line":
    case "area":
      return <LineChart rows={rows} format={format} area={widget.chart === "area"} />;
    case "donut":
      return <DonutChart rows={rows} format={format} centerLabel={additive ? "total" : ""} />;
    case "heatmap":
      if (widget.group_by !== "weekday_hour") return <p className="text-sm text-ink-3">A heatmap needs the grouping “Day of week × hour”.</p>;
      return <Heatmap cells={rows.map((r) => ({ weekday: r.weekday ?? 0, hour: r.hour ?? 0, spent: r.value, count: r.count }))} />;
    case "table":
    default:
      return (
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line text-left text-ink-3">
                <th className="py-2 pr-2 font-medium">{TIME_GROUPS.includes(widget.group_by) ? "Period" : "Name"}</th>
                <th className="px-2 py-2 text-right font-medium">Count</th>
                <th className="py-2 pl-2 text-right font-medium">Value</th>
                {additive && <th className="hidden py-2 pl-2 text-right font-medium sm:table-cell">Share</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.key} className={clsx(["category", "subcategory", "account", "merchant"].includes(widget.group_by) && r.key !== "__other" && "cursor-pointer hover:bg-surface-2")} onClick={() => select(r.key)}>
                  <td className="py-2 pr-2">
                    {icon(r.key) && <span className="mr-1.5">{icon(r.key)}</span>}
                    {r.label}
                  </td>
                  <td className="num px-2 py-2 text-right text-ink-2">{r.count}</td>
                  <td className="num py-2 pl-2 text-right font-medium">{format(r.value)}</td>
                  {additive && <td className="num hidden py-2 pl-2 text-right text-ink-3 sm:table-cell">{data.total ? Math.round((r.value / data.total) * 100) : 0}%</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}
