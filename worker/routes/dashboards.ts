// Custom dashboards: named lists of widgets (stored as JSON).

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { body, intParam, notFound } from "../lib/http";
import { all, first, insert, nowIso, run } from "../lib/db";

const app = new Hono<AppEnv>();

const Filters = z.object({
  category_ids: z.array(z.number().int()).max(100).optional(),
  account_ids: z.array(z.number().int()).max(50).optional(),
  merchant: z.string().max(80).optional(),
  tag: z.string().max(40).optional(),
  min_amount: z.number().int().min(0).nullable().optional(),
  max_amount: z.number().int().min(0).nullable().optional(),
  include_excluded: z.boolean().optional(),
});

export const WidgetSchema = z.object({
  id: z.string().min(1).max(20),
  title: z.string().max(80),
  chart: z.enum(["number", "bar", "column", "line", "area", "donut", "table", "heatmap"]),
  metric: z.enum(["spent", "income", "net", "count", "average", "flow_in", "flow_out"]),
  group_by: z.enum(["none", "category", "subcategory", "merchant", "account", "day", "week", "month", "weekday", "hour", "tag", "type", "weekday_hour"]),
  range: z.enum(["this_period", "last_period", "this_month", "last_month", "last_7", "last_30", "last_90", "this_year", "last_year", "last_12_months", "all_time", "custom"]),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  filters: Filters.default({}),
  limit: z.number().int().min(1).max(100).default(10),
  compare: z.boolean().default(false),
  size: z.enum(["half", "full"]).default("half"),
});
export const QuerySchema = z.object({
  metric: WidgetSchema.shape.metric,
  group_by: WidgetSchema.shape.group_by,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  filters: Filters.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  compare: z.boolean().optional(),
});

const DashboardInput = z.object({
  name: z.string().trim().min(1).max(60),
  widgets: z.array(WidgetSchema).max(40).default([]),
  show_on_home: z.boolean().default(false),
});

interface Row {
  id: number;
  name: string;
  widgets: string;
  show_on_home: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}
const decode = (r: Row) => ({ ...r, widgets: JSON.parse(r.widgets || "[]"), show_on_home: Boolean(r.show_on_home) });

app.get("/", async (c) => c.json((await all<Row>(c.env.DB, "SELECT * FROM dashboards ORDER BY sort_order, id")).map(decode)));

app.post("/", async (c) => {
  const d = await body(c, DashboardInput);
  const max = await first<{ m: number | null }>(c.env.DB, "SELECT MAX(sort_order) AS m FROM dashboards");
  const now = nowIso();
  const id = await insert(
    c.env.DB,
    "INSERT INTO dashboards (name, widgets, show_on_home, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    d.name,
    JSON.stringify(d.widgets),
    d.show_on_home ? 1 : 0,
    (max?.m ?? 0) + 1,
    now,
    now,
  );
  return c.json({ id });
});

app.put("/:id", async (c) => {
  const id = intParam(c, "id");
  const d = await body(c, DashboardInput);
  if (!(await first(c.env.DB, "SELECT id FROM dashboards WHERE id = ?", id))) notFound();
  await run(
    c.env.DB,
    "UPDATE dashboards SET name = ?, widgets = ?, show_on_home = ?, updated_at = ? WHERE id = ?",
    d.name,
    JSON.stringify(d.widgets),
    d.show_on_home ? 1 : 0,
    nowIso(),
    id,
  );
  return c.json({ ok: true });
});

app.post("/reorder", async (c) => {
  const { ids } = await body(c, z.object({ ids: z.array(z.number().int()).max(100) }));
  if (ids.length) await c.env.DB.batch(ids.map((id, i) => c.env.DB.prepare("UPDATE dashboards SET sort_order = ? WHERE id = ?").bind(i + 1, id)));
  return c.json({ ok: true });
});

app.delete("/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM dashboards WHERE id = ?", intParam(c, "id"));
  return c.json({ ok: true });
});

export default app;
