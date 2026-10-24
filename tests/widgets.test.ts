import { describe, expect, it } from "vitest";
import { resolveRange, suggestedChart } from "../shared/widgets";

describe("resolveRange", () => {
  const today = "2026-10-24";
  it("resolves presets", () => {
    expect(resolveRange("this_month", today, 1)).toEqual({ from: "2026-10-01", to: today });
    expect(resolveRange("last_month", today, 25)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(resolveRange("this_period", today, 25)).toEqual({ from: "2026-09-25", to: today });
    expect(resolveRange("last_period", today, 25)).toEqual({ from: "2026-08-25", to: "2026-09-24" });
    expect(resolveRange("last_7", today, 1)).toEqual({ from: "2026-10-18", to: today });
    expect(resolveRange("this_year", today, 1)).toEqual({ from: "2026-01-01", to: today });
    expect(resolveRange("last_year", today, 1)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(resolveRange("last_12_months", today, 1)).toEqual({ from: "2025-11-01", to: today });
  });
  it("custom dates, swapped if needed", () => {
    expect(resolveRange("custom", today, 1, { from: "2026-03-01", to: "2026-03-31" })).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(resolveRange("custom", today, 1, { from: "2026-03-31", to: "2026-03-01" })).toEqual({ from: "2026-03-01", to: "2026-03-31" });
  });
  it("suggests a chart for a grouping", () => {
    expect(suggestedChart("none")).toBe("number");
    expect(suggestedChart("month")).toBe("column");
    expect(suggestedChart("weekday_hour")).toBe("heatmap");
    expect(suggestedChart("merchant")).toBe("bar");
  });
});
