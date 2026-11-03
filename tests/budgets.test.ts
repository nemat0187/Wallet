import { describe, expect, it } from "vitest";
import { daysUntilNextWindow, rangePeriod, type RangeBudgetDef } from "../shared/budgets";

const days = (start_day: number, end_day: number): RangeBudgetDef => ({ scope: "days", start_day, end_day, start_date: null, end_date: null });
const dates = (start_date: string, end_date: string): RangeBudgetDef => ({ scope: "dates", start_day: null, end_day: null, start_date, end_date });

describe("rangePeriod: days of the month", () => {
  it("shows the window that contains the day", () => {
    expect(rangePeriod(days(15, 30), "2026-11-20")).toMatchObject({ start: "2026-11-15", end: "2026-11-30", state: "active" });
    expect(rangePeriod(days(15, 30), "2026-11-15")).toMatchObject({ state: "active" });
    expect(rangePeriod(days(15, 30), "2026-11-30")).toMatchObject({ state: "active" });
  });

  it("shows the last finished window between rounds", () => {
    expect(rangePeriod(days(15, 30), "2026-11-05")).toMatchObject({ start: "2026-10-15", end: "2026-10-30", state: "ended" });
    expect(rangePeriod(days(15, 20), "2026-11-25")).toMatchObject({ start: "2026-11-15", end: "2026-11-20", state: "ended" });
  });

  it("clamps to short months", () => {
    expect(rangePeriod(days(15, 31), "2027-02-20")).toMatchObject({ start: "2027-02-15", end: "2027-02-28", state: "active" });
    expect(rangePeriod(days(30, 31), "2027-02-28")).toMatchObject({ start: "2027-02-28", end: "2027-02-28", state: "active" });
  });

  it("wraps into the next month when the end day is before the start day", () => {
    expect(rangePeriod(days(25, 5), "2026-11-28")).toMatchObject({ start: "2026-11-25", end: "2026-12-05", state: "active" });
    expect(rangePeriod(days(25, 5), "2026-12-03")).toMatchObject({ start: "2026-11-25", end: "2026-12-05", state: "active" });
    expect(rangePeriod(days(25, 5), "2027-01-02")).toMatchObject({ start: "2026-12-25", end: "2027-01-05", state: "active" });
  });
});

describe("rangePeriod: exact dates", () => {
  it("knows if it has started or ended", () => {
    expect(rangePeriod(dates("2026-12-20", "2027-01-05"), "2026-12-01").state).toBe("upcoming");
    expect(rangePeriod(dates("2026-12-20", "2027-01-05"), "2026-12-31").state).toBe("active");
    expect(rangePeriod(dates("2026-12-20", "2027-01-05"), "2027-01-06").state).toBe("ended");
  });
});

describe("daysUntilNextWindow", () => {
  it("counts days until the next round starts", () => {
    expect(daysUntilNextWindow(days(15, 30), "2026-11-05")).toBe(10);
    expect(daysUntilNextWindow(days(15, 30), "2026-11-20")).toBe(25);
    expect(daysUntilNextWindow(dates("2026-12-20", "2027-01-05"), "2026-12-10")).toBe(10);
    expect(daysUntilNextWindow(dates("2026-12-20", "2027-01-05"), "2026-12-25")).toBeNull();
  });
});
