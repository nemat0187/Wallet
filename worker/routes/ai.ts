import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { body, intParam, notFound } from "../lib/http";
import { all, first, run } from "../lib/db";
import { aiBlocked, describeBlock, monthSpend, monthTokens, structuredCall } from "../services/ai";
import { ensureModelsFor, providerStatuses, refreshModels, removeKey, saveKey } from "../services/aikeys";
import { isProvider } from "../services/aiproviders/types";
import { setSetting } from "../services/settings";
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

// ---------------------------------------------------------------------------
// The person's own AI keys and provider

const providerParam = (c: { req: { param: (n: string) => string } }) => {
  const p = c.req.param("provider");
  if (!isProvider(p)) throw new HTTPException(404, { message: "Unknown provider" });
  return p;
};

app.get("/providers", async (c) => c.json({ providers: await providerStatuses(c.env) }));

/** Save a key: checked with the provider first, stored encrypted, never returned. */
app.put("/keys/:provider", async (c) => {
  const provider = providerParam(c);
  const { key } = await body(c, z.object({ key: z.string().min(8).max(600) }));
  return c.json({ providers: await saveKey(c.env, provider, key) });
});

app.delete("/keys/:provider", async (c) => c.json({ providers: await removeKey(c.env, providerParam(c)) }));

/** Ask the provider which models this key can use. */
app.post("/models/:provider", async (c) => {
  const provider = providerParam(c);
  await refreshModels(c.env, provider);
  return c.json({ providers: await providerStatuses(c.env) });
});

/** Make a provider the active one (its models are chosen from its list when the current ones don't fit). */
app.put("/provider", async (c) => {
  const { provider } = await body(c, z.object({ provider: z.enum(["anthropic", "openai", "gemini"]) }));
  await setSetting(c.env.DB, "ai_provider", provider);
  await ensureModelsFor(c.env, provider);
  return c.json({ providers: await providerStatuses(c.env) });
});

/** A tiny real request, so the person can see that the key and model work. */
app.post("/test", async (c) => {
  const settings = await getSettings(c.env);
  const blocked = await aiBlocked(c.env, settings);
  if (blocked) throw new HTTPException(400, { message: describeBlock(blocked) });
  const r = await structuredCall(c.env, {
    purpose: "test",
    model: settings.ai_fast_model,
    system: "You are a connection test.",
    content: "Reply with ok set to true.",
    schema: z.object({ ok: z.boolean() }),
    maxTokens: 200,
  });
  return c.json({ ok: Boolean(r.data?.ok), model: r.model, provider: settings.ai_provider });
});

app.get("/usage", async (c) => {
  const settings = await getSettings(c.env);
  const [spend, tokens, byPurpose, months] = await Promise.all([
    monthSpend(c.env.DB),
    monthTokens(c.env.DB),
    all(
      c.env.DB,
      `SELECT purpose, provider, model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd, MIN(cost_known) AS cost_known
         FROM ai_usage WHERE month = ? GROUP BY purpose, provider, model ORDER BY (input_tokens + output_tokens) DESC`,
      new Date().toISOString().slice(0, 7),
    ),
    all(c.env.DB, "SELECT month, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls FROM ai_usage GROUP BY month ORDER BY month DESC LIMIT 12"),
  ]);
  const blocked = await aiBlocked(c.env, settings);
  return c.json({
    month_spend_usd: spend,
    month_tokens: tokens,
    cap_usd: settings.ai_monthly_cap_usd,
    token_cap: settings.ai_monthly_token_cap,
    status: blocked ?? "ok",
    status_text: blocked ? describeBlock(blocked) : "AI is active",
    by_purpose: byPurpose,
    months,
  });
});

export default app;
