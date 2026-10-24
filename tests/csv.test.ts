import { describe, expect, it } from "vitest";
import { amountCell, guessDateFormat, parseCsv, parseDateCell } from "../src/lib/csv";

describe("CSV import helpers", () => {
  it("parses quoted cells and detects the separator", () => {
    expect(parseCsv('Tarix;Təsvir;Məbləğ\n24.10.2026;"BRAVO; BAKU";-12,50\n')).toEqual([
      ["Tarix", "Təsvir", "Məbləğ"],
      ["24.10.2026", "BRAVO; BAKU", "-12,50"],
    ]);
    expect(parseCsv('﻿date,desc,amount\r\n2026-10-24,"Say ""hi""",5\r\n')[1]).toEqual(["2026-10-24", 'Say "hi"', "5"]);
  });
  it("reads dates in different formats", () => {
    expect(parseDateCell("24.10.2026 14:32", "dmy")).toEqual({ date: "2026-10-24", time: "14:32" });
    expect(parseDateCell("2026-10-24", "ymd")).toEqual({ date: "2026-10-24", time: null });
    expect(parseDateCell("10/24/26", "mdy")).toEqual({ date: "2026-10-24", time: null });
    expect(parseDateCell("nonsense", "dmy")).toBeNull();
    expect(guessDateFormat(["10/24/2026"])).toBe("mdy");
    expect(guessDateFormat(["2026-10-24"])).toBe("ymd");
  });
  it("reads signed amounts", () => {
    expect(amountCell("-12,50")).toBe(-1250);
    expect(amountCell("1 234.00 AZN")).toBe(123400);
    expect(amountCell("(45.00)")).toBe(-4500);
    expect(amountCell("")).toBeNull();
  });
});
