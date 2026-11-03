// Budgets for a calendar range: which dates a range budget covers, and whether it is running.

import { daysBetween, daysInMonth, formatDay } from "./money";

export interface RangeBudgetDef {
  scope: "days" | "dates";
  start_day: number | null;
  end_day: number | null;
  start_date: string | null;
  end_date: string | null;
}

export type RangeState = "upcoming" | "active" | "ended";

export interface RangePeriod {
  start: string;
  end: string;
  state: RangeState;
  label: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The window of a "days of the month" budget that starts in month (y, m), clamping to short months. */
function windowIn(y: number, m: number, startDay: number, endDay: number): { start: string; end: string } {
  const start = `${y}-${pad(m)}-${pad(Math.min(startDay, daysInMonth(y, m)))}`;
  if (endDay >= startDay) return { start, end: `${y}-${pad(m)}-${pad(Math.min(endDay, daysInMonth(y, m)))}` };
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { start, end: `${ny}-${pad(nm)}-${pad(Math.min(endDay, daysInMonth(ny, nm)))}` };
}

const text = (start: string, end: string) => `${formatDay(start, start.slice(0, 4) !== end.slice(0, 4))} – ${formatDay(end, true)}`;

/**
 * The period a range budget shows for a given day. A repeating one shows the window that contains the day, or the
 * latest finished one in between (so you can see how the last round went).
 */
export function rangePeriod(b: RangeBudgetDef, anchor: string): RangePeriod {
  if (b.scope === "dates" && b.start_date && b.end_date) {
    const state: RangeState = anchor < b.start_date ? "upcoming" : anchor > b.end_date ? "ended" : "active";
    return { start: b.start_date, end: b.end_date, state, label: text(b.start_date, b.end_date) };
  }
  const startDay = b.start_day ?? 1;
  const endDay = b.end_day ?? 28;
  const [y, m] = anchor.split("-").map(Number);
  const candidates = [-1, 0].map((d) => {
    const mm = m + d;
    return windowIn(mm < 1 ? y - 1 : y, mm < 1 ? 12 : mm, startDay, endDay);
  });
  const inside = candidates.find((w) => anchor >= w.start && anchor <= w.end);
  if (inside) return { ...inside, state: "active", label: text(inside.start, inside.end) };
  const finished = candidates.filter((w) => w.end < anchor).pop() ?? candidates[0];
  return { ...finished, state: "ended", label: text(finished.start, finished.end) };
}

/** Days until the next window of a repeating budget starts (for "starts in 5 days"). */
export function daysUntilNextWindow(b: RangeBudgetDef, anchor: string): number | null {
  if (b.scope === "dates") return b.start_date && anchor < b.start_date ? daysBetween(anchor, b.start_date) : null;
  const [y, m] = anchor.split("-").map(Number);
  for (const d of [0, 1]) {
    const mm = m + d;
    const w = windowIn(mm > 12 ? y + 1 : y, mm > 12 ? 1 : mm, b.start_day ?? 1, b.end_day ?? 28);
    if (w.start > anchor) return daysBetween(anchor, w.start);
  }
  return null;
}
