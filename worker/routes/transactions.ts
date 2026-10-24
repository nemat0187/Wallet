import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { Transaction } from "@shared/types";
import { badRequest, body, intParam, notFound } from "../lib/http";
import { all, first, nowIso, placeholders, run, type SqlValue } from "../lib/db";
import { createContext, createTransaction } from "../services/transactions";
import { loadCategories, setMerchantCategory, upsertMerchant } from "../services/categorize";
import { afterTransactions } from "../services/alerts";
import { TX_SELECT } from "../services/analytics";
import { convert } from "../services/fx";

const app = new Hono<AppEnv>();

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

app.get("/", async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const params: SqlValue[] = [];
  const add = (clause: string, ...values: SqlValue[]) => {
    where.push(clause);
    params.push(...values);
  };
  if (q.from) add("t.local_date >= ?", q.from);
  if (q.to) add("t.local_date <= ?", q.to);
  if (q.account) add("t.account_id = ?", Number(q.account));
  if (q.kind) add("t.kind = ?", q.kind);
  if (q.review === "1") add("t.needs_review = 1");
  if (q.merchant) add("t.merchant_id = ?", Number(q.merchant));
  if (q.min) add("ABS(t.amount_base) >= ?", Number(q.min));
  if (q.category) {
    // Include subcategories when filtering by a parent category.
    const id = Number(q.category);
    add("(t.category_id = ? OR t.category_id IN (SELECT id FROM categories WHERE parent_id = ?))", id, id);
  }
  if (q.q) {
    const like = `%${q.q.trim()}%`;
    add("(m.name LIKE ? OR t.merchant_raw LIKE ? OR t.description LIKE ? OR t.note LIKE ? OR t.tags LIKE ?)", like, like, like, like, like);
  }
  // Keyset pagination: cursor = "<occurred_at>|<id>" of the last row seen.
  if (q.cursor) {
    const [at, id] = q.cursor.split("|");
    add("(t.occurred_at < ? OR (t.occurred_at = ? AND t.id < ?))", at, at, Number(id));
  }
  const limit = Math.min(Number(q.limit) || 50, 200);
  const rows = await all<Transaction>(
    c.env.DB,
    `${TX_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.occurred_at DESC, t.id DESC LIMIT ?`,
    ...params,
    limit + 1,
  );
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return c.json({ items, next_cursor: more && last ? `${last.occurred_at}|${last.id}` : null });
});

app.get("/:id", async (c) => {
  const tx = await first<Transaction>(c.env.DB, `${TX_SELECT} WHERE t.id = ?`, intParam(c, "id"));
  if (!tx) notFound();
  const message = await first(c.env.DB, "SELECT id, body, received_at, parse_method FROM raw_messages WHERE transaction_id = ?", tx.id);
  return c.json({ ...tx, message });
});

const NewTx = z.object({
  account_id: z.number().int().nullable(),
  date: ymd,
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  amount: z.number().int().positive().describe("minor units"),
  direction: z.enum(["in", "out"]),
  currency: z.string().length(3).optional(),
  merchant: z.string().max(120).optional().nullable(),
  category_id: z.number().int().nullable().optional(),
  note: z.string().max(500).optional().nullable(),
  tags: z.string().max(200).optional().nullable(),
});

app.post("/", async (c) => {
  const input = await body(c, NewTx);
  const ctx = await createContext(c.env);
  const offset = ctx.settings.tz_offset_minutes;
  const [h, mi] = (input.time ?? "12:00").split(":").map(Number);
  const [y, mo, d] = input.date.split("-").map(Number);
  const occurred = new Date(Date.UTC(y, mo - 1, d, h, mi) - offset * 60_000);
  const account = input.account_id
    ? await first<{ currency: string }>(c.env.DB, "SELECT currency FROM accounts WHERE id = ?", input.account_id)
    : null;
  const created = await createTransaction(
    c.env,
    {
      account_id: input.account_id,
      occurred_at: occurred.toISOString(),
      amount: input.direction === "in" ? input.amount : -input.amount,
      currency: input.currency ?? account?.currency ?? ctx.settings.base_currency,
      merchant_raw: input.merchant ?? null,
      note: input.note ?? null,
      tags: input.tags ?? null,
      source: "manual",
      type: input.direction === "in" ? "income" : "purchase",
      category_id: input.category_id ?? null,
    },
    ctx,
  );
  c.executionCtx.waitUntil(afterTransactions(c.env, [created.id], { needsAi: created.needs_ai }));
  return c.json({ id: created.id });
});

const PatchTx = z.object({
  category_id: z.number().int().optional(),
  apply_to_merchant: z.boolean().optional(),
  kind: z.enum(["expense", "income", "transfer"]).optional(),
  note: z.string().max(500).nullable().optional(),
  tags: z.string().max(200).nullable().optional(),
  excluded: z.boolean().optional(),
  merchant_name: z.string().min(1).max(120).optional(),
  account_id: z.number().int().nullable().optional(),
  date: ymd.optional(),
  amount: z.number().int().positive().optional(),
  direction: z.enum(["in", "out"]).optional(),
  reviewed: z.boolean().optional(),
});

app.patch("/:id", async (c) => {
  const id = intParam(c, "id");
  const input = await body(c, PatchTx);
  const tx = await first<Transaction>(c.env.DB, "SELECT * FROM transactions WHERE id = ?", id);
  if (!tx) notFound();
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const set = (col: string, v: SqlValue) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  let applied = 0;

  if (input.category_id !== undefined) {
    const idx = await loadCategories(c.env.DB);
    const cat = idx.byId.get(input.category_id);
    if (!cat) badRequest("Unknown category");
    set("category_id", cat.id);
    set("category_source", "user");
    set("needs_review", 0);
    if (input.kind === undefined) set("kind", cat.kind);
    // Learn: remember this merchant's category and (optionally) fix its other transactions.
    if (tx.merchant_id && input.apply_to_merchant !== false) {
      applied = await setMerchantCategory(c.env.DB, tx.merchant_id, cat.id, { applyToPast: input.apply_to_merchant === true });
    }
  }
  if (input.kind !== undefined) set("kind", input.kind);
  if (input.note !== undefined) set("note", input.note);
  if (input.tags !== undefined) set("tags", input.tags);
  if (input.excluded !== undefined) set("excluded", input.excluded ? 1 : 0);
  if (input.reviewed) set("needs_review", 0);
  if (input.account_id !== undefined) set("account_id", input.account_id);
  if (input.date !== undefined) {
    // Move to the new day, keeping the time of day.
    const shift = Date.parse(`${input.date}T00:00:00Z`) - Date.parse(`${tx.local_date}T00:00:00Z`);
    set("local_date", input.date);
    set("occurred_at", new Date(Date.parse(tx.occurred_at) + shift).toISOString());
  }
  if (input.amount !== undefined || input.direction !== undefined) {
    const abs = input.amount ?? Math.abs(tx.amount);
    const dir = input.direction ?? (tx.amount >= 0 ? "in" : "out");
    const signed = dir === "in" ? abs : -abs;
    set("amount", signed);
    set("amount_base", tx.currency === "AZN" ? signed : await convert(c.env.DB, signed, tx.currency, "AZN", tx.local_date));
  }
  if (input.merchant_name) {
    const merchant = await upsertMerchant(c.env.DB, input.merchant_name);
    if (tx.merchant_id && merchant.id !== tx.merchant_id) {
      // Renaming keeps the original merchant key; store the display name on it.
      await run(c.env.DB, "UPDATE merchants SET name = ?, updated_at = ? WHERE id = ?", input.merchant_name, nowIso(), tx.merchant_id);
    } else if (!tx.merchant_id) {
      set("merchant_id", merchant.id);
      set("merchant_raw", input.merchant_name);
    }
  }
  if (sets.length) {
    set("updated_at", nowIso());
    await run(c.env.DB, `UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
  }
  return c.json({ ok: true, applied_to_others: applied });
});

app.post("/bulk", async (c) => {
  const input = await body(
    c,
    z.object({
      ids: z.array(z.number().int()).min(1).max(500),
      category_id: z.number().int().optional(),
      excluded: z.boolean().optional(),
      reviewed: z.boolean().optional(),
      delete: z.boolean().optional(),
    }),
  );
  const ph = placeholders(input.ids.length);
  if (input.delete) {
    await run(c.env.DB, `DELETE FROM transactions WHERE id IN (${ph})`, ...input.ids);
    return c.json({ ok: true });
  }
  const now = nowIso();
  if (input.category_id !== undefined) {
    const cat = await first<{ id: number; kind: string }>(c.env.DB, "SELECT id, kind FROM categories WHERE id = ?", input.category_id);
    if (!cat) badRequest("Unknown category");
    await run(
      c.env.DB,
      `UPDATE transactions SET category_id = ?, kind = ?, category_source = 'user', needs_review = 0, updated_at = ? WHERE id IN (${ph})`,
      cat.id,
      cat.kind,
      now,
      ...input.ids,
    );
  }
  if (input.excluded !== undefined)
    await run(c.env.DB, `UPDATE transactions SET excluded = ?, updated_at = ? WHERE id IN (${ph})`, input.excluded ? 1 : 0, now, ...input.ids);
  if (input.reviewed) await run(c.env.DB, `UPDATE transactions SET needs_review = 0 WHERE id IN (${ph})`, ...input.ids);
  return c.json({ ok: true });
});

app.delete("/:id", async (c) => {
  const id = intParam(c, "id");
  await run(c.env.DB, "UPDATE raw_messages SET transaction_id = NULL, status = 'ignored' WHERE transaction_id = ?", id);
  await run(c.env.DB, "DELETE FROM transactions WHERE id = ?", id);
  return c.json({ ok: true });
});

export default app;
