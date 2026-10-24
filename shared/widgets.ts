// Custom dashboard widgets: what to measure, how to group it, which period and
// filters, and how to draw it. Shared by the API (which runs the query) and the
// web app (which builds and draws widgets).

import { addDays, periodFor, shiftPeriod } from "./money";

export type Metric = "spent" | "income" | "net" | "count" | "average" | "flow_in" | "flow_out";
export type GroupBy =
  | "none"
  | "category"
  | "subcategory"
  | "merchant"
  | "account"
  | "day"
  | "week"
  | "month"
  | "weekday"
  | "hour"
  | "tag"
  | "type"
  | "weekday_hour";
export type ChartType = "number" | "bar" | "column" | "line" | "area" | "donut" | "table" | "heatmap";
export type RangePreset =
  | "this_period"
  | "last_period"
  | "this_month"
  | "last_month"
  | "last_7"
  | "last_30"
  | "last_90"
  | "this_year"
  | "last_year"
  | "last_12_months"
  | "all_time"
  | "custom";

export interface WidgetFilters {
  category_ids?: number[];
  account_ids?: number[];
  merchant?: string;
  tag?: string;
  min_amount?: number | null; // minor units, absolute
  max_amount?: number | null;
  include_excluded?: boolean;
}

export interface Widget {
  id: string;
  title: string;
  chart: ChartType;
  metric: Metric;
  group_by: GroupBy;
  range: RangePreset;
  from?: string;
  to?: string;
  filters: WidgetFilters;
  limit: number;
  compare: boolean; // number widgets: compare with the previous period of the same length
  size: "half" | "full";
}

export interface QueryRequest {
  metric: Metric;
  group_by: GroupBy;
  from: string;
  to: string;
  filters?: WidgetFilters;
  limit?: number;
  compare?: boolean;
}

export interface QueryRow {
  key: string;
  label: string;
  value: number;
  count: number;
  /** weekday_hour only */
  weekday?: number;
  hour?: number;
}

export interface QueryResult {
  rows: QueryRow[];
  total: number;
  count: number;
  previous_total: number | null;
  from: string;
  to: string;
}

export const METRICS: { value: Metric; label: string; hint: string }[] = [
  { value: "spent", label: "Spending", hint: "Expenses (refunds subtract). Transfers you tagged as between your accounts are not included." },
  { value: "income", label: "Income", hint: "Money in, excluding transfers between your accounts." },
  { value: "net", label: "Net (income − spending)", hint: "Positive means you saved money." },
  { value: "count", label: "Number of transactions", hint: "How many payments." },
  { value: "average", label: "Average payment", hint: "Average size of a spending transaction." },
  { value: "flow_in", label: "Money in (all)", hint: "Everything that came into a card, including transfers between your cards." },
  { value: "flow_out", label: "Money out (all)", hint: "Everything that left a card, including transfers between your cards." },
];

export const GROUPS: { value: GroupBy; label: string }[] = [
  { value: "none", label: "Total (no grouping)" },
  { value: "category", label: "Category" },
  { value: "subcategory", label: "Subcategory" },
  { value: "merchant", label: "Merchant" },
  { value: "account", label: "Card / account" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "weekday", label: "Day of week" },
  { value: "hour", label: "Hour of day" },
  { value: "tag", label: "Tag" },
  { value: "type", label: "Transaction type" },
  { value: "weekday_hour", label: "Day of week × hour (heatmap)" },
];

export const CHARTS: { value: ChartType; label: string }[] = [
  { value: "number", label: "Big number" },
  { value: "bar", label: "Horizontal bars" },
  { value: "column", label: "Columns" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "donut", label: "Donut" },
  { value: "table", label: "Table" },
  { value: "heatmap", label: "Heatmap" },
];

export const RANGES: { value: RangePreset; label: string }[] = [
  { value: "this_period", label: "This budget month" },
  { value: "last_period", label: "Last budget month" },
  { value: "this_month", label: "This calendar month" },
  { value: "last_month", label: "Last calendar month" },
  { value: "last_7", label: "Last 7 days" },
  { value: "last_30", label: "Last 30 days" },
  { value: "last_90", label: "Last 90 days" },
  { value: "this_year", label: "This year" },
  { value: "last_year", label: "Last year" },
  { value: "last_12_months", label: "Last 12 months" },
  { value: "all_time", label: "All time" },
  { value: "custom", label: "Custom dates…" },
];

export const TIME_GROUPS: GroupBy[] = ["day", "week", "month"];

/** Resolve a range preset to concrete dates (inclusive). */
export function resolveRange(range: RangePreset, today: string, monthStartDay: number, custom?: { from?: string; to?: string }): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (range) {
    case "this_period":
      return { from: periodFor(today, monthStartDay).start, to: today };
    case "last_period": {
      const p = shiftPeriod(today, monthStartDay, -1);
      return { from: p.start, to: p.end };
    }
    case "this_month":
      return { from: `${y}-${pad(m)}-01`, to: today };
    case "last_month": {
      const p = shiftPeriod(today, 1, -1);
      return { from: p.start, to: p.end };
    }
    case "last_7":
      return { from: addDays(today, -6), to: today };
    case "last_30":
      return { from: addDays(today, -29), to: today };
    case "last_90":
      return { from: addDays(today, -89), to: today };
    case "this_year":
      return { from: `${y}-01-01`, to: today };
    case "last_year":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "last_12_months":
      return { from: shiftPeriod(today, 1, -11).start, to: today };
    case "all_time":
      return { from: "2000-01-01", to: today };
    case "custom": {
      const from = custom?.from && /^\d{4}-\d{2}-\d{2}$/.test(custom.from) ? custom.from : addDays(today, -29);
      const to = custom?.to && /^\d{4}-\d{2}-\d{2}$/.test(custom.to) ? custom.to : today;
      return from <= to ? { from, to } : { from: to, to: from };
    }
  }
}

/** A sensible chart for a grouping (used when the owner changes the grouping). */
export function suggestedChart(group: GroupBy): ChartType {
  if (group === "none") return "number";
  if (group === "weekday_hour") return "heatmap";
  if (TIME_GROUPS.includes(group) || group === "hour" || group === "weekday") return "column";
  return "bar";
}

export function newWidgetId(): string {
  return Math.random().toString(36).slice(2, 10);
}
