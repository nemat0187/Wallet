// Types shared by the API (worker/) and the web app (src/).
// All money values are integers in minor units (1 AZN = 100 qəpik).

import type { CategoryKind } from "./categories";

export type { CategoryKind };
export type TxKind = CategoryKind;
export type TxSource = "sms" | "push" | "import" | "manual" | "telegram";
export type CategorySource = "user" | "rule" | "merchant" | "builtin" | "ai" | "default" | "pending";

export interface Account {
  id: number;
  name: string;
  type: "card" | "cash" | "savings" | "other";
  institution: string | null;
  card_last4: string | null;
  currency: string;
  color: string | null;
  balance: number | null;
  balance_at: string | null;
  include_in_totals: number;
  archived: number;
  sort_order: number;
}

export interface Category {
  id: number;
  parent_id: number | null;
  slug: string | null;
  name: string;
  kind: CategoryKind;
  icon: string | null;
  color: string | null;
  sort_order: number;
  archived: number;
}

export interface Transaction {
  id: number;
  account_id: number | null;
  occurred_at: string;
  local_date: string;
  amount: number;
  currency: string;
  amount_base: number;
  orig_amount: number | null;
  orig_currency: string | null;
  kind: TxKind;
  merchant_raw: string | null;
  merchant_id: number | null;
  merchant_name: string | null;
  description: string | null;
  category_id: number | null;
  category_source: CategorySource | null;
  ai_confidence: number | null;
  needs_review: number;
  note: string | null;
  tags: string | null;
  excluded: number;
  balance_after: number | null;
  source: TxSource;
  /** What the bank message said it was: purchase, transfer_in, transfer_out, cash_withdrawal, … */
  tx_type: string | null;
  /** Suggested counterpart when this looks like a transfer between the owner's own cards. */
  /** Suggested counterpart on another of the owner's cards; 0 = owner said "not a transfer". */
  pair_id: number | null;
  created_at: string;
}

export interface Merchant {
  id: number;
  key: string;
  name: string;
  category_id: number | null;
  category_source: string | null;
  ai_confidence: number | null;
  tx_count?: number;
  total_spent?: number;
  last_seen?: string | null;
}

export interface Rule {
  id: number;
  name: string | null;
  match_field: "merchant" | "description" | "any";
  match_type: "contains" | "equals" | "starts_with" | "regex";
  pattern: string;
  direction: "in" | "out" | null;
  min_amount: number | null;
  max_amount: number | null;
  account_id: number | null;
  set_category_id: number | null;
  set_kind: TxKind | null;
  set_merchant_name: string | null;
  set_excluded: number | null;
  priority: number;
  enabled: number;
  hits: number;
  /** JSON array of conditions (see shared/rules.ts); null for rules created by older versions. */
  conditions: string | null;
  match_mode: "all" | "any";
  set_tags: string | null;
  set_note: string | null;
  continue_after: number;
}

export interface BudgetStatus {
  id: number | null;
  category_id: number | null; // null = overall budget
  amount: number;
  spent: number;
  remaining: number;
  pct: number;
  projected: number; // projected spend at end of period at the current pace
  alert_pct: number;
  status: "ok" | "warning" | "over";
}

export interface Period {
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
  label: string;
}

export interface RawMessage {
  id: number;
  source: string;
  sender: string | null;
  body: string;
  received_at: string;
  status: "pending" | "parsed" | "failed" | "ignored" | "duplicate";
  parse_method: string | null;
  parse_result: string | null;
  error: string | null;
  transaction_id: number | null;
}

/** Result of parsing one bank notification. */
export interface ParsedMessage {
  is_transaction: boolean;
  direction: "in" | "out";
  type: "purchase" | "transfer_in" | "transfer_out" | "cash_withdrawal" | "income" | "refund" | "fee" | "other";
  amount: number; // minor units, positive, in `currency`
  currency: string;
  orig_amount: number | null;
  orig_currency: string | null;
  merchant: string | null;
  card_last4: string | null;
  occurred_at: string | null; // ISO with timezone, null = unknown
  balance_after: number | null;
  balance_currency: string | null;
  confidence: number; // 0..1
}

export interface InsightReport {
  headline: string;
  summary: string;
  health_score: number;
  highlights: string[];
  bad_habits: { title: string; detail: string; monthly_cost: number | null; suggestion: string }[];
  recommendations: { title: string; detail: string; potential_monthly_savings: number | null }[];
  anomalies: { title: string; detail: string }[];
  budget_suggestions: { category: string; suggested_monthly_amount: number; reason: string }[];
}

export interface Insight {
  id: number;
  kind: "weekly" | "monthly" | "manual";
  period_start: string;
  period_end: string;
  title: string;
  data: InsightReport;
  model: string | null;
  cost_usd: number | null;
  created_at: string;
}

export interface Settings {
  month_start_day: number;
  base_currency: string;
  tz_offset_minutes: number;
  overall_budget: number | null;
  ai_enabled: boolean;
  ai_monthly_cap_usd: number;
  ai_fast_model: string;
  ai_smart_model: string;
  ai_auto_reports: boolean;
  ai_configured: boolean;
  telegram_configured: boolean;
  telegram_connected: boolean;
  notify_each_transaction: boolean;
  notify_budget_alerts: boolean;
  notify_reports: boolean;
  atm_as_transfer: boolean;
  totp_enabled: boolean;
  last_message_at: string | null;
}
