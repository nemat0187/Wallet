import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ChartType, GroupBy, RangePreset, Widget } from "@shared/widgets";
import { CHARTS, GROUPS, METRICS, RANGES, TIME_GROUPS, suggestedChart } from "@shared/widgets";
import { parseAmount } from "@shared/money";
import { useAccounts } from "../lib/data";
import { Button, Chip, Label, Segmented, Sheet, Toggle, clsx } from "../lib/ui";
import { CategoryMultiPicker } from "./CategoryPicker";
import { WidgetCard } from "./Widget";

/** Charts that can draw a grouping. Everything else is greyed out. */
export function chartFits(chart: ChartType, group: GroupBy): boolean {
  if (group === "weekday_hour") return chart === "heatmap" || chart === "table" || chart === "number";
  if (chart === "heatmap") return false;
  if (group === "none") return chart === "number";
  return true;
}

export function autoTitle(w: Pick<Widget, "metric" | "group_by">): string {
  const metric = METRICS.find((m) => m.value === w.metric)?.label.replace(/ \(.*\)$/, "") ?? "Spending";
  if (w.group_by === "none") return metric;
  const group = GROUPS.find((g) => g.value === w.group_by)?.label.replace(/ \(.*\)$/, "").toLowerCase() ?? "";
  return `${metric} by ${group}`;
}

export function WidgetEditor({
  widget,
  isNew,
  today,
  monthStartDay,
  onSave,
  onDelete,
  onClose,
}: {
  widget: Widget | null;
  isNew: boolean;
  today: string;
  monthStartDay: number;
  onSave: (w: Widget) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [w, setW] = useState<Widget | null>(widget);
  const [showFilters, setShowFilters] = useState(false);
  const accounts = useAccounts();
  useEffect(() => {
    setW(widget);
    const f = widget?.filters ?? {};
    setShowFilters(Boolean(f.category_ids?.length || f.account_ids?.length || f.merchant || f.tag || f.min_amount || f.max_amount || f.include_excluded));
  }, [widget]);
  if (!w) return null;

  const set = (patch: Partial<Widget>) => setW({ ...w, ...patch });
  const setFilter = (patch: Partial<Widget["filters"]>) => setW({ ...w, filters: { ...w.filters, ...patch } });
  const setGroup = (group_by: GroupBy) => set({ group_by, chart: chartFits(w.chart, group_by) && w.chart !== "number" ? w.chart : suggestedChart(group_by) });
  const setRange = (range: RangePreset) => set(range === "custom" ? { range, from: w.from ?? today.slice(0, 8) + "01", to: w.to ?? today } : { range });
  const preview = { ...w, title: w.title || autoTitle(w) };
  const ranked = !TIME_GROUPS.includes(w.group_by) && !["none", "weekday", "hour", "weekday_hour"].includes(w.group_by);
  const filterCount =
    (w.filters.category_ids?.length ? 1 : 0) +
    (w.filters.account_ids?.length ? 1 : 0) +
    (w.filters.merchant ? 1 : 0) +
    (w.filters.tag ? 1 : 0) +
    (w.filters.min_amount || w.filters.max_amount ? 1 : 0) +
    (w.filters.include_excluded ? 1 : 0);

  return (
    <Sheet
      open
      wide
      onClose={onClose}
      title={isNew ? "New widget" : "Edit widget"}
      footer={
        <div className="flex gap-2">
          {onDelete && !isNew && (
            <Button variant="danger" onClick={onDelete}>
              Delete
            </Button>
          )}
          <Button className="ml-auto" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(preview)}>
            {isNew ? "Add widget" : "Save"}
          </Button>
        </div>
      }
    >
      {/* Stays in view while the settings below scroll, so every change shows right away. */}
      <div className="sticky top-0 z-10 -mx-5 bg-surface px-5 pb-3">
        <div className="max-h-[36dvh] overflow-y-auto rounded-2xl bg-paper p-2 sm:max-h-[42dvh]">
          <WidgetCard widget={{ ...preview, size: "half" }} today={today} monthStartDay={monthStartDay} />
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-5">
        <label className="block">
          <Label>Title</Label>
          <input className="field" value={w.title} placeholder={autoTitle(w)} maxLength={80} onChange={(e) => set({ title: e.target.value })} />
        </label>

        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block">
            <Label>What to measure</Label>
            <select className="field" value={w.metric} onChange={(e) => set({ metric: e.target.value as Widget["metric"] })}>
              {METRICS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[13px] text-ink-3">{METRICS.find((m) => m.value === w.metric)?.hint}</span>
          </label>
          <label className="block">
            <Label>Split by</Label>
            <select className="field" value={w.group_by} onChange={(e) => setGroup(e.target.value as GroupBy)}>
              {GROUPS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <Label>Chart</Label>
          <div className="flex flex-wrap gap-2">
            {CHARTS.map((c) => (
              <Chip key={c.value} active={w.chart === c.value} disabled={!chartFits(c.value, w.group_by)} onClick={() => set({ chart: c.value })}>
                {c.label}
              </Chip>
            ))}
          </div>
          {w.group_by === "none" && <p className="mt-1.5 text-[13px] text-ink-3">Choose something to split by to draw a chart.</p>}
        </div>

        <div>
          <Label>Period</Label>
          <select className="field" value={w.range} onChange={(e) => setRange(e.target.value as RangePreset)}>
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {w.range === "custom" && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label>
                <span className="mb-1 block text-[13px] text-ink-3">From</span>
                <input type="date" className="field" value={w.from ?? ""} max={w.to} onChange={(e) => set({ from: e.target.value || undefined })} />
              </label>
              <label>
                <span className="mb-1 block text-[13px] text-ink-3">To</span>
                <input type="date" className="field" value={w.to ?? ""} min={w.from} onChange={(e) => set({ to: e.target.value || undefined })} />
              </label>
            </div>
          )}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {ranked && (
            <label className="block">
              <Label>Show top</Label>
              <select className="field" value={w.limit} onChange={(e) => set({ limit: Number(e.target.value) })}>
                {[3, 5, 8, 10, 15, 20, 30, 50].map((n) => (
                  <option key={n} value={n}>
                    {n}, the rest as “Other”
                  </option>
                ))}
              </select>
            </label>
          )}
          <div>
            <Label>Width</Label>
            <Segmented
              value={w.size}
              onChange={(size) => set({ size })}
              options={[
                { value: "half", label: "Half" },
                { value: "full", label: "Full width" },
              ]}
            />
          </div>
        </div>

        {(w.chart === "number" || w.group_by === "none") && (
          <Toggle checked={w.compare} onChange={(compare) => set({ compare })} label="Compare with the period before" hint="Shows the change in % against the same number of days just before." />
        )}

        <div className="rounded-2xl border border-line">
          <button type="button" onClick={() => setShowFilters((s) => !s)} className="flex w-full items-center justify-between px-4 py-3 text-left" aria-expanded={showFilters}>
            <span className="font-medium">
              Filters
              {filterCount > 0 && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[13px] text-ink">{filterCount} on</span>}
            </span>
            <ChevronDown size={18} className={clsx("text-ink-3 transition-transform", showFilters && "rotate-180")} aria-hidden />
          </button>
          {showFilters && (
            <div className="flex flex-col gap-5 border-t border-line px-4 py-4">
              <div>
                <Label>Only these categories</Label>
                <CategoryMultiPicker value={w.filters.category_ids ?? []} onChange={(category_ids) => setFilter({ category_ids })} />
              </div>
              {accounts.list.length > 0 && (
                <div>
                  <Label hint="none chosen = all cards">Only these cards</Label>
                  <div className="flex flex-wrap gap-2">
                    {accounts.list.map((a) => {
                      const on = w.filters.account_ids?.includes(a.id) ?? false;
                      return (
                        <Chip
                          key={a.id}
                          active={on}
                          onClick={() => {
                            const cur = w.filters.account_ids ?? [];
                            setFilter({ account_ids: on ? cur.filter((x) => x !== a.id) : [...cur, a.id] });
                          }}
                        >
                          <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: a.color ?? "var(--accent)" }} />
                          {a.name}
                        </Chip>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="grid gap-5 sm:grid-cols-2">
                <label className="block">
                  <Label>Merchant name contains</Label>
                  <input className="field" value={w.filters.merchant ?? ""} placeholder="e.g. Bolt" onChange={(e) => setFilter({ merchant: e.target.value || undefined })} />
                </label>
                <label className="block">
                  <Label>Tag</Label>
                  <input className="field" value={w.filters.tag ?? ""} placeholder="e.g. trip" onChange={(e) => setFilter({ tag: e.target.value || undefined })} />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <AmountField label="Amount from" value={w.filters.min_amount ?? null} onChange={(min_amount) => setFilter({ min_amount })} />
                <AmountField label="Amount up to" value={w.filters.max_amount ?? null} onChange={(max_amount) => setFilter({ max_amount })} />
              </div>
              <Toggle
                checked={w.filters.include_excluded ?? false}
                onChange={(include_excluded) => setFilter({ include_excluded })}
                label="Include transactions hidden from statistics"
                hint="Ones you marked “Leave out of statistics”."
              />
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function AmountField({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  const [text, setText] = useState(value ? String(value / 100) : "");
  return (
    <label className="block">
      <Label>{label}</Label>
      <div className="relative">
        <input
          className="field pr-8"
          inputMode="decimal"
          value={text}
          placeholder="any"
          onChange={(e) => {
            setText(e.target.value);
            const v = parseAmount(e.target.value);
            onChange(v && v > 0 ? Math.abs(v) : null);
          }}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3">₼</span>
      </div>
    </label>
  );
}
