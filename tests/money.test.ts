import { describe, expect, it } from "vitest";
import { formatMoney, parseAmount, periodFor, shiftPeriod, localDate, addDays, daysBetween } from "../shared/money";

describe("formatMoney", () => {
  it("formats minor units with grouping and the manat sign", () => {
    expect(formatMoney(123456)).toBe("1 234.56 ₼");
    expect(formatMoney(-1250)).toBe("−12.50 ₼");
    expect(formatMoney(1250, "AZN", { sign: true })).toBe("+12.50 ₼");
    expect(formatMoney(999, "USD")).toBe("9.99 $");
    expect(formatMoney(150049, "AZN", { decimals: false })).toBe("1 500 ₼");
  });
});

describe("parseAmount", () => {
  it("understands common decimal and grouping styles", () => {
    expect(parseAmount("12.50")).toBe(1250);
    expect(parseAmount("12,5")).toBe(1250);
    expect(parseAmount("1 234.56")).toBe(123456);
    expect(parseAmount("1,234.56")).toBe(123456);
    expect(parseAmount("1.234,56")).toBe(123456);
    expect(parseAmount("1,500")).toBe(150000);
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});

describe("periods", () => {
  it("uses calendar months when the month starts on the 1st", () => {
    expect(periodFor("2026-10-24", 1)).toEqual({ start: "2026-10-01", end: "2026-10-31", label: "Oct 2026" });
    expect(periodFor("2026-02-10", 1).end).toBe("2026-02-28");
  });
  it("runs from salary day to the day before the next one", () => {
    expect(periodFor("2026-10-24", 25)).toMatchObject({ start: "2026-09-25", end: "2026-10-24" });
    expect(periodFor("2026-10-25", 25)).toMatchObject({ start: "2026-10-25", end: "2026-11-24" });
    expect(periodFor("2026-01-05", 25)).toMatchObject({ start: "2025-12-25", end: "2026-01-24" });
  });
  it("clamps start days beyond the end of short months", () => {
    expect(periodFor("2026-02-28", 28)).toMatchObject({ start: "2026-02-28", end: "2026-03-27" });
  });
  it("moves between periods", () => {
    expect(shiftPeriod("2026-10-24", 1, -1)).toMatchObject({ start: "2026-09-01", end: "2026-09-30" });
    expect(shiftPeriod("2026-10-24", 1, 2)).toMatchObject({ start: "2026-12-01", end: "2026-12-31" });
    expect(shiftPeriod("2026-01-15", 1, -1)).toMatchObject({ start: "2025-12-01" });
  });
  it("computes local dates in Baku time", () => {
    expect(localDate(new Date("2026-10-24T21:30:00Z"), 240)).toBe("2026-10-25");
    expect(localDate(new Date("2026-10-24T19:30:00Z"), 240)).toBe("2026-10-24");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
  });
});
