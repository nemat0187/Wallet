// Helpers shared by the rules routes and "run my rules again" on a single transaction.

import type { RuleContext } from "@shared/rules";
import { localParts } from "@shared/rules";
import { all } from "../lib/db";
import type { CategoryIndex } from "./categorize";

export interface TxForRules {
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

export async function loadForRules(db: D1Database, id?: number): Promise<TxForRules[]> {
  return all<TxForRules>(
    db,
    `SELECT t.id, t.local_date, t.occurred_at, t.amount, t.currency, t.orig_currency, t.account_id, t.merchant_raw, m.name AS merchant_name,
            t.merchant_id, t.description, r.body AS message, t.tx_type, t.category_id, t.kind, t.tags, t.note
       FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id LEFT JOIN raw_messages r ON r.transaction_id = t.id
      ${id === undefined ? "" : "WHERE t.id = ?"}
      ORDER BY t.occurred_at DESC LIMIT 20000`,
    ...(id === undefined ? [] : [id]),
  );
}

export function contextFor(t: TxForRules, idx: CategoryIndex, tz: number): RuleContext {
  const { weekday, hour } = localParts(t.occurred_at, tz);
  return {
    merchant: t.merchant_name,
    merchant_raw: t.merchant_raw,
    description: t.description,
    title: t.message ? (t.message.split("\n").find((l) => l.trim()) ?? null) : null,
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

