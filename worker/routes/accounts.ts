import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { Account } from "@shared/types";
import { badRequest, body, intParam, notFound } from "../lib/http";
import { all, first, insert, nowIso, run, type SqlValue } from "../lib/db";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const rows = await all<Account & { tx_count: number; last_tx: string | null }>(
    c.env.DB,
    `SELECT a.*, (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS tx_count,
            (SELECT MAX(occurred_at) FROM transactions t WHERE t.account_id = a.id) AS last_tx
       FROM accounts a ORDER BY a.archived, a.sort_order, a.id`,
  );
  return c.json(rows);
});

const AccountInput = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(["card", "cash", "savings", "other"]).default("card"),
  institution: z.string().max(60).nullable().optional(),
  card_last4: z.string().regex(/^\d{4}$/).nullable().optional(),
  currency: z.string().length(3).default("AZN"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  balance: z.number().int().nullable().optional(),
  include_in_totals: z.boolean().optional(),
  archived: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

app.post("/", async (c) => {
  const a = await body(c, AccountInput);
  const id = await insert(
    c.env.DB,
    `INSERT INTO accounts (name, type, institution, card_last4, currency, color, balance, balance_at, include_in_totals, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.name,
    a.type,
    a.institution ?? (a.type === "card" ? "ABB" : null),
    a.card_last4 ?? null,
    a.currency.toUpperCase(),
    a.color ?? "#2563eb",
    a.balance ?? null,
    a.balance !== undefined && a.balance !== null ? nowIso() : null,
    a.include_in_totals === false ? 0 : 1,
    a.sort_order ?? 10,
    nowIso(),
  );
  return c.json({ id });
});

app.patch("/:id", async (c) => {
  const id = intParam(c, "id");
  const a = await body(c, AccountInput.partial());
  if (!(await first(c.env.DB, "SELECT id FROM accounts WHERE id = ?", id))) notFound();
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(typeof v === "boolean" ? (v ? 1 : 0) : k === "currency" ? String(v).toUpperCase() : (v as SqlValue));
  }
  if (a.balance !== undefined) {
    sets.push("balance_at = ?");
    params.push(nowIso());
  }
  if (sets.length) await run(c.env.DB, `UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
  return c.json({ ok: true });
});

/** Merge one account into another (e.g. a card that was auto-created twice). */
app.post("/:id/merge-into/:target", async (c) => {
  const id = intParam(c, "id");
  const target = intParam(c, "target");
  if (id === target) badRequest("Pick a different account");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE transactions SET account_id = ? WHERE account_id = ?").bind(target, id),
    c.env.DB.prepare("UPDATE rules SET account_id = ? WHERE account_id = ?").bind(target, id),
    c.env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

app.delete("/:id", async (c) => {
  const id = intParam(c, "id");
  const used = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?", id);
  if (used?.n) {
    await run(c.env.DB, "UPDATE accounts SET archived = 1 WHERE id = ?", id);
    return c.json({ ok: true, archived: true });
  }
  await run(c.env.DB, "DELETE FROM accounts WHERE id = ?", id);
  return c.json({ ok: true, archived: false });
});

export default app;
