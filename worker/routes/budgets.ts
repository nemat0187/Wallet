import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { body, intParam } from "../lib/http";
import { all, nowIso, run } from "../lib/db";
import { periodFor, shiftPeriod } from "@shared/money";
import { loadCategories } from "../services/categorize";
import { budgetStatus, rollUp, spendingByCategory } from "../services/budgets";
import { getSettings, setSetting } from "../services/settings";
import { today } from "../services/analytics";

const app = new Hono<AppEnv>();

/** Budgets with spending for the period containing ?date= (default: today), plus a 3-period average per category. */
app.get("/", async (c) => {
  const settings = await getSettings(c.env);
  const idx = await loadCategories(c.env.DB);
  const now = today(settings);
  const period = periodFor(c.req.query("date") ?? now, settings.month_start_day);
  const status = await budgetStatus(c.env.DB, idx, settings, period, now);
  const p3 = shiftPeriod(period.start, settings.month_start_day, -3);
  const p1 = shiftPeriod(period.start, settings.month_start_day, -1);
  const hist = rollUp(idx, await spendingByCategory(c.env.DB, p3.start, p1.end));
  const average: Record<number, number> = {};
  for (const [id, v] of hist) average[id] = Math.round(v / 3);
  return c.json({ period, ...status, average_last_3: average });
});

app.put("/", async (c) => {
  const input = await body(
    c,
    z.object({ category_id: z.number().int(), amount: z.number().int().min(0), alert_pct: z.number().int().min(10).max(100).optional() }),
  );
  const now = nowIso();
  await run(
    c.env.DB,
    `INSERT INTO budgets (category_id, amount, alert_pct, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(category_id) DO UPDATE SET amount = excluded.amount, alert_pct = excluded.alert_pct, updated_at = excluded.updated_at`,
    input.category_id,
    input.amount,
    input.alert_pct ?? 80,
    now,
    now,
  );
  return c.json({ ok: true });
});

app.put("/overall", async (c) => {
  const { amount } = await body(c, z.object({ amount: z.number().int().min(0).nullable() }));
  await setSetting(c.env.DB, "overall_budget", amount ? String(amount) : null);
  return c.json({ ok: true });
});

/** Create budgets from the average of the last 3 periods (rounded up to 10 AZN) for categories without one. */
app.post("/suggest", async (c) => {
  const settings = await getSettings(c.env);
  const idx = await loadCategories(c.env.DB);
  const now = today(settings);
  const p3 = shiftPeriod(now, settings.month_start_day, -3);
  const p1 = shiftPeriod(now, settings.month_start_day, -1);
  const hist = rollUp(idx, await spendingByCategory(c.env.DB, p3.start, p1.end));
  const existing = new Set((await all<{ category_id: number }>(c.env.DB, "SELECT category_id FROM budgets")).map((b) => b.category_id));
  const ts = nowIso();
  const stmts = idx.list
    .filter((cat) => cat.parent_id === null && cat.kind === "expense" && !existing.has(cat.id) && cat.slug !== "uncategorized")
    .map((cat) => ({ cat, avg: (hist.get(cat.id) ?? 0) / 3 }))
    .filter((x) => x.avg >= 2000)
    .map((x) =>
      c.env.DB.prepare("INSERT INTO budgets (category_id, amount, alert_pct, created_at, updated_at) VALUES (?, ?, 80, ?, ?)").bind(
        x.cat.id,
        Math.ceil(x.avg / 1000) * 1000,
        ts,
        ts,
      ),
    );
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ created: stmts.length });
});

app.delete("/:categoryId", async (c) => {
  await run(c.env.DB, "DELETE FROM budgets WHERE category_id = ?", intParam(c, "categoryId"));
  return c.json({ ok: true });
});

export default app;
