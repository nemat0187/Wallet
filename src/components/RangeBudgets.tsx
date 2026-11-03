// Budgets for a calendar range: overall or per category, e.g. "Eating out, 15th to 30th of every month".

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CalendarRange, Plus } from "lucide-react";
import type { RangeBudget, RangeBudgetStatus } from "@shared/types";
import { addDays, formatMoney, localDate, parseAmount } from "@shared/money";
import { del, post, put } from "../lib/api";
import { useBootstrap, useCategories, useRefresh } from "../lib/data";
import { Button, ErrorNote, Label, Segmented, Sheet, clsx, useToast } from "../lib/ui";
import { CategoryPicker } from "./CategoryPicker";
import { Meter } from "./charts";

export function rangeBudgetName(r: RangeBudget, categoryName: (id: number) => string | undefined): string {
  return r.name || (r.category_id ? (categoryName(r.category_id) ?? "Category") : "All spending");
}

function whenText(r: RangeBudget): string {
  return r.scope === "days" ? `every month, day ${r.start_day} to ${r.end_day}${(r.end_day ?? 0) < (r.start_day ?? 0) ? " (next month)" : ""}` : "one time";
}

export function RangeBudgetRow({ b, onClick }: { b: RangeBudgetStatus; onClick?: () => void }) {
  const cats = useCategories();
  const name = rangeBudgetName(b.range, (id) => cats.info(id)?.name);
  const icon = b.range.category_id ? cats.info(b.range.category_id)?.icon : "🗓️";
  const inner = (
    <>
      <div className="mb-2 flex items-center gap-3">
        <span className="text-xl" aria-hidden>
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate text-[13px] text-ink-3">
            {b.period.label}
            {b.state === "upcoming" && b.starts_in_days !== null ? ` · starts in ${b.starts_in_days} ${b.starts_in_days === 1 ? "day" : "days"}` : ""}
            {b.state === "ended" ? (b.range.scope === "days" ? " · last round" : " · finished") : ""}
          </span>
        </span>
        <span className="num text-right">
          <span className={clsx("font-semibold", b.status === "over" ? "text-bad" : b.status === "warning" ? "text-warn" : "")}>
            {formatMoney(b.spent, "AZN", { decimals: false })}
          </span>
          <span className="text-ink-3"> / {formatMoney(b.amount, "AZN", { decimals: false })}</span>
        </span>
      </div>
      <Meter spent={b.spent} amount={b.amount} status={b.status} paceFraction={null} />
    </>
  );
  return onClick ? (
    <button className={clsx("block w-full px-4 py-3.5 text-left hover:bg-surface-2", b.state !== "active" && "opacity-75")} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className={clsx("px-4 py-3.5", b.state !== "active" && "opacity-75")}>{inner}</div>
  );
}

export function RangeBudgetEditor({ editing, onClose }: { editing: RangeBudget | "new" | null; onClose: () => void }) {
  return (
    <Sheet open={Boolean(editing)} onClose={onClose} title={editing && editing !== "new" ? "Edit date-range budget" : "Budget for a date range"}>
      {editing && <Form key={editing === "new" ? "new" : editing.id} editing={editing === "new" ? null : editing} onClose={onClose} />}
    </Sheet>
  );
}

function Form({ editing, onClose }: { editing: RangeBudget | null; onClose: () => void }) {
  const cats = useCategories();
  const refresh = useRefresh();
  const toast = useToast();
  const settings = useBootstrap().data?.settings;
  const today = localDate(new Date(), settings?.tz_offset_minutes ?? 240);
  const [name, setName] = useState(editing?.name ?? "");
  const [categoryId, setCategoryId] = useState<number | null>(editing?.category_id ?? null);
  const [pickingCategory, setPickingCategory] = useState(false);
  const [amount, setAmount] = useState(editing ? String(editing.amount / 100) : "");
  const [alert, setAlert] = useState(editing?.alert_pct ?? 80);
  const [scope, setScope] = useState<"days" | "dates">(editing?.scope ?? "days");
  const [startDay, setStartDay] = useState(editing?.start_day ?? 15);
  const [endDay, setEndDay] = useState(editing?.end_day ?? 30);
  const [startDate, setStartDate] = useState(editing?.start_date ?? today);
  const [endDate, setEndDate] = useState(editing?.end_date ?? addDays(today, 13));

  const save = useMutation({
    mutationFn: () => {
      const minor = parseAmount(amount || "0");
      if (!minor || minor <= 0) throw new Error("Enter an amount like 300");
      const body = {
        name: name.trim() || null,
        category_id: categoryId,
        amount: minor,
        alert_pct: alert,
        scope,
        start_day: scope === "days" ? startDay : null,
        end_day: scope === "days" ? endDay : null,
        start_date: scope === "dates" ? startDate : null,
        end_date: scope === "dates" ? endDate : null,
      };
      return editing ? put(`/budgets/ranges/${editing.id}`, body) : post("/budgets/ranges", body);
    },
    onSuccess: () => {
      toast("Budget saved");
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/budgets/ranges/${editing!.id}`),
    onSuccess: () => {
      toast("Budget removed");
      refresh();
      onClose();
    },
  });
  const dayOptions = Array.from({ length: 31 }, (_, i) => i + 1);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div>
        <Label>Applies to</Label>
        <button type="button" onClick={() => setPickingCategory((p) => !p)} className="field flex items-center gap-3 text-left" aria-expanded={pickingCategory}>
          <span aria-hidden>{categoryId ? cats.info(categoryId)?.icon : "🧾"}</span>
          <span className="flex-1">{categoryId ? cats.info(categoryId)?.path : "All spending (overall)"}</span>
          <span className="text-sm font-medium text-accent">{pickingCategory ? "Close" : "Change"}</span>
        </button>
        {pickingCategory && (
          <div className="mt-2 flex flex-col gap-2">
            <Button
              type="button"
              size="sm"
              variant={categoryId === null ? "primary" : "secondary"}
              onClick={() => {
                setCategoryId(null);
                setPickingCategory(false);
              }}
            >
              All spending (overall)
            </Button>
            <CategoryPicker
              value={categoryId}
              kinds={["expense"]}
              onChange={(id) => {
                setCategoryId(id);
                setPickingCategory(false);
              }}
            />
          </div>
        )}
      </div>

      <div>
        <Label>Period</Label>
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: "days", label: "Days of every month" },
            { value: "dates", label: "Exact dates" },
          ]}
        />
        {scope === "days" ? (
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <span className="text-ink-2">From day</span>
              <select className="field w-auto" value={startDay} onChange={(e) => setStartDay(Number(e.target.value))} aria-label="First day">
                {dayOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <span className="text-ink-2">to day</span>
              <select className="field w-auto" value={endDay} onChange={(e) => setEndDay(Number(e.target.value))} aria-label="Last day">
                {dayOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-1.5 text-[13px] text-ink-3">
              Repeats every month, e.g. 15 to 30. If the last day is before the first (25 to 5), it runs into the next month. Short months end on their last day.
            </p>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label>
              <span className="mb-1 block text-[13px] text-ink-3">From</span>
              <input type="date" className="field" value={startDate} max={endDate} onChange={(e) => e.target.value && setStartDate(e.target.value)} />
            </label>
            <label>
              <span className="mb-1 block text-[13px] text-ink-3">To</span>
              <input type="date" className="field" value={endDate} min={startDate} onChange={(e) => e.target.value && setEndDate(e.target.value)} />
            </label>
          </div>
        )}
      </div>

      <label className="block">
        <Label>Amount for the whole period</Label>
        <div className="relative">
          <input inputMode="decimal" className="field h-14 pr-10 text-2xl font-semibold num" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xl text-ink-3">₼</span>
        </div>
      </label>

      <label className="block">
        <Label hint="(Telegram alert)">Warn me at {alert}% of the budget</Label>
        <input type="range" min={50} max={100} step={5} value={alert} onChange={(e) => setAlert(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
      </label>

      <label className="block">
        <Label hint="(optional)">Name</Label>
        <input className="field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Second half of the month" />
      </label>

      <ErrorNote error={save.error ?? remove.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" className="flex-1" loading={save.isPending}>
          Save budget
        </Button>
        {editing && (
          <Button type="button" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </Button>
        )}
      </div>
    </form>
  );
}

export function RangeBudgetsSection({ ranges }: { ranges: RangeBudgetStatus[] }) {
  const [editing, setEditing] = useState<RangeBudget | "new" | null>(null);
  return (
    <>
      <div className="mb-3 mt-8 flex items-end justify-between gap-3 px-1">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
          <CalendarRange size={18} className="text-accent" aria-hidden /> Date-range budgets
        </h2>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={16} /> Add
        </Button>
      </div>
      {ranges.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-sm text-ink-2">
          Need a limit for part of the month, like the 15th to the 30th, or for one trip or holiday? Add a budget for those dates, for all spending or for one
          category.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
          {ranges.map((b) => (
            <li key={b.range.id}>
              <RangeBudgetRow b={b} onClick={() => setEditing(b.range)} />
              <p className="-mt-2 px-4 pb-2.5 text-[12px] text-ink-3">
                {whenText(b.range)}
                {b.state === "ended" && b.range.scope === "days" && b.starts_in_days !== null ? ` · next round in ${b.starts_in_days} days` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      <RangeBudgetEditor editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}
