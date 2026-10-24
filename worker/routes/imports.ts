// Importing bank statements: CSV (parsed and mapped in the browser) or PDF (read by AI).

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { body } from "../lib/http";
import { all } from "../lib/db";
import { sha256Hex } from "../lib/crypto";
import { addDays } from "@shared/money";
import { aiBlocked, describeBlock, structuredCall } from "../services/ai";
import { getSettings } from "../services/settings";
import { createContext, createTransaction } from "../services/transactions";
import { categorizeAllPending } from "../services/categorize";

const app = new Hono<AppEnv>();

const Row = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  amount: z.number().int().describe("signed minor units, negative = money out"),
  currency: z.string().length(3).optional(),
  description: z.string().max(300),
  category_id: z.number().int().nullable().optional(),
});
type ImportRow = z.infer<typeof Row>;

/** Mark rows that already exist (same account, same amount, date ±1 day — e.g. already recorded from SMS). */
async function markDuplicates(db: D1Database, accountId: number | null, rows: ImportRow[]): Promise<boolean[]> {
  if (!rows.length) return [];
  const dates = rows.map((r) => r.date).sort();
  const existing = await all<{ local_date: string; amount: number }>(
    db,
    `SELECT local_date, amount FROM transactions WHERE local_date BETWEEN ? AND ? AND ${accountId ? "account_id = ?" : "account_id IS NULL"}`,
    addDays(dates[0], -1),
    addDays(dates[dates.length - 1], 1),
    ...(accountId ? [accountId] : []),
  );
  const pool = existing.map((e) => ({ ...e, used: false }));
  return rows.map((r) => {
    const near = new Set([addDays(r.date, -1), r.date, addDays(r.date, 1)]);
    const hit = pool.find((e) => !e.used && e.amount === r.amount && near.has(e.local_date));
    if (hit) hit.used = true;
    return Boolean(hit);
  });
}

app.post("/preview", async (c) => {
  const input = await body(c, z.object({ account_id: z.number().int().nullable(), rows: z.array(Row).max(5000) }));
  return c.json({ duplicates: await markDuplicates(c.env.DB, input.account_id, input.rows) });
});

app.post("/commit", async (c) => {
  const input = await body(
    c,
    z.object({ account_id: z.number().int().nullable(), rows: z.array(Row).max(2000), skip_duplicates: z.boolean().default(true) }),
  );
  const dup = input.skip_duplicates ? await markDuplicates(c.env.DB, input.account_id, input.rows) : input.rows.map(() => false);
  const ctx = await createContext(c.env);
  const offset = ctx.settings.tz_offset_minutes;
  const ids: number[] = [];
  let skipped = 0;
  let needsAi = false;
  for (const [i, r] of input.rows.entries()) {
    if (dup[i]) {
      skipped++;
      continue;
    }
    const [y, m, d] = r.date.split("-").map(Number);
    const [h, mi] = (r.time ?? "12:00").split(":").map(Number);
    const occurred = new Date(Date.UTC(y, m - 1, d, h, mi) - offset * 60_000).toISOString();
    const ref = `imp:${input.account_id ?? 0}:${r.date}:${r.time ?? ""}:${r.amount}:${(await sha256Hex(r.description)).slice(0, 12)}:${i}`;
    const created = await createTransaction(
      c.env,
      {
        account_id: input.account_id,
        occurred_at: occurred,
        amount: r.amount,
        currency: r.currency ?? ctx.settings.base_currency,
        merchant_raw: r.description,
        source: "import",
        external_ref: ref,
        type: r.amount >= 0 ? "income" : "purchase",
        category_id: r.category_id ?? null,
      },
      ctx,
    );
    if (created.duplicate) skipped++;
    else ids.push(created.id);
    needsAi ||= created.needs_ai;
  }
  // Categorize new merchants in the background (no per-transaction notifications for imports).
  if (needsAi) c.executionCtx.waitUntil(categorizeAllPending(c.env));
  return c.json({ imported: ids.length, skipped });
});

const StatementSchema = z.object({
  card_last4: z.string().nullable().describe("Last 4 digits of the card/account the statement belongs to, if shown"),
  currency: z.string().describe("Account currency, e.g. AZN"),
  transactions: z.array(
    z.object({
      date: z.string().describe("YYYY-MM-DD"),
      time: z.string().nullable().describe("HH:MM if shown"),
      description: z.string().describe("Merchant or description exactly as printed"),
      amount: z.number().describe("Decimal amount in the account currency; NEGATIVE for money out, POSITIVE for money in"),
    }),
  ),
});

/** Read a PDF statement with AI and return rows for the user to review before importing. */
app.post("/pdf", async (c) => {
  const input = await body(c, z.object({ file_base64: z.string().min(100).max(14_000_000) }));
  const settings = await getSettings(c.env);
  const blocked = await aiBlocked(c.env, settings);
  if (blocked) throw new HTTPException(400, { message: describeBlock(blocked) });
  const { data } = await structuredCall(c.env, {
    purpose: "statement",
    model: settings.ai_fast_model,
    system:
      "You read bank account/card statements and list every transaction row. Skip opening/closing balance lines and totals. " +
      "Use the sign convention: money leaving the account is negative, money arriving is positive. Never invent rows.",
    content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.file_base64 } },
      { type: "text", text: "List all transactions in this statement." },
    ],
    schema: StatementSchema,
    maxTokens: 32000,
    effort: "low",
    timeoutMs: 10 * 60_000,
  });
  if (!data) throw new HTTPException(400, { message: "Couldn't read this statement. If it is long, try a single month." });
  const rows = data.transactions
    .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date) && Number.isFinite(t.amount) && t.amount !== 0)
    .map((t) => ({
      date: t.date,
      time: t.time && /^\d{2}:\d{2}$/.test(t.time) ? t.time : null,
      description: t.description.slice(0, 300),
      amount: Math.round(t.amount * 100),
      currency: (data.currency || "AZN").toUpperCase().slice(0, 3),
    }));
  return c.json({ card_last4: data.card_last4, currency: data.currency, rows });
});

export default app;
