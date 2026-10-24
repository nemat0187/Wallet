import { describe, expect, it } from "vitest";
import { applyRules, conditionMatches, localParts, mergeTags, ruleConditions, ruleMatches, type Condition, type RuleContext } from "../shared/rules";
import type { Rule } from "../shared/types";

const ctx: RuleContext = {
  merchant: "Ev Sahibi",
  merchant_raw: "Köçürmə: EV SAHİBİ",
  description: "Transfer sent",
  message: "💸 Köçürmə: -650.00₼\nABB MOBILE\nKart: **4934\nBalans: 1,200.00₼",
  amount: -65000,
  currency: "AZN",
  account_id: 2,
  type: "transfer_out",
  local_weekday: 5,
  local_hour: 21,
  category_id: 30,
  category_parent_id: 3,
};

function rule(partial: Partial<Rule> & { conditions?: string | null }): Rule {
  return {
    id: 1, name: null, match_field: "any", match_type: "contains", pattern: "", direction: null, min_amount: null, max_amount: null,
    account_id: null, set_category_id: null, set_kind: null, set_merchant_name: null, set_excluded: null, priority: 10, enabled: 1, hits: 0,
    conditions: null, match_mode: "all", set_tags: null, set_note: null, continue_after: 0, ...partial,
  };
}
const c = (cond: Condition) => conditionMatches(cond, ctx);

describe("conditions", () => {
  it("text matches ignore case and Azerbaijani letters", () => {
    expect(c({ field: "merchant", op: "contains", value: "ev sahibi" })).toBe(true);
    expect(c({ field: "message", op: "contains", value: "kocurme" })).toBe(true);
    expect(c({ field: "any_text", op: "contains", value: "ABB mobile" })).toBe(true);
    expect(c({ field: "merchant", op: "not_contains", value: "bolt" })).toBe(true);
    expect(c({ field: "merchant", op: "starts_with", value: "Ev" })).toBe(true);
    expect(c({ field: "description", op: "equals", value: "transfer sent" })).toBe(true);
    expect(c({ field: "message", op: "regex", value: "Kart: \\*\\*49\\d\\d" })).toBe(true);
    expect(c({ field: "message", op: "regex", value: "([" })).toBe(false);
  });
  it("amount comparisons use the absolute amount", () => {
    expect(c({ field: "amount", op: "eq", value: 65000 })).toBe(true);
    expect(c({ field: "amount", op: "gt", value: 50000 })).toBe(true);
    expect(c({ field: "amount", op: "between", value: 60000, value2: 70000 })).toBe(true);
    expect(c({ field: "amount", op: "lt", value: 1000 })).toBe(false);
  });
  it("direction, card, type, weekday, hour, currency, category", () => {
    expect(c({ field: "direction", op: "is", value: "out" })).toBe(true);
    expect(c({ field: "account", op: "is", value: [2, 3] })).toBe(true);
    expect(c({ field: "account", op: "is_not", value: [2] })).toBe(false);
    expect(c({ field: "type", op: "is", value: ["transfer_out"] })).toBe(true);
    expect(c({ field: "weekday", op: "is", value: [5, 6] })).toBe(true);
    expect(c({ field: "hour", op: "between", value: 20, value2: 23 })).toBe(true);
    expect(c({ field: "hour", op: "between", value: 22, value2: 4 })).toBe(false);
    expect(conditionMatches({ field: "hour", op: "between", value: 22, value2: 4 }, { ...ctx, local_hour: 2 })).toBe(true);
    expect(c({ field: "currency", op: "is", value: ["USD"] })).toBe(false);
    expect(c({ field: "category", op: "is", value: [3] })).toBe(true); // parent category counts
  });
});

describe("rules", () => {
  it("all vs any", () => {
    const conds = JSON.stringify([
      { field: "amount", op: "eq", value: 65000 },
      { field: "merchant", op: "contains", value: "landlord" },
    ]);
    expect(ruleMatches(rule({ conditions: conds, match_mode: "all" }), ctx)).toBe(false);
    expect(ruleMatches(rule({ conditions: conds, match_mode: "any" }), ctx)).toBe(true);
  });
  it("reads rules saved by the previous version", () => {
    const legacy = rule({ pattern: "ev sahibi", match_field: "merchant", direction: "out", min_amount: 60000 });
    expect(ruleConditions(legacy)).toHaveLength(3);
    expect(ruleMatches(legacy, ctx)).toBe(true);
  });
  it("first match wins unless it says to keep checking; tags add up", () => {
    const rules = [
      rule({ id: 1, conditions: JSON.stringify([{ field: "type", op: "is", value: ["transfer_out"] }]), set_tags: "transfer", continue_after: 1 }),
      rule({ id: 2, conditions: JSON.stringify([{ field: "amount", op: "eq", value: 65000 }]), set_category_id: 99, set_tags: "rent, home", set_note: "Monthly rent" }),
      rule({ id: 3, conditions: JSON.stringify([{ field: "direction", op: "is", value: "out" }]), set_category_id: 50 }),
    ];
    const fx = applyRules(rules, ctx);
    expect(fx.rule_ids).toEqual([1, 2]);
    expect(fx.category_id).toBe(99);
    expect(fx.tags).toEqual(["transfer", "rent", "home"]);
    expect(fx.note).toBe("Monthly rent");
  });
  it("skips disabled rules and rules without conditions", () => {
    expect(applyRules([rule({ enabled: 0, conditions: JSON.stringify([{ field: "direction", op: "is", value: "out" }]), set_category_id: 1 })], ctx).rule_ids).toEqual([]);
    expect(applyRules([rule({ conditions: "[]", set_category_id: 1 })], ctx).rule_ids).toEqual([]);
  });
  it("helpers", () => {
    expect(mergeTags("a, b", ["b", "c"])).toBe("a, b, c");
    expect(mergeTags(null, [])).toBeNull();
    expect(localParts("2026-10-24T18:30:00Z", 240)).toEqual({ weekday: 6, hour: 22 });
  });
});
