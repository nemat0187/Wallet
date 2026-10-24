// Creating transactions (from bank messages, imports, manual entry, Telegram).

import type { Env } from "../env";
import type { Account, ParsedMessage, Rule, Settings, TxKind, TxSource } from "@shared/types";
import { localDate } from "@shared/money";
import { all, first, insert, nowIso, run } from "../lib/db";
import { categorize, loadCategories, upsertMerchant, type CategoryIndex } from "./categorize";
import { convert } from "./fx";
import { getSettings } from "./settings";

export interface NewTransaction {
  account_id: number | null;
  occurred_at: string;
  amount: number; // signed minor units in `currency` (negative = money out)
  currency: string;
  orig_amount?: number | null;
  orig_currency?: string | null;
  merchant_raw?: string | null;
  description?: string | null;
  note?: string | null;
  tags?: string | null;
  balance_after?: number | null;
  source: TxSource;
  external_ref?: string | null;
  type: ParsedMessage["type"];
  category_id?: number | null; // explicit choice (manual entry / import mapping)
  kind?: TxKind;
}

export interface CreateContext {
  idx: CategoryIndex;
  settings: Settings;
  rules: Rule[];
}

export async function createContext(env: Env): Promise<CreateContext> {
  const [idx, settings, rules] = await Promise.all([
    loadCategories(env.DB),
    getSettings(env),
    all<Rule>(env.DB, "SELECT * FROM rules WHERE enabled = 1 ORDER BY priority, id"),
  ]);
  return { idx, settings, rules };
}

export interface CreatedTransaction {
  id: number;
  duplicate: boolean;
  needs_ai: boolean;
}

export async function createTransaction(env: Env, tx: NewTransaction, ctx: CreateContext): Promise<CreatedTransaction> {
  const db = env.DB;
  if (tx.external_ref) {
    const dup = await first<{ id: number }>(db, "SELECT id FROM transactions WHERE external_ref = ?", tx.external_ref);
    if (dup) return { id: dup.id, duplicate: true, needs_ai: false };
  }
  const occurred = new Date(tx.occurred_at);
  const ymd = localDate(occurred, ctx.settings.tz_offset_minutes);
  const base = ctx.settings.base_currency;
  const amountBase = tx.currency === base ? tx.amount : await convert(db, tx.amount, tx.currency, base, ymd);

  const merchantText = tx.merchant_raw?.trim() || null;
  const merchant = merchantText ? await upsertMerchant(db, merchantText) : null;

  let categoryId: number;
  let source: string;
  let kind: TxKind;
  let merchantName = merchant?.name ?? null;
  let excluded = false;
  let needsAi = false;
  if (tx.category_id && ctx.idx.byId.has(tx.category_id)) {
    categoryId = tx.category_id;
    source = "user";
    kind = tx.kind ?? ctx.idx.byId.get(tx.category_id)!.kind;
  } else {
    const result = await categorize(
      db,
      ctx.idx,
      {
        merchant,
        merchant_raw: merchantText,
        description: tx.description ?? null,
        amount: tx.amount,
        account_id: tx.account_id,
        type: tx.type,
      },
      { atmAsTransfer: ctx.settings.atm_as_transfer, rules: ctx.rules },
    );
    categoryId = result.category_id;
    // "pending" = fallback category for now; AI will look at this merchant shortly.
    source = result.needs_ai ? "pending" : result.category_source;
    kind = tx.kind ?? result.kind;
    merchantName = result.merchant_name;
    excluded = result.excluded;
    needsAi = result.needs_ai;
    if (result.rule_id) await run(db, "UPDATE rules SET hits = hits + 1 WHERE id = ?", result.rule_id);
  }

  // A rule may rename the merchant; keep that on the merchant record too.
  if (merchant && merchantName && merchantName !== merchant.name && source === "rule") {
    await run(db, "UPDATE merchants SET name = ?, updated_at = ? WHERE id = ?", merchantName, nowIso(), merchant.id);
  }

  const now = nowIso();
  const id = await insert(
    db,
    `INSERT INTO transactions (account_id, occurred_at, local_date, amount, currency, amount_base, orig_amount, orig_currency,
       kind, merchant_raw, merchant_id, description, category_id, category_source, note, tags, excluded, balance_after,
       source, external_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    tx.account_id,
    occurred.toISOString(),
    ymd,
    tx.amount,
    tx.currency,
    amountBase,
    tx.orig_amount ?? null,
    tx.orig_currency ?? null,
    kind,
    merchantText,
    merchant?.id ?? null,
    tx.description ?? null,
    categoryId,
    source,
    tx.note ?? null,
    tx.tags ?? null,
    excluded ? 1 : 0,
    tx.balance_after ?? null,
    tx.source,
    tx.external_ref ?? null,
    now,
    now,
  );

  if (tx.account_id && tx.balance_after !== null && tx.balance_after !== undefined) {
    await run(
      db,
      "UPDATE accounts SET balance = ?, balance_at = ? WHERE id = ? AND (balance_at IS NULL OR balance_at <= ?)",
      tx.balance_after,
      occurred.toISOString(),
      tx.account_id,
      occurred.toISOString(),
    );
  } else if (tx.account_id && tx.source === "manual") {
    // Cash wallet and other manual accounts: keep a running balance.
    await run(db, "UPDATE accounts SET balance = COALESCE(balance, 0) + ? WHERE id = ? AND type = 'cash'", tx.amount, tx.account_id);
  }

  return { id, duplicate: false, needs_ai: needsAi };
}

/**
 * Find (or create) the account a card notification belongs to, using the last
 * four digits of the card. Unknown cards are added automatically.
 */
export async function resolveAccount(db: D1Database, last4: string | null, currency: string): Promise<Account | null> {
  if (last4) {
    const acc = await first<Account>(db, "SELECT * FROM accounts WHERE card_last4 = ? AND archived = 0 ORDER BY id LIMIT 1", last4);
    if (acc) return acc;
    const id = await insert(
      db,
      "INSERT INTO accounts (name, type, institution, card_last4, currency, color, sort_order, created_at) VALUES (?, 'card', 'ABB', ?, ?, ?, ?, ?)",
      `ABB card •${last4}`,
      last4,
      currency,
      ["#2563eb", "#7c3aed", "#0d9488", "#ea580c", "#db2777"][Number(last4) % 5],
      10,
      nowIso(),
    );
    return first<Account>(db, "SELECT * FROM accounts WHERE id = ?", id);
  }
  // No card number in the message: use the only card if there is exactly one.
  const cards = await all<Account>(db, "SELECT * FROM accounts WHERE type = 'card' AND archived = 0 ORDER BY sort_order, id");
  return cards.length === 1 ? cards[0] : null;
}

/**
 * Money moved between two of the owner's own cards shows up as an outgoing and
 * an incoming transfer of the same amount within minutes. Mark both as internal
 * transfers so they don't count as spending or income.
 */
export async function matchOwnTransfer(db: D1Database, idx: CategoryIndex, txId: number): Promise<boolean> {
  const tx = await first<{ id: number; account_id: number | null; amount_base: number; occurred_at: string; kind: string }>(
    db,
    "SELECT id, account_id, amount_base, occurred_at, kind FROM transactions WHERE id = ?",
    txId,
  );
  if (!tx || !tx.account_id) return false;
  const t = Date.parse(tx.occurred_at);
  const from = new Date(t - 15 * 60_000).toISOString();
  const to = new Date(t + 15 * 60_000).toISOString();
  const other = await first<{ id: number }>(
    db,
    `SELECT t.id FROM transactions t JOIN categories c ON c.id = t.category_id
      WHERE t.id <> ? AND t.account_id IS NOT NULL AND t.account_id <> ? AND t.amount_base = ?
        AND t.occurred_at BETWEEN ? AND ? AND c.slug IN ('income.transfer', 'people', 'transfer.own')
      ORDER BY ABS(julianday(t.occurred_at) - julianday(?)) LIMIT 1`,
    tx.id,
    tx.account_id,
    -tx.amount_base,
    from,
    to,
    tx.occurred_at,
  );
  const own = idx.bySlug.get("transfer.own");
  if (!other || !own) return false;
  const self = await first<{ slug: string | null }>(
    db,
    "SELECT c.slug FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.id = ?",
    tx.id,
  );
  if (!self?.slug || !["income.transfer", "people", "transfer.own"].includes(self.slug)) return false;
  await run(
    db,
    "UPDATE transactions SET kind = 'transfer', category_id = ?, category_source = 'default', updated_at = ? WHERE id IN (?, ?)",
    own.id,
    nowIso(),
    tx.id,
    other.id,
  );
  return true;
}
