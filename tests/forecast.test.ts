import { describe, expect, it } from "vitest";
import { billsBetween, buildForecast, type RecurringBill } from "../shared/forecast";

const bill = (o: Partial<RecurringBill>): RecurringBill => ({ name: "Netflix", amount: 1500, cadence: "monthly", next_date: "2026-10-28", active: true, ...o });

describe("billsBetween", () => {
  it("lists payments inside the window", () => {
    expect(billsBetween([bill({})], "2026-10-24", "2026-10-31")).toEqual([{ name: "Netflix", amount: 1500, date: "2026-10-28" }]);
  });
  it("repeats weekly bills", () => {
    const out = billsBetween([bill({ cadence: "weekly", next_date: "2026-10-25" })], "2026-10-24", "2026-11-10");
    expect(out.map((b) => b.date)).toEqual(["2026-10-25", "2026-11-01", "2026-11-08"]);
  });
  it("skips payments before today and inactive bills", () => {
    expect(billsBetween([bill({ next_date: "2026-10-20" })], "2026-10-24", "2026-11-05")).toEqual([]);
    expect(billsBetween([bill({ next_date: "2026-10-28", active: false })], "2026-10-24", "2026-10-31")).toEqual([]);
  });
});

describe("buildForecast", () => {
  const base = { today: "2026-10-24", periodEnd: "2026-10-31", spentLast30: 90000 };
  it("subtracts bills and spreads the rest over the days left (today included)", () => {
    const f = buildForecast({ ...base, balance: 50000, bills: [bill({ amount: 10000 })] });
    expect(f.days_left).toBe(8);
    expect(f.bills_total).toBe(10000);
    expect(f.after_bills).toBe(40000);
    expect(f.per_day).toBe(5000);
    expect(f.typical_daily).toBe(3000);
  });
  it("never shows a negative daily amount", () => {
    const f = buildForecast({ ...base, balance: 5000, bills: [bill({ amount: 10000 })] });
    expect(f.after_bills).toBe(-5000);
    expect(f.per_day).toBe(0);
  });
  it("handles an unknown balance", () => {
    const f = buildForecast({ ...base, balance: null, bills: [bill({})] });
    expect(f.after_bills).toBeNull();
    expect(f.per_day).toBeNull();
    expect(f.bills).toHaveLength(1);
  });
  it("counts one day on the last day of the period", () => {
    expect(buildForecast({ ...base, today: "2026-10-31", balance: 1000, bills: [] }).days_left).toBe(1);
  });
});
