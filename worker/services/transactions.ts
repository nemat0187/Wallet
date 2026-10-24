// Creating transactions (from bank messages, imports, manual entry, Telegram).

import type { Env } from "../env";
import type { Account, ParsedMessage, Rule, Settings, TxKind, TxSource } from "@shared/types";
import { localDate } from "@shared/money";
import { applyRules, localParts, mergeTags } from "@shared/rules";
import { all, first, insert, nowIso, placeholders, run } from "../lib/db";
import { categorize, fallback, loadCategories, upsertMerchant, type CategoryIndex } from "./categorize";
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
  /** Full bank notification text, so rules can look at it. */
  message?: string | null;
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
  let note = tx.note ?? null;
  let tags = tx.tags ?? null;
  if (tx.category_id && ctx.idx.byId.has(tx.category_id)) {
    categoryId = tx.category_id;
    source = "user";
    kind = tx.kind ?? ctx.idx.byId.get(tx.category_id)!.kind;
  } else {
    const auto = await categorize(
      db,
      ctx.idx,
      { merchant, merchant_raw: merchantText, description: tx.description ?? null, amount: tx.amount, account_id: tx.account_id, type: tx.type },
      { atmAsTransfer: ctx.settings.atm_as_transfer },
    );
    categoryId = auto.category_id;
    // "pending" = fallback category for now; AI will look at this merchant shortly.
    source = auto.needs_ai ? "pending" : auto.category_source;
    kind = tx.kind ?? auto.kind;
    merchantName = auto.merchant_name;
    needsAi = auto.needs_ai;

    // The owner's rules run on top of the automatic result and always win.
    const { weekday, hour } = localParts(occurred.toISOString(), ctx.settings.tz_offset_minutes);
    const autoCat = ctx.idx.byId.get(categoryId);
    const fx = applyRules(ctx.rules, {
      merchant: merchantName,
      merchant_raw: merchantText,
      description: tx.description ?? null,
      message: tx.message ?? null,
      amount: tx.amount,
      currency: tx.orig_currency ?? tx.currency,
      account_id: tx.account_id,
      type: tx.type,
      local_weekday: weekday,
      local_hour: hour,
      category_id: categoryId,
      category_parent_id: autoCat?.parent_id ?? null,
    });
    if (fx.rule_ids.length) {
      const ruleCat = fx.category_id ? ctx.idx.byId.get(fx.category_id) : undefined;
      if (ruleCat) {
        categoryId = ruleCat.id;
        kind = fx.kind ?? ruleCat.kind;
        source = "rule";
        needsAi = false;
      } else if (fx.kind && fx.kind !== kind) {
        // Type changed without a category: use the matching default (e.g. "between my accounts").
        kind = fx.kind;
        categoryId = fx.kind === "transfer" ? (ctx.idx.bySlug.get("transfer.own")?.id ?? fallback(ctx.idx, "transfer")) : fallback(ctx.idx, fx.kind);
        source = "rule";
        needsAi = false;
      }
      if (fx.merchant_name) merchantName = fx.merchant_name;
      if (fx.excluded !== null) excluded = fx.excluded;
      if (fx.note && !note) note = fx.note;
      tags = mergeTags(tags, fx.tags);
      await run(db, `UPDATE rules SET hits = hits + 1 WHERE id IN (${placeholders(fx.rule_ids.length)})`, ...fx.rule_ids);
    }
  }

  // A rule may rename the merchant; keep that on the merchant record too.
  if (merchant && merchantName && merchantName !== merchant.name) {
    await run(db, "UPDATE merchants SET name = ?, updated_at = ? WHERE id = ?", merchantName, nowIso(), merchant.id);
  }

  const now = nowIso();
  const id = await insert(
    db,
    `INSERT INTO transactions (account_id, occurred_at, local_date, amount, currency, amount_base, orig_amount, orig_currency,
       kind, merchant_raw, merchant_id, description, category_id, category_source, note, tags, excluded, balance_after,
       source, external_ref, tx_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    note,
    tags,
    excluded ? 1 : 0,
    tx.balance_after ?? null,
    tx.source,
    tx.external_ref ?? null,
    tx.type,
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
 * Money moved between two of the owner's own cards shows up as an outgoing and an
 * incoming transaction of the same amount within minutes. The bank message doesn't
 * name the other side, so this is only a *suggestion*: both get a pair_id (shown as
 * a label with a one-tap "Mark as my transfer"); nothing changes until the owner says so.
 * Exception: when the owner (or one of their rules) already marked one side as a
 * transfer between their cards, the other side follows.
 * Returns the id of the suggested counterpart, if any.
 */
export async function suggestTransferPair(db: D1Database, txId: number, windowMinutes = 30): Promise<number | null> {
  const tx = await first<{ id: number; account_id: number | null; amount_base: number; occurred_at: string; kind: string; pair_id: number | null; tx_type: string | null }>(
    db,
    "SELECT id, account_id, amount_base, occurred_at, kind, pair_id, tx_type FROM transactions WHERE id = ?",
    txId,
  );
  // pair_id 0 means the owner said "not a transfer"; never suggest it again.
  if (!tx || !tx.account_id || tx.pair_id !== null || tx.amount_base === 0 || tx.tx_type === "cash_withdrawal") return null;
  const t = Date.parse(tx.occurred_at);
  const other = await first<{ id: number; kind: string }>(
    db,
    `SELECT t.id, t.kind FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.id <> ? AND t.account_id <> ? AND a.type <> 'cash' AND t.amount_base = ? AND t.pair_id IS NULL
        AND COALESCE(t.tx_type, '') <> 'cash_withdrawal' AND t.occurred_at BETWEEN ? AND ?
      ORDER BY ABS(julianday(t.occurred_at) - julianday(?)) LIMIT 1`,
    tx.id,
    tx.account_id,
    -tx.amount_base,
    new Date(t - windowMinutes * 60_000).toISOString(),
    new Date(t + windowMinutes * 60_000).toISOString(),
    tx.occurred_at,
  );
  if (!other) return null;
  const stmts = [
    db.prepare("UPDATE transactions SET pair_id = ? WHERE id = ?").bind(other.id, tx.id),
    db.prepare("UPDATE transactions SET pair_id = ? WHERE id = ?").bind(tx.id, other.id),
  ];
  if ((tx.kind === "transfer") !== (other.kind === "transfer")) {
    stmts.push(
      db
        .prepare(
          `UPDATE transactions SET kind = 'transfer', category_id = COALESCE((SELECT id FROM categories WHERE slug = 'transfer.own'), category_id),
             category_source = 'rule', needs_review = 0, updated_at = ? WHERE id = ?`,
        )
        .bind(nowIso(), tx.kind === "transfer" ? other.id : tx.id),
    );
  }
  await db.batch(stmts);
  return other.id;
}

/** Look through history for unlabelled pairs (e.g. after importing statements). Returns how many pairs were found. */
export async function scanTransferPairs(db: D1Database): Promise<number> {
  const rows = await all<{ id: number }>(
    db,
    `SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.pair_id IS NULL AND t.kind <> 'transfer' AND t.amount_base < 0 AND a.type <> 'cash'
      ORDER BY t.occurred_at DESC LIMIT 2000`,
  );
  let found = 0;
  for (const r of rows) if (await suggestTransferPair(db, r.id)) found++;
  return found;
}
