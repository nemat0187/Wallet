// Categories, merchants and rules.

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { Category, Merchant, Rule } from "@shared/types";
import { badRequest, body, intParam, notFound } from "../lib/http";
import { all, first, insert, nowIso, run, type SqlValue } from "../lib/db";
import { loadCategories, ruleMatches, setMerchantCategory } from "../services/categorize";

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Categories

app.get("/categories", async (c) => {
  const rows = await all<Category & { tx_count: number }>(
    c.env.DB,
    `SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS tx_count
       FROM categories c ORDER BY c.kind, c.sort_order, c.id`,
  );
  return c.json(rows);
});

const CategoryInput = z.object({
  name: z.string().trim().min(1).max(60),
  parent_id: z.number().int().nullable().optional(),
  kind: z.enum(["expense", "income", "transfer"]).optional(),
  icon: z.string().max(16).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  archived: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

app.post("/categories", async (c) => {
  const input = await body(c, CategoryInput);
  let kind = input.kind ?? "expense";
  if (input.parent_id) {
    const parent = await first<Category>(c.env.DB, "SELECT * FROM categories WHERE id = ?", input.parent_id);
    if (!parent) badRequest("Parent category not found");
    if (parent.parent_id) badRequest("Categories can be two levels deep (category → subcategory)");
    kind = parent.kind;
  }
  const max = await first<{ m: number | null }>(
    c.env.DB,
    "SELECT MAX(sort_order) AS m FROM categories WHERE parent_id IS ?",
    input.parent_id ?? null,
  );
  const id = await insert(
    c.env.DB,
    "INSERT INTO categories (parent_id, name, kind, icon, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    input.parent_id ?? null,
    input.name,
    kind,
    input.icon ?? "📁",
    input.color ?? null,
    (max?.m ?? 0) + 1,
    nowIso(),
  );
  return c.json({ id });
});

app.patch("/categories/:id", async (c) => {
  const id = intParam(c, "id");
  const input = await body(c, CategoryInput.partial());
  const existing = await first<Category>(c.env.DB, "SELECT * FROM categories WHERE id = ?", id);
  if (!existing) notFound();
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const set = (col: string, v: SqlValue) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  if (input.name !== undefined) set("name", input.name);
  if (input.icon !== undefined) set("icon", input.icon);
  if (input.color !== undefined) set("color", input.color);
  if (input.archived !== undefined) set("archived", input.archived ? 1 : 0);
  if (input.sort_order !== undefined) set("sort_order", input.sort_order);
  if (input.parent_id !== undefined && input.parent_id !== existing.parent_id) {
    if (input.parent_id === id) badRequest("A category can't be its own parent");
    const hasChildren = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM categories WHERE parent_id = ?", id);
    if (input.parent_id && hasChildren?.n) badRequest("Move or delete its subcategories first");
    set("parent_id", input.parent_id);
  }
  if (sets.length) await run(c.env.DB, `UPDATE categories SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
  return c.json({ ok: true });
});

/** Delete a category, moving its transactions (and those of its subcategories) to `reassign_to`. */
app.delete("/categories/:id", async (c) => {
  const id = intParam(c, "id");
  const target = Number(c.req.query("reassign_to")) || null;
  const idx = await loadCategories(c.env.DB);
  const cat = idx.byId.get(id);
  if (!cat) notFound();
  if (cat.slug === "uncategorized") badRequest("This category is needed as a fallback and can't be deleted");
  const fallbackId = target ?? idx.bySlug.get(cat.kind === "income" ? "income.other" : cat.kind === "transfer" ? "transfer.own" : "uncategorized")?.id;
  if (!fallbackId || fallbackId === id) badRequest("Choose another category to move transactions to");
  const ids = [id, ...idx.list.filter((x) => x.parent_id === id).map((x) => x.id)];
  if (ids.includes(fallbackId)) badRequest("Can't move transactions into a category that is being deleted");
  const inList = ids.join(",");
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE transactions SET category_id = ?, updated_at = ? WHERE category_id IN (${inList})`).bind(fallbackId, nowIso()),
    c.env.DB.prepare(`UPDATE merchants SET category_id = ? WHERE category_id IN (${inList})`).bind(fallbackId),
    c.env.DB.prepare(`DELETE FROM categories WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Merchants

app.get("/merchants", async (c) => {
  const q = c.req.query("q");
  const rows = await all<Merchant>(
    c.env.DB,
    `SELECT m.*, COUNT(t.id) AS tx_count, -SUM(CASE WHEN t.amount_base < 0 THEN t.amount_base ELSE 0 END) AS total_spent,
            MAX(t.local_date) AS last_seen
       FROM merchants m LEFT JOIN transactions t ON t.merchant_id = m.id
      ${q ? "WHERE m.name LIKE ? OR m.key LIKE ?" : ""}
      GROUP BY m.id ORDER BY tx_count DESC, m.name LIMIT 500`,
    ...(q ? [`%${q}%`, `%${q.toUpperCase()}%`] : []),
  );
  return c.json(rows);
});

app.patch("/merchants/:id", async (c) => {
  const id = intParam(c, "id");
  const input = await body(
    c,
    z.object({ name: z.string().trim().min(1).max(80).optional(), category_id: z.number().int().optional(), apply_to_past: z.boolean().optional() }),
  );
  const m = await first<Merchant>(c.env.DB, "SELECT * FROM merchants WHERE id = ?", id);
  if (!m) notFound();
  let applied = 0;
  if (input.category_id !== undefined) {
    applied = await setMerchantCategory(c.env.DB, id, input.category_id, { applyToPast: input.apply_to_past ?? true, name: input.name });
  } else if (input.name) {
    await run(c.env.DB, "UPDATE merchants SET name = ?, updated_at = ? WHERE id = ?", input.name, nowIso(), id);
  }
  return c.json({ ok: true, applied });
});

// ---------------------------------------------------------------------------
// Rules

app.get("/rules", async (c) => c.json(await all<Rule>(c.env.DB, "SELECT * FROM rules ORDER BY priority, id")));

const RuleInput = z.object({
  name: z.string().max(80).nullable().optional(),
  match_field: z.enum(["merchant", "description", "any"]).default("any"),
  match_type: z.enum(["contains", "equals", "starts_with", "regex"]).default("contains"),
  pattern: z.string().trim().min(1).max(200),
  direction: z.enum(["in", "out"]).nullable().optional(),
  min_amount: z.number().int().nullable().optional(),
  max_amount: z.number().int().nullable().optional(),
  account_id: z.number().int().nullable().optional(),
  set_category_id: z.number().int().nullable().optional(),
  set_kind: z.enum(["expense", "income", "transfer"]).nullable().optional(),
  set_merchant_name: z.string().max(80).nullable().optional(),
  set_excluded: z.boolean().nullable().optional(),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
});

function validateRegex(input: { match_type?: string; pattern?: string }) {
  if (input.match_type === "regex" && input.pattern) {
    try {
      new RegExp(input.pattern, "i");
    } catch {
      badRequest("The pattern is not a valid regular expression");
    }
  }
}

app.post("/rules", async (c) => {
  const r = await body(c, RuleInput);
  validateRegex(r);
  if (!r.set_category_id && !r.set_kind && !r.set_merchant_name && r.set_excluded == null) badRequest("A rule must change something");
  const id = await insert(
    c.env.DB,
    `INSERT INTO rules (name, match_field, match_type, pattern, direction, min_amount, max_amount, account_id, set_category_id,
       set_kind, set_merchant_name, set_excluded, priority, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.name ?? null,
    r.match_field,
    r.match_type,
    r.pattern,
    r.direction ?? null,
    r.min_amount ?? null,
    r.max_amount ?? null,
    r.account_id ?? null,
    r.set_category_id ?? null,
    r.set_kind ?? null,
    r.set_merchant_name ?? null,
    r.set_excluded == null ? null : r.set_excluded ? 1 : 0,
    r.priority,
    r.enabled ? 1 : 0,
    nowIso(),
  );
  return c.json({ id });
});

app.patch("/rules/:id", async (c) => {
  const id = intParam(c, "id");
  const r = await body(c, RuleInput.partial());
  validateRegex(r);
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(typeof v === "boolean" ? (v ? 1 : 0) : (v as SqlValue));
  }
  if (sets.length) await run(c.env.DB, `UPDATE rules SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
  return c.json({ ok: true });
});

app.delete("/rules/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM rules WHERE id = ?", intParam(c, "id"));
  return c.json({ ok: true });
});

/** Apply a rule to existing transactions (preview with ?dry=1). */
app.post("/rules/:id/apply", async (c) => {
  const id = intParam(c, "id");
  const dry = c.req.query("dry") === "1";
  const rule = await first<Rule>(c.env.DB, "SELECT * FROM rules WHERE id = ?", id);
  if (!rule) notFound();
  // Narrow down in SQL first (LIKE is case-insensitive for ASCII), then check each candidate exactly.
  const asciiPattern = rule.match_type !== "regex" && /^[\x20-\x7e]+$/.test(rule.pattern);
  const like = `%${rule.pattern.replace(/[%_]/g, "")}%`;
  const txs = await all<{ id: number; merchant_raw: string | null; description: string | null; amount: number; account_id: number | null; merchant_name: string | null }>(
    c.env.DB,
    `SELECT t.id, t.merchant_raw, t.description, t.amount, t.account_id, m.name AS merchant_name
       FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id
      ${asciiPattern ? "WHERE t.merchant_raw LIKE ? OR t.description LIKE ? OR m.name LIKE ?" : ""}`,
    ...(asciiPattern ? [like, like, like] : []),
  );
  const matched = txs.filter((t) =>
    ruleMatches(rule, { ...t, merchant: t.merchant_name ? { name: t.merchant_name } : null }, t.amount >= 0 ? "in" : "out"),
  );
  if (dry) return c.json({ matched: matched.length });
  const cat = rule.set_category_id ? await first<Category>(c.env.DB, "SELECT * FROM categories WHERE id = ?", rule.set_category_id) : null;
  const now = nowIso();
  const sets = ["updated_at = ?", "category_source = 'rule'", "needs_review = 0"];
  const params: SqlValue[] = [now];
  if (cat) {
    sets.push("category_id = ?", "kind = ?");
    params.push(cat.id, rule.set_kind ?? cat.kind);
  } else if (rule.set_kind) {
    sets.push("kind = ?");
    params.push(rule.set_kind);
  }
  if (rule.set_excluded !== null) {
    sets.push("excluded = ?");
    params.push(rule.set_excluded);
  }
  const update = c.env.DB.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`);
  const stmts = matched.map((t) => update.bind(...params, t.id));
  for (let i = 0; i < stmts.length; i += 100) await c.env.DB.batch(stmts.slice(i, i + 100));
  await run(c.env.DB, "UPDATE rules SET hits = hits + ? WHERE id = ?", matched.length, id);
  return c.json({ matched: matched.length });
});

export default app;
