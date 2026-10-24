import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { body, intParam, notFound } from "../lib/http";
import { all, first, run } from "../lib/db";
import { aiBlocked, describeBlock, monthSpend } from "../services/ai";
import { chat, generateReport } from "../services/insights";
import { categorizeAllPending } from "../services/categorize";
import { getSettings } from "../services/settings";

const app = new Hono<AppEnv>();

app.get("/insights", async (c) => {
  const rows = await all<{ id: number; kind: string; title: string; period_start: string; period_end: string; created_at: string; data: string; cost_usd: number | null }>(
    c.env.DB,
    "SELECT id, kind, title, period_start, period_end, created_at, data, cost_usd FROM insights ORDER BY created_at DESC LIMIT 60",
  );
  return c.json(
    rows.map(({ data, ...r }) => {
      let headline = "";
      let health_score: number | null = null;
      try {
        const parsed = JSON.parse(data);
        headline = parsed.headline;
        health_score = parsed.health_score;
      } catch {
        // ignore malformed rows
      }
      return { ...r, headline, health_score };
    }),
  );
});

app.get("/insights/:id", async (c) => {
  const row = await first<{ data: string }>(c.env.DB, "SELECT * FROM insights WHERE id = ?", intParam(c, "id"));
  if (!row) notFound();
  return c.json({ ...row, data: JSON.parse(row.data) });
});

app.delete("/insights/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM insights WHERE id = ?", intParam(c, "id"));
  return c.json({ ok: true });
});

app.post("/insights", async (c) => {
  const input = await body(
    c,
    z.object({
      kind: z.enum(["weekly", "monthly", "manual"]).default("manual"),
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  );
  const range = input.start && input.end ? { start: input.start, end: input.end } : undefined;
  const result = await generateReport(c.env, input.kind, range);
  if ("error" in result) throw new HTTPException(400, { message: result.error });
  return c.json(result);
});

app.post("/chat", async (c) => {
  const { messages } = await body(
    c,
    z.object({
      messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) })).min(1).max(30),
    }),
  );
  if (messages[messages.length - 1].role !== "user") throw new HTTPException(400, { message: "Last message must be from you" });
  const result = await chat(c.env, messages);
  if ("error" in result) throw new HTTPException(400, { message: result.error });
  return c.json(result);
});

app.post("/categorize", async (c) => {
  const blocked = await aiBlocked(c.env);
  if (blocked) throw new HTTPException(400, { message: describeBlock(blocked) });
  return c.json({ categorized_merchants: await categorizeAllPending(c.env, 4) });
});

app.get("/usage", async (c) => {
  const settings = await getSettings(c.env);
  const [spend, byPurpose, months] = await Promise.all([
    monthSpend(c.env.DB),
    all(
      c.env.DB,
      `SELECT purpose, model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd
         FROM ai_usage WHERE month = ? GROUP BY purpose, model ORDER BY cost_usd DESC`,
      new Date().toISOString().slice(0, 7),
    ),
    all(c.env.DB, "SELECT month, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls FROM ai_usage GROUP BY month ORDER BY month DESC LIMIT 12"),
  ]);
  const blocked = await aiBlocked(c.env, settings);
  return c.json({
    month_spend_usd: spend,
    cap_usd: settings.ai_monthly_cap_usd,
    status: blocked ?? "ok",
    status_text: blocked ? describeBlock(blocked) : "AI is active",
    by_purpose: byPurpose,
    months,
  });
});

export default app;
