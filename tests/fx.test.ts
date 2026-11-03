import { describe, expect, it } from "vitest";
import { parseCbarXml, parseErApi } from "../worker/services/fx";
import { splitCurrency } from "../worker/services/telegram";

const CBAR = `<?xml version="1.0" encoding="UTF-8"?>
<ValCurs Date="03.11.2026" Name="AZN rəsmi məzənnəsi" Description="Azərbaycan Respublikası Mərkəzi Bankı">
  <ValType Type="Xarici valyutalar">
    <Valute Code="USD"><Nominal>1</Nominal><Name>1 ABŞ dolları</Name><Value>1.7000</Value></Valute>
    <Valute Code="EUR"><Nominal>1</Nominal><Name>1 Avro</Name><Value>1.9722</Value></Valute>
    <Valute Code="RUB"><Nominal>100</Nominal><Name>100 Rusiya rublu</Name><Value>2.1500</Value></Valute>
    <Valute Code="TRY"><Nominal>1</Nominal><Name>1 Türkiyə lirəsi</Name><Value>0.0400</Value></Valute>
  </ValType>
</ValCurs>`;

describe("parseCbarXml", () => {
  it("returns AZN per single unit, honouring Nominal", () => {
    const r = parseCbarXml(CBAR);
    expect(r.USD).toBeCloseTo(1.7, 6);
    expect(r.EUR).toBeCloseTo(1.9722, 6);
    expect(r.RUB).toBeCloseTo(0.0215, 6);
    expect(r.TRY).toBeCloseTo(0.04, 6);
  });
  it("returns nothing for an error page", () => {
    expect(parseCbarXml("<html>Not found</html>")).toEqual({});
  });
});

describe("parseErApi", () => {
  const sample = { result: "success", base_code: "USD", rates: { USD: 1, AZN: 1.7, EUR: 0.85, GBP: 0.74, RUB: 80 } };
  it("converts the USD table to AZN per unit", () => {
    const r = parseErApi(sample);
    expect(r.USD).toBeCloseTo(1.7, 6);
    expect(r.EUR).toBeCloseTo(2, 6);
    expect(r.GBP).toBeCloseTo(1.7 / 0.74, 6);
    expect(r.RUB).toBeCloseTo(0.02125, 6);
    expect(r.AZN).toBe(1);
  });
  it("rejects errors and tables without AZN", () => {
    expect(parseErApi({ result: "error" })).toEqual({});
    expect(parseErApi({ result: "success", rates: { USD: 1, EUR: 0.9 } })).toEqual({});
    expect(parseErApi(null)).toEqual({});
  });
});

describe("splitCurrency", () => {
  it("finds a leading or trailing currency code", () => {
    expect(splitCurrency("usd taxi")).toEqual({ label: "taxi", currency: "USD" });
    expect(splitCurrency("taxi EUR")).toEqual({ label: "taxi", currency: "EUR" });
    expect(splitCurrency("lunch")).toEqual({ label: "lunch", currency: null });
  });
  it("does not treat a bare code or a word that merely starts with one as a currency", () => {
    expect(splitCurrency("usd")).toEqual({ label: "usd", currency: null });
    expect(splitCurrency("tryout meal")).toEqual({ label: "tryout meal", currency: null });
    expect(splitCurrency("euro trip")).toEqual({ label: "euro trip", currency: null });
  });
});
