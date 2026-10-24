// Rule conditions and their evaluation. Shared by the API (which applies rules)
// and the web app (which builds them), so both always agree on the format.

import type { Rule, TxKind } from "./types";

export type TextField = "merchant" | "description" | "message" | "any_text";
export type TextOp = "contains" | "not_contains" | "equals" | "starts_with" | "ends_with" | "regex";
export type NumberOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "between";
export type ListField = "account" | "type" | "weekday" | "currency" | "category";

export type Condition =
  | { field: TextField; op: TextOp; value: string }
  | { field: "amount"; op: NumberOp; value: number; value2?: number | null }
  | { field: "direction"; op: "is"; value: "in" | "out" }
  | { field: ListField; op: "is" | "is_not"; value: (number | string)[] }
  | { field: "hour"; op: "between"; value: number; value2: number };

/** Everything a rule can look at. Amounts are signed minor units (negative = money out). */
export interface RuleContext {
  merchant: string | null; // display name
  merchant_raw: string | null; // as written by the bank
  description: string | null;
  message: string | null; // full bank notification text
  amount: number;
  currency: string;
  account_id: number | null;
  type: string | null; // purchase, transfer_in, transfer_out, cash_withdrawal, income, refund, fee
  local_weekday: number; // 0 = Sunday
  local_hour: number;
  category_id: number | null;
  category_parent_id: number | null;
}

export interface RuleEffects {
  category_id: number | null;
  kind: TxKind | null;
  merchant_name: string | null;
  excluded: boolean | null;
  tags: string[];
  note: string | null;
  rule_ids: number[];
}

export const TX_TYPES: { value: string; label: string }[] = [
  { value: "purchase", label: "Card payment" },
  { value: "transfer_out", label: "Transfer sent" },
  { value: "transfer_in", label: "Transfer received" },
  { value: "cash_withdrawal", label: "Cash withdrawal" },
  { value: "income", label: "Incoming payment" },
  { value: "refund", label: "Refund" },
  { value: "fee", label: "Bank fee" },
];

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Conditions of a rule, converting the single-condition format of older versions. */
export function ruleConditions(rule: Pick<Rule, "conditions" | "match_field" | "match_type" | "pattern" | "direction" | "min_amount" | "max_amount" | "account_id">): Condition[] {
  if (rule.conditions) {
    try {
      const parsed = JSON.parse(rule.conditions);
      if (Array.isArray(parsed)) return parsed as Condition[];
    } catch {
      return [];
    }
  }
  const out: Condition[] = [];
  if (rule.pattern?.trim()) {
    const field: TextField = rule.match_field === "merchant" ? "merchant" : rule.match_field === "description" ? "description" : "any_text";
    out.push({ field, op: rule.match_type === "starts_with" ? "starts_with" : rule.match_type, value: rule.pattern });
  }
  if (rule.direction) out.push({ field: "direction", op: "is", value: rule.direction });
  if (rule.min_amount !== null && rule.min_amount !== undefined) out.push({ field: "amount", op: "gte", value: rule.min_amount });
  if (rule.max_amount !== null && rule.max_amount !== undefined) out.push({ field: "amount", op: "lte", value: rule.max_amount });
  if (rule.account_id) out.push({ field: "account", op: "is", value: [rule.account_id] });
  return out;
}

/** Lowercase without Azerbaijani/Turkish diacritics, so "Köçürmə" matches "kocurme". */
export function fold(s: string): string {
  const map: Record<string, string> = { ə: "e", ı: "i", ö: "o", ü: "u", ş: "s", ç: "c", ğ: "g" };
  return s
    .replace(/İ/g, "i")
    .toLowerCase()
    .replace(/i\u0307/g, "i")
    .replace(/[əıöüşçğ]/g, (ch) => map[ch] ?? ch);
}

function textMatches(op: TextOp, haystack: string | null, needle: string): boolean {
  if (op === "regex") {
    if (!haystack) return false;
    try {
      return new RegExp(needle, "i").test(haystack);
    } catch {
      return false;
    }
  }
  const h = fold(haystack ?? "").replace(/\s+/g, " ").trim();
  const n = fold(needle).replace(/\s+/g, " ").trim();
  switch (op) {
    case "contains":
      return n !== "" && h.includes(n);
    case "not_contains":
      return !h.includes(n);
    case "equals":
      return h === n;
    case "starts_with":
      return n !== "" && h.startsWith(n);
    case "ends_with":
      return n !== "" && h.endsWith(n);
  }
}

export function conditionMatches(c: Condition, ctx: RuleContext): boolean {
  switch (c.field) {
    case "merchant":
      // Either the display name or the original bank wording may match.
      return c.op === "not_contains"
        ? textMatches(c.op, ctx.merchant, c.value) && textMatches(c.op, ctx.merchant_raw, c.value)
        : textMatches(c.op, ctx.merchant, c.value) || textMatches(c.op, ctx.merchant_raw, c.value);
    case "description":
      return textMatches(c.op, ctx.description, c.value);
    case "message":
      return textMatches(c.op, ctx.message, c.value);
    case "any_text": {
      const all = [ctx.merchant, ctx.merchant_raw, ctx.description, ctx.message].filter(Boolean).join("\n");
      return textMatches(c.op, all, c.value);
    }
    case "amount": {
      const a = Math.abs(ctx.amount);
      const v = c.value;
      switch (c.op) {
        case "eq":
          return a === v;
        case "ne":
          return a !== v;
        case "gt":
          return a > v;
        case "gte":
          return a >= v;
        case "lt":
          return a < v;
        case "lte":
          return a <= v;
        case "between":
          return a >= Math.min(v, c.value2 ?? v) && a <= Math.max(v, c.value2 ?? v);
      }
      return false;
    }
    case "direction":
      return (ctx.amount >= 0 ? "in" : "out") === c.value;
    case "hour": {
      const from = c.value;
      const to = c.value2;
      // Wraps around midnight, e.g. 22 → 4.
      const inRange = from <= to ? ctx.local_hour >= from && ctx.local_hour <= to : ctx.local_hour >= from || ctx.local_hour <= to;
      return inRange;
    }
    default: {
      const values = c.value.map(String);
      let actual: string[];
      if (c.field === "account") actual = [String(ctx.account_id ?? "")];
      else if (c.field === "type") actual = [ctx.type ?? ""];
      else if (c.field === "weekday") actual = [String(ctx.local_weekday)];
      else if (c.field === "currency") actual = [ctx.currency];
      else actual = [String(ctx.category_id ?? ""), String(ctx.category_parent_id ?? "")];
      const hit = actual.some((a) => values.includes(a));
      return c.op === "is" ? hit : !hit;
    }
  }
}

export function ruleMatches(rule: Rule, ctx: RuleContext): boolean {
  const conditions = ruleConditions(rule);
  if (conditions.length === 0) return false;
  return rule.match_mode === "any" ? conditions.some((c) => conditionMatches(c, ctx)) : conditions.every((c) => conditionMatches(c, ctx));
}

/**
 * Run enabled rules in priority order. The first matching rule wins unless it
 * says "keep checking other rules"; later rules then only fill in what earlier
 * ones left unset (tags are collected from all of them).
 */
export function applyRules(rules: Rule[], ctx: RuleContext): RuleEffects {
  const fx: RuleEffects = { category_id: null, kind: null, merchant_name: null, excluded: null, tags: [], note: null, rule_ids: [] };
  for (const rule of rules) {
    if (!rule.enabled || !ruleMatches(rule, ctx)) continue;
    fx.rule_ids.push(rule.id);
    fx.category_id ??= rule.set_category_id ?? null;
    fx.kind ??= rule.set_kind ?? null;
    fx.merchant_name ??= rule.set_merchant_name || null;
    if (fx.excluded === null && rule.set_excluded !== null && rule.set_excluded !== undefined) fx.excluded = rule.set_excluded === 1;
    fx.note ??= rule.set_note || null;
    for (const tag of (rule.set_tags ?? "").split(",").map((t) => t.trim()).filter(Boolean)) {
      if (!fx.tags.includes(tag)) fx.tags.push(tag);
    }
    if (!rule.continue_after) break;
  }
  return fx;
}

export function mergeTags(existing: string | null, add: string[]): string | null {
  const list = (existing ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  for (const t of add) if (!list.includes(t)) list.push(t);
  return list.length ? list.join(", ") : null;
}

/** Local weekday/hour for a timestamp, given the owner's timezone offset in minutes. */
export function localParts(iso: string, tzOffsetMinutes: number): { weekday: number; hour: number } {
  const d = new Date(Date.parse(iso) + tzOffsetMinutes * 60_000);
  return { weekday: d.getUTCDay(), hour: d.getUTCHours() };
}
