import { describe, expect, it } from "vitest";
import { goalProgress } from "../shared/goals";

describe("goalProgress", () => {
  const today = "2026-11-03";
  it("computes percent and the monthly amount to reach the deadline", () => {
    const p = goalProgress({ target: 120000, saved: 30000, deadline: "2027-02-01" }, today); // about 3 months
    expect(p.pct).toBe(25);
    expect(p.remaining).toBe(90000);
    expect(p.days_left).toBe(90);
    expect(p.monthly).toBe(Math.ceil(90000 / (90 / 30.44)));
    expect(p.done).toBe(false);
  });
  it("has no monthly amount without a deadline, when done, or when the deadline has passed", () => {
    expect(goalProgress({ target: 1000, saved: 0, deadline: null }, today).monthly).toBeNull();
    expect(goalProgress({ target: 1000, saved: 1000, deadline: "2027-01-01" }, today)).toMatchObject({ done: true, pct: 100, monthly: null });
    expect(goalProgress({ target: 1000, saved: 100, deadline: "2026-10-01" }, today)).toMatchObject({ monthly: null, days_left: -33 });
  });
  it("never needs less than one month and caps at 100%", () => {
    expect(goalProgress({ target: 3000, saved: 0, deadline: "2026-11-10" }, today).monthly).toBe(3000);
    expect(goalProgress({ target: 1000, saved: 5000, deadline: null }, today).pct).toBe(100);
  });
});
