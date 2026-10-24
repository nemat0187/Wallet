// Automatic categorization. Cheapest and most trustworthy sources first:
//   1. merchant memory (past corrections, earlier AI answers)
//   2. the built-in merchant dictionary
//   3. sensible defaults from the transaction type
//   4. AI — only for merchants never seen before, and only once per merchant.
// The owner's rules (shared/rules.ts) are applied on top of the result, so they always win.

import { z } from "zod";
import type { Env } from "../env";
import type { Category, CategorySource, ParsedMessage, TxKind } from "@shared/types";
import { FALLBACK_SLUG } from "@shared/categories";
import { all, first, nowIso, placeholders, run } from "../lib/db";
import { builtinMatch, merchantKey, prettifyMerchant } from "./merchants";
import { aiBlocked, structuredCall } from "./ai";
import { getSettings } from "./settings";

export interface CategoryIndex {
  list: Category[];
  byId: Map<number, Category>;
  bySlug: Map<string, Category>;
}

export async function loadCategories(db: D1Database): Promise<CategoryIndex> {
  const list = await all<Category>(db, "SELECT * FROM categories ORDER BY sort_order, id");
  return {
    list,
    byId: new Map(list.map((c) => [c.id, c])),
    bySlug: new Map(list.filter((c) => c.slug).map((c) => [c.slug as string, c])),
  };
}

export function categoryPath(idx: CategoryIndex, id: number): string {
  const c = idx.byId.get(id);
  if (!c) return "";
  const parent = c.parent_id ? idx.byId.get(c.parent_id) : null;
  return parent ? `${parent.name} > ${c.name}` : c.name;
}

export interface MerchantRow {
  id: number;
  key: string;
  name: string;
  category_id: number | null;
  category_source: string | null;
}

/** Find or create the merchant record for a raw merchant string. */
export async function upsertMerchant(db: D1Database, raw: string): Promise<MerchantRow> {
  const key = merchantKey(raw);
  const existing = await first<MerchantRow>(db, "SELECT id, key, name, category_id, category_source FROM merchants WHERE key = ?", key);
  if (existing) return existing;
  const builtin = builtinMatch(key);
  const name = builtin?.name || prettifyMerchant(raw.length > 40 ? key : raw);
  const now = nowIso();
  await run(db, "INSERT OR IGNORE INTO merchants (key, name, created_at, updated_at) VALUES (?, ?, ?, ?)", key, name, now, now);
  return (await first<MerchantRow>(db, "SELECT id, key, name, category_id, category_source FROM merchants WHERE key = ?", key))!;
}

export interface CategorizeInput {
  merchant: MerchantRow | null;
  merchant_raw: string | null;
  description: string | null;
  amount: number; // signed minor units
  account_id: number | null;
  type: ParsedMessage["type"];
}

export interface CategorizeResult {
  category_id: number;
  category_source: CategorySource;
  kind: TxKind;
  merchant_name: string | null;
  excluded: boolean;
  needs_ai: boolean;
}

export async function categorize(
  db: D1Database,
  idx: CategoryIndex,
  input: CategorizeInput,
  opts: { atmAsTransfer: boolean },
): Promise<CategorizeResult> {
  const direction = input.amount >= 0 ? "in" : "out";
  const merchantName = input.merchant?.name ?? null;

  // Cash withdrawals and fees don't depend on the merchant.
  if (input.type === "cash_withdrawal") {
    const slug = opts.atmAsTransfer ? "transfer.own" : "cash";
    const cat = idx.bySlug.get(slug) ?? idx.bySlug.get("cash");
    return base(cat?.id ?? fallback(idx, "expense"), "default", cat?.kind ?? "expense", merchantName ?? "Cash withdrawal");
  }
  if (input.type === "fee") {
    return base(idx.bySlug.get("finance.fees")?.id ?? fallback(idx, "expense"), "default", "expense", merchantName ?? "Bank fee");
  }
  // Card-to-card transfers: "ABB MOBILE" etc. is the channel, not a shop, so merchant memory and AI
  // don't apply. Each card is tracked on its own: money out is spending, money in is income, until
  // the owner tags a pair as a transfer between their own cards.
  if (input.type === "transfer_in" || input.type === "transfer_out") {
    const cat = idx.bySlug.get(input.type === "transfer_in" ? "income.transfer" : "people");
    const kind = cat?.kind ?? (input.type === "transfer_in" ? "income" : "expense");
    return base(cat?.id ?? fallback(idx, kind), "default", kind, merchantName);
  }

  // 1. Merchant memory (only when the remembered category fits the direction of the money)
  const known = input.merchant?.category_id ? idx.byId.get(input.merchant.category_id) : null;
  if (known && !known.archived && fitsDirection(known.kind, input)) {
    return base(known.id, "merchant", known.kind, merchantName);
  }

  // 2. Built-in dictionary
  if (input.merchant) {
    const hit = builtinMatch(input.merchant.key);
    const cat = hit ? idx.bySlug.get(hit.slug) : null;
    if (cat && fitsDirection(cat.kind, input)) {
      await run(
        db,
        "UPDATE merchants SET category_id = ?, category_source = 'builtin', updated_at = ? WHERE id = ? AND category_id IS NULL",
        cat.id,
        nowIso(),
        input.merchant.id,
      );
      return base(cat.id, "builtin", cat.kind, merchantName);
    }
  }

  // 3. Defaults by transaction type (AI may refine these later when a merchant is present)
  const typeSlug: Partial<Record<ParsedMessage["type"], string>> = {
    income: "income.other",
    refund: "income.refund",
  };
  const slug = typeSlug[input.type] ?? (direction === "in" ? "income.other" : FALLBACK_SLUG.expense);
  const cat = idx.bySlug.get(slug);
  const kind = cat?.kind ?? (direction === "in" ? "income" : "expense");
  const hasName = Boolean(input.merchant || input.description);
  return {
    category_id: cat?.id ?? fallback(idx, kind),
    category_source: "default",
    kind,
    merchant_name: merchantName,
    excluded: false,
    // Purchases/income from an unknown merchant are worth asking AI about.
    needs_ai: hasName,
  };

  function base(category_id: number, source: CategorySource, kind: TxKind, name: string | null): CategorizeResult {
    return { category_id, category_source: source, kind, merchant_name: name, excluded: false, needs_ai: false };
  }
}

/** Income categories need money in; spending categories need money out (or a refund). */
function fitsDirection(kind: TxKind, input: CategorizeInput): boolean {
  if (kind === "income") return input.amount > 0;
  if (kind === "expense") return input.amount < 0 || input.type === "refund";
  return true;
}

/** The category a transaction falls back to when it's no longer tagged as a transfer between own accounts. */
export function defaultCategoryFor(idx: CategoryIndex, amount: number, txType: string | null): Category | undefined {
  if (amount > 0) {
    return idx.bySlug.get(txType === "transfer_in" ? "income.transfer" : txType === "refund" ? "income.refund" : "income.other");
  }
  const slug = txType === "transfer_out" ? "people" : txType === "cash_withdrawal" ? "cash" : txType === "fee" ? "finance.fees" : "uncategorized";
  return idx.bySlug.get(slug);
}

export function fallback(idx: CategoryIndex, kind: TxKind): number {
  return idx.bySlug.get(FALLBACK_SLUG[kind])?.id ?? idx.list[0].id;
}

// ---------------------------------------------------------------------------
// AI categorization of unknown merchants (batched, cached in `merchants`).

const AiCategorySchema = z.object({
  results: z.array(
    z.object({
      merchant_id: z.number().int(),
      display_name: z.string().describe("Clean, human friendly merchant name, e.g. 'Bravo Supermarket'"),
      category_id: z.number().int(),
      confidence: z.number().describe("0.0 - 1.0"),
    }),
  ),
});

/**
 * Ask AI to categorize merchants that have transactions waiting with a default
 * category. Updates merchant memory and every waiting transaction of those merchants.
 * Returns the number of merchants categorized.
 */
export async function categorizePendingWithAI(env: Env, limit = 25): Promise<number> {
  const settings = await getSettings(env);
  if (await aiBlocked(env, settings)) return 0;
  const pending = await all<{ merchant_id: number; key: string; name: string; raw: string; amount: number; n: number; n_in: number }>(
    env.DB,
    `SELECT m.id AS merchant_id, m.key, m.name, MAX(t.merchant_raw) AS raw, MAX(ABS(t.amount)) AS amount, COUNT(*) AS n,
            SUM(CASE WHEN t.amount > 0 THEN 1 ELSE 0 END) AS n_in
       FROM transactions t JOIN merchants m ON m.id = t.merchant_id
      WHERE t.category_source = 'pending' AND m.category_id IS NULL AND (m.category_source IS NULL OR m.category_source <> 'ai_failed')
      GROUP BY m.id ORDER BY n DESC LIMIT ?`,
    limit,
  );
  if (pending.length === 0) return 0;

  const idx = await loadCategories(env.DB);
  const leafList = idx.list
    .filter((c) => !c.archived && (c.parent_id !== null || !idx.list.some((x) => x.parent_id === c.id)))
    .map((c) => `${c.id}: ${categoryPath(idx, c.id)} [${c.kind}]`)
    .join("\n");

  const system = [
    "You categorize bank card transactions for a person living in Baku, Azerbaijan.",
    "Merchant strings come from bank SMS notifications and may be truncated, transliterated or contain terminal codes.",
    "Use your knowledge of Azerbaijani and international businesses. Pick the single most specific category id from the list.",
    "Each merchant is marked as money out (a payment) or money in. Money out needs an [expense] category (or [transfer]);",
    "money in needs an [income] category (or [transfer]). Money in from an employer usually means salary; from a person, money received.",
    "If you genuinely cannot tell, choose the 'Uncategorized' category with low confidence rather than guessing.",
    "",
    "Categories (id: path [kind]):",
    leafList,
  ].join("\n");

  const lines = pending.map(
    (p) =>
      `merchant_id=${p.merchant_id} | raw="${p.raw ?? p.name}" | ${p.n_in === p.n ? "money in" : p.n_in === 0 ? "money out" : "mostly money out"} | sample_amount=${(p.amount / 100).toFixed(2)} AZN | transactions=${p.n}`,
  );
  const { data: result } = await structuredCall(env, {
    purpose: "categorize",
    model: settings.ai_fast_model,
    system,
    content: `Categorize these merchants:\n${lines.join("\n")}`,
    schema: AiCategorySchema,
    maxTokens: 8000,
    effort: "low",
  });
  if (!result) return 0;

  const now = nowIso();
  let done = 0;
  const pendingIds = new Set(pending.map((p) => p.merchant_id));
  for (const r of result.results) {
    if (!pendingIds.has(r.merchant_id)) continue;
    const cat = idx.byId.get(r.category_id);
    if (!cat) continue;
    const confidence = Math.max(0, Math.min(1, r.confidence));
    const name = r.display_name?.trim().slice(0, 60) || null;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE merchants SET category_id = ?, category_source = 'ai', ai_confidence = ?, name = COALESCE(?, name), updated_at = ? WHERE id = ? AND (category_source IS NULL OR category_source <> 'user')",
      ).bind(cat.id, confidence, name, now, r.merchant_id),
      // Only transactions going the matching direction get the category (never turn income into spending).
      env.DB.prepare(
        `UPDATE transactions SET category_id = ?, kind = ?, category_source = 'ai', ai_confidence = ?, needs_review = ?, updated_at = ?
          WHERE merchant_id = ? AND category_source = 'pending' AND ${DIRECTION_MATCH}`,
      ).bind(cat.id, cat.kind, confidence, confidence < 0.7 ? 1 : 0, now, r.merchant_id, cat.kind, cat.kind),
      // The rest keep their fallback category.
      env.DB.prepare("UPDATE transactions SET category_source = 'default' WHERE merchant_id = ? AND category_source = 'pending'").bind(
        r.merchant_id,
      ),
    ]);
    pendingIds.delete(r.merchant_id);
    done++;
  }
  // Merchants the model skipped: don't ask again every hour.
  if (pendingIds.size) {
    await run(
      env.DB,
      `UPDATE merchants SET category_source = 'ai_failed', updated_at = ? WHERE id IN (${placeholders(pendingIds.size)})`,
      now,
      ...pendingIds,
    );
  }
  return done;
}

/** SQL condition (two `?` = category kind) so a category is only applied to transactions going its way. */
const DIRECTION_MATCH = "(? <> 'income' OR amount > 0) AND (? <> 'expense' OR amount < 0)";

/** Keep categorizing in batches until nothing is left (or a safety limit is hit). */
export async function categorizeAllPending(env: Env, maxBatches = 8): Promise<number> {
  let total = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      const n = await categorizePendingWithAI(env);
      total += n;
      if (n === 0) break;
    }
  } catch (e) {
    console.error("AI categorization failed", e);
  }
  return total;
}

/** Apply a category to every transaction of a merchant and remember it for the future. */
export async function setMerchantCategory(
  db: D1Database,
  merchantId: number,
  categoryId: number,
  opts: { applyToPast: boolean; name?: string | null },
): Promise<number> {
  const cat = await first<Category>(db, "SELECT * FROM categories WHERE id = ?", categoryId);
  if (!cat) return 0;
  const now = nowIso();
  await run(
    db,
    "UPDATE merchants SET category_id = ?, category_source = 'user', ai_confidence = NULL, name = COALESCE(?, name), updated_at = ? WHERE id = ?",
    categoryId,
    opts.name ?? null,
    now,
    merchantId,
  );
  if (!opts.applyToPast) return 0;
  const res = await run(
    db,
    `UPDATE transactions SET category_id = ?, kind = ?, category_source = 'user', needs_review = 0, updated_at = ?
      WHERE merchant_id = ? AND (category_source IS NULL OR category_source <> 'rule') AND ${DIRECTION_MATCH}`,
    categoryId,
    cat.kind,
    now,
    merchantId,
    cat.kind,
    cat.kind,
  );
  return res.meta.changes ?? 0;
}

