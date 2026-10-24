// AI financial coach: periodic reports and the "Ask AI" chat.
//
// Reports send Claude a compact, pre-computed summary (totals, categories,
// habits, subscriptions, anomalies) rather than raw transactions — this keeps
// each report to a few cents and makes the numbers in it exact.

import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Env } from "../env";
import type { InsightReport } from "@shared/types";
import { addDays, daysBetween, formatDay, formatMoney, shiftPeriod } from "@shared/money";
import { all, first, insert, nowIso } from "../lib/db";
import { aiBlocked, aiClient, describeBlock, fallbackParams, recordUsage, sqlOffset, structuredCall } from "./ai";
import { categoryPath, loadCategories, type CategoryIndex } from "./categorize";
import { anomalies, breakdown, merchantReport, recurring, today, TX_SELECT } from "./analytics";
import { budgetStatus, spendingByCategory } from "./budgets";
import { getSettings } from "./settings";

const azn = (minor: number) => Math.round(minor) / 100;

/** Compact statistics for a date range, used as the input of an AI report. */
export async function buildStats(env: Env, start: string, end: string) {
  const db = env.DB;
  const settings = await getSettings(env);
  const idx = await loadCategories(db);
  const days = daysBetween(start, end) + 1;
  const prevStart = addDays(start, -days);
  const prevEnd = addDays(start, -1);
  const hist3Start = addDays(start, -days * 3);

  const [cur, prev, hist, merchants, recur, odd, habits, budgets, income] = await Promise.all([
    spendingByCategory(db, start, end),
    spendingByCategory(db, prevStart, prevEnd),
    spendingByCategory(db, hist3Start, prevEnd),
    merchantReport(env, start, end, 15),
    recurring(env),
    anomalies(env, start, end),
    first<Record<string, number | null>>(
      db,
      `SELECT
         SUM(CASE WHEN c.slug = 'dining.delivery' OR p.slug = 'dining.delivery' THEN 1 ELSE 0 END) AS delivery_orders,
         -SUM(CASE WHEN c.slug = 'dining.delivery' THEN t.amount_base ELSE 0 END) AS delivery_spent,
         SUM(CASE WHEN c.slug = 'transport.taxi' THEN 1 ELSE 0 END) AS taxi_rides,
         -SUM(CASE WHEN c.slug = 'transport.taxi' THEN t.amount_base ELSE 0 END) AS taxi_spent,
         SUM(CASE WHEN c.slug = 'dining.cafe' THEN 1 ELSE 0 END) AS cafe_visits,
         -SUM(CASE WHEN c.slug = 'dining.cafe' THEN t.amount_base ELSE 0 END) AS cafe_spent,
         SUM(CASE WHEN -t.amount_base < 1000 THEN 1 ELSE 0 END) AS small_purchases,
         -SUM(CASE WHEN -t.amount_base < 1000 THEN t.amount_base ELSE 0 END) AS small_spent,
         SUM(CASE WHEN CAST(strftime('%H', t.occurred_at, ?) AS INTEGER) >= 22 OR CAST(strftime('%H', t.occurred_at, ?) AS INTEGER) < 5 THEN 1 ELSE 0 END) AS late_night_purchases,
         -SUM(CASE WHEN CAST(strftime('%H', t.occurred_at, ?) AS INTEGER) >= 22 OR CAST(strftime('%H', t.occurred_at, ?) AS INTEGER) < 5 THEN t.amount_base ELSE 0 END) AS late_night_spent,
         -SUM(CASE WHEN strftime('%w', t.local_date) IN ('0', '6') THEN t.amount_base ELSE 0 END) AS weekend_spent,
         -SUM(CASE WHEN strftime('%w', t.local_date) NOT IN ('0', '6') THEN t.amount_base ELSE 0 END) AS weekday_spent,
         COUNT(*) AS purchases
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN categories p ON p.id = c.parent_id
      WHERE t.kind = 'expense' AND t.excluded = 0 AND t.amount_base < 0 AND t.local_date BETWEEN ? AND ?`,
      ...Array<string>(4).fill(sqlOffset(settings.tz_offset_minutes)),
      start,
      end,
    ),
    budgetStatus(db, idx, settings, { start, end }, today(settings)),
    first<{ income: number | null }>(
      db,
      "SELECT SUM(amount_base) AS income FROM transactions WHERE kind = 'income' AND excluded = 0 AND local_date BETWEEN ? AND ?",
      start,
      end,
    ),
  ]);

  const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const spent = sum(cur);
  const prevSpent = sum(prev);
  const histAvg = sum(hist) / 3;
  const curCats = breakdown(idx, cur);
  const prevCats = new Map(breakdown(idx, prev).map((c) => [c.category_id, c.spent]));
  const histCats = new Map(breakdown(idx, hist).map((c) => [c.category_id, c.spent / 3]));
  const incomeTotal = income?.income ?? 0;

  return {
    period: { start, end, days },
    currency: "AZN",
    totals: {
      spent: azn(spent),
      income: azn(incomeTotal),
      saved: azn(incomeTotal - spent),
      savings_rate_pct: incomeTotal > 0 ? Math.round(((incomeTotal - spent) / incomeTotal) * 100) : null,
      previous_period_spent: azn(prevSpent),
      average_of_previous_3_periods_spent: azn(histAvg),
      average_per_day: azn(spent / days),
    },
    categories: curCats.slice(0, 12).map((c) => ({
      category: categoryPath(idx, c.category_id),
      spent: azn(c.spent),
      previous_period: azn(prevCats.get(c.category_id) ?? 0),
      three_period_average: azn(histCats.get(c.category_id) ?? 0),
      share_pct: spent > 0 ? Math.round((c.spent / spent) * 100) : 0,
      top_subcategories: c.children.slice(0, 3).map((x) => ({ name: idx.byId.get(x.category_id)?.name, spent: azn(x.spent) })),
    })),
    top_merchants: merchants.map((m) => ({
      merchant: m.name,
      category: m.category_id ? categoryPath(idx, m.category_id) : null,
      spent: azn(m.spent),
      purchases: m.count,
    })),
    habits: Object.fromEntries(
      Object.entries(habits ?? {}).map(([k, v]) => [k, k.endsWith("_spent") ? azn(v ?? 0) : (v ?? 0)]),
    ),
    subscriptions_and_regular_bills: recur
      .filter((r) => r.active)
      .slice(0, 15)
      .map((r) => ({ merchant: r.name, cadence: r.cadence, amount: azn(r.amount), monthly_cost: azn(r.monthly_cost), variable_amount: r.variable })),
    unusual_transactions: odd.map((t) => ({
      date: t.local_date,
      merchant: t.merchant_name ?? t.merchant_raw,
      amount: azn(-t.amount_base),
      typical_amount_at_merchant: t.typical ? azn(t.typical) : null,
    })),
    budgets: {
      overall: budgets.overall ? { limit: azn(budgets.overall.amount), spent: azn(budgets.overall.spent) } : null,
      categories: budgets.categories.map((b) => ({
        category: categoryPath(idx, b.category_id!),
        limit: azn(b.amount),
        spent: azn(b.spent),
        status: b.status,
      })),
    },
  };
}

const ReportSchema = z.object({
  headline: z.string().describe("One short sentence summarising the period"),
  summary: z.string().describe("3-5 sentences, plain language, concrete numbers in AZN"),
  health_score: z.number().int().describe("0-100 overall financial health for this period"),
  highlights: z.array(z.string()).describe("2-4 positive or notable facts"),
  bad_habits: z.array(
    z.object({
      title: z.string(),
      detail: z.string().describe("What the data shows, with numbers"),
      monthly_cost: z.number().nullable().describe("Estimated AZN per month this habit costs"),
      suggestion: z.string().describe("A specific, realistic change"),
    }),
  ),
  recommendations: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      potential_monthly_savings: z.number().nullable(),
    }),
  ),
  anomalies: z.array(z.object({ title: z.string(), detail: z.string() })),
  budget_suggestions: z.array(
    z.object({
      category: z.string().describe("Category path exactly as given in the data"),
      suggested_monthly_amount: z.number(),
      reason: z.string(),
    }),
  ),
});

const COACH_SYSTEM = [
  "You are a friendly, direct personal finance coach for one person living in Baku, Azerbaijan. Amounts are in AZN (manat).",
  "You receive pre-computed statistics about their spending. Every number you mention must come from the data; never invent figures.",
  "Identify bad habits (e.g. frequent food delivery or taxis, many small impulse purchases, late-night spending, creeping subscriptions,",
  "categories growing versus their own average) and give specific, realistic recommendations with estimated savings.",
  "Be encouraging about real progress. Keep each item short. If data is sparse (few transactions), say so and keep advice modest.",
  "Suggest budgets only for categories with meaningful spending, rounded to sensible amounts.",
].join(" ");

export async function generateReport(
  env: Env,
  kind: "weekly" | "monthly" | "manual",
  range?: { start: string; end: string },
): Promise<{ id: number } | { error: string }> {
  const settings = await getSettings(env);
  const blocked = await aiBlocked(env, settings);
  if (blocked) return { error: describeBlock(blocked) };
  const now = today(settings);
  let start: string;
  let end: string;
  if (range) ({ start, end } = range);
  else if (kind === "weekly") [start, end] = [addDays(now, -7), addDays(now, -1)];
  else if (kind === "monthly") ({ start, end } = shiftPeriod(now, settings.month_start_day, -1));
  else [start, end] = [shiftPeriod(now, settings.month_start_day, 0).start, now];

  const stats = await buildStats(env, start, end);
  if (stats.totals.spent === 0 && stats.totals.income === 0) return { error: "No transactions in this period yet." };

  const model = settings.ai_smart_model;
  const { data: report, cost, model: servedModel } = await structuredCall(env, {
    purpose: `report:${kind}`,
    model,
    system: COACH_SYSTEM,
    content: `Statistics for ${start} to ${end} (${kind} report):\n${JSON.stringify(stats)}`,
    schema: ReportSchema,
    maxTokens: 16000,
    effort: "medium",
  });
  if (!report) return { error: "The AI could not produce a report this time. Please try again." };
  report.health_score = Math.max(0, Math.min(100, report.health_score));

  const title =
    kind === "weekly"
      ? `Weekly review, ${formatDay(start)} – ${formatDay(end, true)}`
      : kind === "monthly"
        ? `Monthly review, ${formatDay(start)} – ${formatDay(end, true)}`
        : `Month so far, ${formatDay(start)} – ${formatDay(end, true)}`;
  const id = await insert(
    env.DB,
    "INSERT INTO insights (kind, period_start, period_end, title, data, model, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    kind,
    start,
    end,
    title,
    JSON.stringify(report satisfies InsightReport),
    servedModel,
    cost,
    nowIso(),
  );
  return { id };
}

// ---------------------------------------------------------------------------
// Ask AI — chat with tools that query the owner's data.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function chatTools(env: Env, idx: CategoryIndex) {
  const resolveCategoryIds = (name?: string | null): number[] | null => {
    if (!name) return null;
    const needle = name.toLowerCase();
    const hits = idx.list.filter((c) => c.name.toLowerCase().includes(needle) || (c.slug ?? "").includes(needle));
    if (!hits.length) return [];
    const ids = new Set<number>();
    for (const h of hits) {
      ids.add(h.id);
      for (const child of idx.list.filter((c) => c.parent_id === h.id)) ids.add(child.id);
    }
    return [...ids];
  };

  return [
    betaZodTool({
      name: "spending_summary",
      description:
        "Totals of spending (expenses) or income for a date range, grouped by category, merchant, month, weekday or account. Amounts are AZN.",
      inputSchema: z.object({
        date_from: z.string().describe("YYYY-MM-DD inclusive"),
        date_to: z.string().describe("YYYY-MM-DD inclusive"),
        group_by: z.enum(["category", "parent_category", "merchant", "month", "weekday", "account", "none"]),
        kind: z.enum(["expense", "income"]).default("expense"),
        category: z.string().nullable().optional().describe("Optional category name filter, e.g. 'Taxi' or 'Eating out'"),
        merchant: z.string().nullable().optional().describe("Optional merchant name filter (substring)"),
        limit: z.number().int().min(1).max(50).default(15),
      }),
      run: async (input) => {
        const where = ["t.excluded = 0", "t.kind = ?", "t.local_date BETWEEN ? AND ?"];
        const params: (string | number)[] = [input.kind, input.date_from, input.date_to];
        const catIds = resolveCategoryIds(input.category);
        if (catIds) {
          if (!catIds.length) return `No category matches "${input.category}".`;
          where.push(`t.category_id IN (${catIds.join(",")})`);
        }
        if (input.merchant) {
          where.push("(m.name LIKE ? OR t.merchant_raw LIKE ?)");
          params.push(`%${input.merchant}%`, `%${input.merchant}%`);
        }
        const groupExpr: Record<string, string> = {
          category: "t.category_id",
          parent_category: "COALESCE(c.parent_id, c.id)",
          merchant: "COALESCE(m.name, t.merchant_raw, t.description)",
          month: "substr(t.local_date, 1, 7)",
          weekday: "strftime('%w', t.local_date)",
          account: "t.account_id",
          none: "'total'",
        };
        const g = groupExpr[input.group_by];
        const rows = await all<{ g: string | number | null; total: number; n: number }>(
          env.DB,
          `SELECT ${g} AS g, SUM(t.amount_base) AS total, COUNT(*) AS n
             FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id LEFT JOIN categories c ON c.id = t.category_id
            WHERE ${where.join(" AND ")} GROUP BY g ORDER BY ABS(SUM(t.amount_base)) DESC LIMIT ?`,
          ...params,
          input.limit,
        );
        const accounts = input.group_by === "account" ? await all<{ id: number; name: string }>(env.DB, "SELECT id, name FROM accounts") : [];
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const label = (v: string | number | null) => {
          if (input.group_by === "category" || input.group_by === "parent_category") return v ? categoryPath(idx, Number(v)) : "Uncategorized";
          if (input.group_by === "weekday") return days[Number(v)];
          if (input.group_by === "account") return accounts.find((a) => a.id === Number(v))?.name ?? "Unknown account";
          return String(v ?? "Unknown");
        };
        if (!rows.length) return "No matching transactions.";
        return rows.map((r) => `${label(r.g)}: ${formatMoney(Math.abs(r.total))} (${r.n} transactions)`).join("\n");
      },
    }),
    betaZodTool({
      name: "find_transactions",
      description: "List individual transactions matching filters, newest first.",
      inputSchema: z.object({
        date_from: z.string().nullable().optional(),
        date_to: z.string().nullable().optional(),
        text: z.string().nullable().optional().describe("Substring of merchant, description or note"),
        category: z.string().nullable().optional(),
        min_amount: z.number().nullable().optional().describe("Minimum absolute amount in AZN"),
        kind: z.enum(["expense", "income", "transfer"]).nullable().optional(),
        limit: z.number().int().min(1).max(40).default(20),
      }),
      run: async (input) => {
        const where = ["1 = 1"];
        const params: (string | number)[] = [];
        const add = (clause: string, value: string | number) => {
          where.push(clause);
          params.push(value);
        };
        if (input.date_from) add("t.local_date >= ?", input.date_from);
        if (input.date_to) add("t.local_date <= ?", input.date_to);
        if (input.kind) add("t.kind = ?", input.kind);
        if (input.min_amount) add("ABS(t.amount_base) >= ?", Math.round(input.min_amount * 100));
        if (input.text) {
          where.push("(m.name LIKE ? OR t.merchant_raw LIKE ? OR t.description LIKE ? OR t.note LIKE ?)");
          params.push(...Array(4).fill(`%${input.text}%`));
        }
        const catIds = resolveCategoryIds(input.category);
        if (catIds?.length) where.push(`t.category_id IN (${catIds.join(",")})`);
        const rows = await all<{ local_date: string; amount_base: number; merchant_name: string | null; merchant_raw: string | null; description: string | null; category_id: number | null; note: string | null }>(
          env.DB,
          `${TX_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.occurred_at DESC LIMIT ?`,
          ...params,
          input.limit,
        );
        if (!rows.length) return "No matching transactions.";
        return rows
          .map(
            (r) =>
              `${r.local_date} | ${formatMoney(r.amount_base, "AZN", { sign: true })} | ${r.merchant_name ?? r.merchant_raw ?? r.description ?? "—"} | ${r.category_id ? categoryPath(idx, r.category_id) : "—"}${r.note ? ` | note: ${r.note}` : ""}`,
          )
          .join("\n");
      },
    }),
    betaZodTool({
      name: "budgets_and_subscriptions",
      description: "Current budgets with spending so far this period, and detected subscriptions / recurring bills.",
      inputSchema: z.object({}),
      run: async () => {
        const settings = await getSettings(env);
        const now = today(settings);
        const period = shiftPeriod(now, settings.month_start_day, 0);
        const b = await budgetStatus(env.DB, idx, settings, period, now);
        const rec = (await recurring(env)).filter((r) => r.active);
        const lines = [`Current period ${period.start} to ${period.end}. Total spent so far: ${formatMoney(b.total_spent)}.`];
        if (b.overall) lines.push(`Overall budget ${formatMoney(b.overall.amount)}, spent ${formatMoney(b.overall.spent)}.`);
        for (const x of b.categories)
          lines.push(`Budget ${categoryPath(idx, x.category_id!)}: limit ${formatMoney(x.amount)}, spent ${formatMoney(x.spent)} (${x.status}).`);
        if (!b.categories.length && !b.overall) lines.push("No budgets set.");
        lines.push("Recurring payments:");
        for (const r of rec) lines.push(`- ${r.name}: ${formatMoney(r.amount)} ${r.cadence}, next ~${r.next_date}`);
        if (!rec.length) lines.push("- none detected yet");
        return lines.join("\n");
      },
    }),
  ];
}

export async function chat(env: Env, history: ChatMessage[]): Promise<{ reply: string } | { error: string }> {
  const settings = await getSettings(env);
  const blocked = await aiBlocked(env, settings);
  if (blocked) return { error: describeBlock(blocked) };
  const idx = await loadCategories(env.DB);
  const now = today(settings);
  const period = shiftPeriod(now, settings.month_start_day, 0);
  const model = settings.ai_smart_model;
  const client = aiClient(env);

  const system = [
    COACH_SYSTEM,
    "Answer questions about the person's own money using the tools; always look the numbers up instead of guessing.",
    "Reply concisely in the language of the question (English, Azerbaijani or Russian). Use short paragraphs or bullet points.",
  ].join(" ");

  const messages: Anthropic.Beta.BetaMessageParam[] = history.slice(-12).map((m) => ({ role: m.role, content: m.content }));
  // The date-dependent block comes after the cache breakpoint so tools + instructions stay cached.
  const dateInfo = `Today is ${now}. The current budget period is ${period.start} to ${period.end} (periods start on day ${settings.month_start_day} of the month).`;

  const runner = client.beta.messages.toolRunner({
    model,
    max_tokens: 16000,
    system: [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
      { type: "text", text: dateInfo },
    ],
    tools: chatTools(env, idx),
    messages,
    output_config: { effort: "low" },
    thread: false,
    max_iterations: 6,
    ...fallbackParams(model),
  });

  let reply = "";
  for await (const message of runner) {
    await recordUsage(env.DB, "chat", message.model ?? model, message.usage);
    if (message.stop_reason === "refusal") return { error: "The AI declined to answer that question." };
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) reply = text;
  }
  return { reply: reply || "I couldn't find an answer to that." };
}
