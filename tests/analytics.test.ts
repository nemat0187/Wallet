import { describe, expect, it } from "vitest";
import { detectRecurring } from "../worker/services/analytics";
import { makeStatus } from "../worker/services/budgets";
import { ruleMatches } from "../worker/services/categorize";
import type { Rule } from "../shared/types";

const row = (merchant_id: number, name: string, local_date: string, amount: number) => ({ merchant_id, name, category_id: null, local_date, amount });

describe("detectRecurring", () => {
  it("finds a monthly subscription with a stable amount", () => {
    const rows = ["2026-06-08", "2026-07-08", "2026-08-07", "2026-09-08", "2026-10-08"].map((d) => row(1, "Netflix", d, 1698));
    const [r] = detectRecurring(rows, "2026-10-24");
    expect(r).toMatchObject({ name: "Netflix", cadence: "monthly", amount: 1698, active: true, next_date: "2026-11-07" });
    expect(r.monthly_cost).toBe(1698);
  });
  it("finds weekly payments and marks variable amounts", () => {
    const rows = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29", "2026-10-06", "2026-10-13", "2026-10-20"].map((d, i) =>
      row(2, "Yoga class", d, i % 2 ? 2000 : 2800),
    );
    const [r] = detectRecurring(rows, "2026-10-24");
    expect(r.cadence).toBe("weekly");
    expect(r.variable).toBe(true);
  });
  it("ignores everyday shopping and stopped subscriptions are inactive", () => {
    const groceries = Array.from({ length: 30 }, (_, i) => row(3, "Bravo", `2026-10-${String(i + 1).padStart(2, "0")}`, 1500 + i * 37));
    expect(detectRecurring(groceries, "2026-10-31")).toHaveLength(0);
    const old = ["2026-01-05", "2026-02-05", "2026-03-05"].map((d) => row(4, "Old gym", d, 6000));
    expect(detectRecurring(old, "2026-10-24")[0].active).toBe(false);
  });
});

describe("makeStatus", () => {
  const period = { start: "2026-10-01", end: "2026-10-31" };
  it("projects end-of-month spending from the current pace", () => {
    const s = makeStatus(1, 5, 30000, 12000, 80, period, "2026-10-10");
    expect(s.projected).toBe(37200);
    expect(s.status).toBe("warning");
    expect(s.remaining).toBe(18000);
    // On pace (10 000 by day 10 → 31 000) stays within the 5% tolerance.
    expect(makeStatus(1, 5, 30000, 10000, 80, period, "2026-10-10").status).toBe("ok");
  });
  it("flags budgets that are over", () => {
    expect(makeStatus(1, 5, 30000, 30100, 80, period, "2026-10-20").status).toBe("over");
    expect(makeStatus(1, 5, 30000, 5000, 80, period, "2026-10-20").status).toBe("ok");
  });
});

describe("ruleMatches", () => {
  const base: Rule = {
    id: 1, name: null, match_field: "any", match_type: "contains", pattern: "ev sahibi", direction: null, min_amount: null, max_amount: null,
    account_id: null, set_category_id: 1, set_kind: null, set_merchant_name: null, set_excluded: null, priority: 100, enabled: 1, hits: 0,
  };
  const tx = { merchant_raw: "Köçürmə: EV SAHİBİ", description: null, amount: -65000, account_id: 2, merchant: null };
  it("matches case- and accent-insensitively", () => {
    expect(ruleMatches(base, tx, "out")).toBe(true);
  });
  it("respects direction, amount and card limits", () => {
    expect(ruleMatches({ ...base, direction: "in" }, tx, "out")).toBe(false);
    expect(ruleMatches({ ...base, min_amount: 70000 }, tx, "out")).toBe(false);
    expect(ruleMatches({ ...base, account_id: 3 }, tx, "out")).toBe(false);
    expect(ruleMatches({ ...base, match_type: "regex", pattern: "EV\\s+SAH" }, tx, "out")).toBe(true);
    expect(ruleMatches({ ...base, match_type: "regex", pattern: "([" }, tx, "out")).toBe(false);
  });
});
