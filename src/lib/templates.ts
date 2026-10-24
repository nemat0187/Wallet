// Ready-made dashboards the owner can start from and then change freely.

import type { Category } from "@shared/types";
import { newWidgetId, type Widget } from "@shared/widgets";

type Draft = Omit<Widget, "id" | "filters" | "limit" | "compare" | "size"> & Partial<Pick<Widget, "filters" | "limit" | "compare" | "size">>;

const w = (d: Draft): Widget => ({ filters: {}, limit: 8, compare: false, size: "half", ...d, id: newWidgetId() });

export interface Template {
  key: string;
  name: string;
  description: string;
  widgets: (categories: Category[]) => Widget[];
}

/** Find default categories by their stable slug, so templates survive renames. */
const ids = (categories: Category[], slugs: string[]) => categories.filter((c) => c.slug && slugs.includes(c.slug)).map((c) => c.id);

export const TEMPLATES: Template[] = [
  {
    key: "monthly",
    name: "Monthly overview",
    description: "Spending, income and savings this month, where the money went and how each day looked.",
    widgets: () => [
      w({ title: "Spent this month", chart: "number", metric: "spent", group_by: "none", range: "this_period", compare: true }),
      w({ title: "Saved this month", chart: "number", metric: "net", group_by: "none", range: "this_period", compare: true }),
      w({ title: "By category", chart: "donut", metric: "spent", group_by: "category", range: "this_period" }),
      w({ title: "Top places", chart: "bar", metric: "spent", group_by: "merchant", range: "this_period" }),
      w({ title: "Day by day", chart: "column", metric: "spent", group_by: "day", range: "this_period", size: "full" }),
    ],
  },
  {
    key: "cards",
    name: "Card money flow",
    description: "Everything that went in and out of each card, including transfers between your own cards.",
    widgets: () => [
      w({ title: "Money in per card", chart: "bar", metric: "flow_in", group_by: "account", range: "this_period" }),
      w({ title: "Money out per card", chart: "bar", metric: "flow_out", group_by: "account", range: "this_period" }),
      w({ title: "Money out by type", chart: "donut", metric: "flow_out", group_by: "type", range: "this_period" }),
      w({ title: "Money in by type", chart: "donut", metric: "flow_in", group_by: "type", range: "this_period" }),
      w({ title: "Money out, week by week", chart: "column", metric: "flow_out", group_by: "week", range: "last_90", size: "full" }),
    ],
  },
  {
    key: "food",
    name: "Eating out & delivery",
    description: "Restaurants, cafés and delivery: how much, where, and at what time of day.",
    widgets: (categories) => {
      const filters = { category_ids: ids(categories, ["dining"]) };
      return [
        w({ title: "Eating out this month", chart: "number", metric: "spent", group_by: "none", range: "this_period", filters, compare: true }),
        w({ title: "Average bill", chart: "number", metric: "average", group_by: "none", range: "this_period", filters, compare: true }),
        w({ title: "Where", chart: "bar", metric: "spent", group_by: "merchant", range: "last_90", filters }),
        w({ title: "Month by month", chart: "line", metric: "spent", group_by: "month", range: "last_12_months", filters }),
        w({ title: "When", chart: "heatmap", metric: "spent", group_by: "weekday_hour", range: "last_90", filters, size: "full" }),
      ];
    },
  },
  {
    key: "year",
    name: "Year in review",
    description: "This year month by month: spending, income, biggest categories and places.",
    widgets: () => [
      w({ title: "Spent this year", chart: "number", metric: "spent", group_by: "none", range: "this_year" }),
      w({ title: "Saved this year", chart: "number", metric: "net", group_by: "none", range: "this_year" }),
      w({ title: "Spending by month", chart: "area", metric: "spent", group_by: "month", range: "this_year", size: "full" }),
      w({ title: "Biggest categories", chart: "table", metric: "spent", group_by: "category", range: "this_year", limit: 12 }),
      w({ title: "Most visited places", chart: "table", metric: "count", group_by: "merchant", range: "this_year", limit: 12 }),
    ],
  },
  {
    key: "blank",
    name: "Blank",
    description: "Start empty and add your own widgets.",
    widgets: () => [],
  },
];

/** A fresh widget for the "Add widget" button. */
export function blankWidget(): Widget {
  return w({ title: "", chart: "bar", metric: "spent", group_by: "category", range: "this_period" });
}
