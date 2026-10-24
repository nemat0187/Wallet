// Categories, merchants and rules.

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { Category, Merchant, Rule } from "@shared/types";
import { badRequest, body, intParam, notFound } from "../lib/http";
import { all, first, insert, nowIso, run, type SqlValue } from "../lib/db";
import { defaultCategoryFor, loadCategories, setMerchantCategory, type CategoryIndex } from "../services/categorize";
import { getSettings } from "../services/settings";
import { localParts, mergeTags, ruleMatches, type RuleContext } from "@shared/rules";

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

const ConditionSchema = z.union([
  z.object({
    field: z.enum(["merchant", "description", "message", "any_text"]),
    op: z.enum(["contains", "not_contains", "equals", "starts_with", "ends_with", "regex"]),
    value: z.string().max(200),
  }),
  z.object({
    field: z.literal("amount"),
    op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "between"]),
    value: z.number().int().min(0),
    value2: z.number().int().min(0).nullable().optional(),
  }),
  z.object({ field: z.literal("direction"), op: z.literal("is"), value: z.enum(["in", "out"]) }),
  z.object({
    field: z.enum(["account", "type", "weekday", "currency", "category"]),
    op: z.enum(["is", "is_not"]),
    value: z.array(z.union([z.number(), z.string().max(40)])).min(1).max(100),
  }),
  z.object({ field: z.literal("hour"), op: z.literal("between"), value: z.number().int().min(0).max(23), value2: z.number().int().min(0).max(23) }),
]);

const RuleInput = z.object({
  name: z.string().max(80).nullable().optional(),
  conditions: z.array(ConditionSchema).min(1).max(20),
  match_mode: z.enum(["all", "any"]).default("all"),
  set_category_id: z.number().int().nullable().optional(),
  set_kind: z.enum(["expense", "income", "transfer"]).nullable().optional(),
  set_merchant_name: z.string().max(80).nullable().optional(),
  set_excluded: z.boolean().nullable().optional(),
  set_tags: z.string().max(200).nullable().optional(),
  set_note: z.string().max(300).nullable().optional(),
  continue_after: z.boolean().default(false),
  priority: z.number().int().optional(),
  enabled: z.boolean().default(true),
});
type RuleBody = z.infer<typeof RuleInput>;

function validateRule(r: RuleBody) {
  for (const cond of r.conditions) {
    if ("op" in cond && cond.op === "regex") {
      try {
        new RegExp(cond.value as string, "i");
      } catch {
        badRequest("A pattern is not a valid regular expression");
      }
    }
    if (cond.field === "amount" && cond.op === "between" && (cond.value2 === null || cond.value2 === undefined)) badRequest("Enter both amounts for “between”");
  }
  if (!r.set_category_id && !r.set_kind && !r.set_merchant_name && r.set_excluded == null && !r.set_tags?.trim() && !r.set_note?.trim()) {
    badRequest("A rule must change something");
  }
}

/** Store a rule; the legacy single-condition columns get a readable summary of the first text condition. */
function ruleColumns(r: RuleBody): Record<string, SqlValue> {
  const firstText = r.conditions.find((x) => typeof x.value === "string" && "op" in x && x.field !== "direction") as { value: string } | undefined;
  return {
    name: r.name ?? null,
    pattern: firstText?.value ?? "",
    match_field: "any",
    match_type: "contains",
    direction: null,
    min_amount: null,
    max_amount: null,
    account_id: null,
    conditions: JSON.stringify(r.conditions),
    match_mode: r.match_mode,
    set_category_id: r.set_category_id ?? null,
    set_kind: r.set_kind ?? null,
    set_merchant_name: r.set_merchant_name?.trim() || null,
    set_excluded: r.set_excluded == null ? null : r.set_excluded ? 1 : 0,
    set_tags: r.set_tags?.trim() || null,
    set_note: r.set_note?.trim() || null,
    continue_after: r.continue_after ? 1 : 0,
    enabled: r.enabled ? 1 : 0,
  };
}

app.post("/rules", async (c) => {
  const r = await body(c, RuleInput);
  validateRule(r);
  const cols = ruleColumns(r);
  const max = await first<{ p: number | null }>(c.env.DB, "SELECT MAX(priority) AS p FROM rules");
  cols.priority = r.priority ?? (max?.p ?? 0) + 10;
  cols.created_at = nowIso();
  const keys = Object.keys(cols);
  const id = await insert(c.env.DB, `INSERT INTO rules (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...Object.values(cols));
  return c.json({ id });
});

app.put("/rules/:id", async (c) => {
  const id = intParam(c, "id");
  const r = await body(c, RuleInput);
  validateRule(r);
  const cols = ruleColumns(r);
  if (r.priority !== undefined) cols.priority = r.priority;
  await run(c.env.DB, `UPDATE rules SET ${Object.keys(cols).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(cols), id);
  return c.json({ ok: true });
});

/** Turn a rule on/off without resending it. */
app.patch("/rules/:id", async (c) => {
  const { enabled } = await body(c, z.object({ enabled: z.boolean() }));
  await run(c.env.DB, "UPDATE rules SET enabled = ? WHERE id = ?", enabled ? 1 : 0, intParam(c, "id"));
  return c.json({ ok: true });
});

/** Save a new order (array of rule ids, first = checked first). */
app.post("/rules/reorder", async (c) => {
  const { ids } = await body(c, z.object({ ids: z.array(z.number().int()).max(500) }));
  if (ids.length) await c.env.DB.batch(ids.map((id, i) => c.env.DB.prepare("UPDATE rules SET priority = ? WHERE id = ?").bind((i + 1) * 10, id)));
  return c.json({ ok: true });
});

app.delete("/rules/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM rules WHERE id = ?", intParam(c, "id"));
  return c.json({ ok: true });
});

interface TxForRules {
  id: number;
  local_date: string;
  occurred_at: string;
  amount: number;
  currency: string;
  orig_currency: string | null;
  account_id: number | null;
  merchant_raw: string | null;
  merchant_name: string | null;
  merchant_id: number | null;
  description: string | null;
  message: string | null;
  tx_type: string | null;
  category_id: number | null;
  kind: string;
  tags: string | null;
  note: string | null;
}

async function loadForRules(db: D1Database): Promise<TxForRules[]> {
  return all<TxForRules>(
    db,
    `SELECT t.id, t.local_date, t.occurred_at, t.amount, t.currency, t.orig_currency, t.account_id, t.merchant_raw, m.name AS merchant_name,
            t.merchant_id, t.description, r.body AS message, t.tx_type, t.category_id, t.kind, t.tags, t.note
       FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id LEFT JOIN raw_messages r ON r.transaction_id = t.id
      ORDER BY t.occurred_at DESC LIMIT 20000`,
  );
}

function contextFor(t: TxForRules, idx: CategoryIndex, tz: number): RuleContext {
  const { weekday, hour } = localParts(t.occurred_at, tz);
  return {
    merchant: t.merchant_name,
    merchant_raw: t.merchant_raw,
    description: t.description,
    message: t.message,
    amount: t.amount,
    currency: t.orig_currency ?? t.currency,
    account_id: t.account_id,
    type: t.tx_type,
    local_weekday: weekday,
    local_hour: hour,
    category_id: t.category_id,
    category_parent_id: t.category_id ? (idx.byId.get(t.category_id)?.parent_id ?? null) : null,
  };
}

function asRule(r: RuleBody, id = 0): Rule {
  const cols = ruleColumns(r);
  return { ...(cols as unknown as Rule), id, priority: 0, hits: 0, enabled: 1 };
}

/** Preview: which existing transactions would a (possibly unsaved) rule match? */
app.post("/rules/test", async (c) => {
  const r = await body(c, z.object({ conditions: z.array(ConditionSchema).min(1).max(20), match_mode: z.enum(["all", "any"]).default("all") }));
  const rule = asRule({ conditions: r.conditions, match_mode: r.match_mode, continue_after: false, enabled: true });
  const [settings, idx, txs] = await Promise.all([getSettings(c.env), loadCategories(c.env.DB), loadForRules(c.env.DB)]);
  const matched = txs.filter((t) => ruleMatches(rule, contextFor(t, idx, settings.tz_offset_minutes)));
  return c.json({
    matched: matched.length,
    total: txs.length,
    spent: matched.reduce((s, t) => s + (t.amount < 0 ? -t.amount : 0), 0),
    sample: matched.slice(0, 25).map((t) => ({
      id: t.id,
      local_date: t.local_date,
      amount: t.amount,
      currency: t.currency,
      merchant: t.merchant_name ?? t.merchant_raw ?? t.description,
      category_id: t.category_id,
    })),
  });
});

/** Apply a saved rule to existing transactions. */
app.post("/rules/:id/apply", async (c) => {
  const id = intParam(c, "id");
  const rule = await first<Rule>(c.env.DB, "SELECT * FROM rules WHERE id = ?", id);
  if (!rule) notFound();
  const [settings, idx, txs] = await Promise.all([getSettings(c.env), loadCategories(c.env.DB), loadForRules(c.env.DB)]);
  const matched = txs.filter((t) => ruleMatches({ ...rule, enabled: 1 }, contextFor(t, idx, settings.tz_offset_minutes)));
  const now = nowIso();
  const cat = rule.set_category_id ? idx.byId.get(rule.set_category_id) : undefined;
  const stmts: D1PreparedStatement[] = [];
  const renamed = new Set<number>();
  for (const t of matched) {
    const sets: string[] = ["updated_at = ?"];
    const params: SqlValue[] = [now];
    let kind: string | null = null;
    let categoryId: number | null = null;
    if (cat) {
      categoryId = cat.id;
      kind = rule.set_kind ?? cat.kind;
    } else if (rule.set_kind && rule.set_kind !== t.kind) {
      kind = rule.set_kind;
      categoryId =
        rule.set_kind === "transfer"
          ? (idx.bySlug.get("transfer.own")?.id ?? null)
          : (defaultCategoryFor(idx, t.amount, t.tx_type)?.id ?? null);
    }
    if (categoryId) {
      sets.push("category_id = ?", "kind = ?", "category_source = 'rule'", "needs_review = 0");
      params.push(categoryId, kind);
    }
    if (rule.set_excluded !== null && rule.set_excluded !== undefined) {
      sets.push("excluded = ?");
      params.push(rule.set_excluded);
    }
    const tagList = (rule.set_tags ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (tagList.length) {
      sets.push("tags = ?");
      params.push(mergeTags(t.tags, tagList));
    }
    if (rule.set_note && !t.note) {
      sets.push("note = ?");
      params.push(rule.set_note);
    }
    stmts.push(c.env.DB.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`).bind(...params, t.id));
    if (rule.set_merchant_name && t.merchant_id && !renamed.has(t.merchant_id)) {
      renamed.add(t.merchant_id);
      stmts.push(c.env.DB.prepare("UPDATE merchants SET name = ?, updated_at = ? WHERE id = ?").bind(rule.set_merchant_name, now, t.merchant_id));
    }
  }
  for (let i = 0; i < stmts.length; i += 100) await c.env.DB.batch(stmts.slice(i, i + 100));
  await run(c.env.DB, "UPDATE rules SET hits = hits + ? WHERE id = ?", matched.length, id);
  return c.json({ matched: matched.length });
});

export default app;
