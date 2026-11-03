import { describe, expect, it } from "vitest";
import { balanceEffect, type BalanceRow } from "../worker/services/transactions";

const card = { type: "card", currency: "AZN", balance_at: "2026-10-24T12:00:00.000Z" };
const row = (over: Partial<BalanceRow> = {}): BalanceRow => ({
  account_id: 1,
  amount: -1000,
  amount_base: -1000,
  currency: "AZN",
  balance_after: 5000,
  occurred_at: "2026-10-24T10:00:00.000Z",
  source: "push",
  ...over,
});

describe("balanceEffect", () => {
  it("counts bank payments that are inside the balance snapshot", () => {
    expect(balanceEffect(row(), card)).toBe(-1000);
    expect(balanceEffect(row({ occurred_at: "2026-10-24T12:00:00.000Z" }), card)).toBe(-1000);
  });

  it("ignores payments newer than the snapshot", () => {
    expect(balanceEffect(row({ occurred_at: "2026-10-24T12:00:01.000Z" }), card)).toBe(0);
  });

  it("ignores imported rows that never carried a balance", () => {
    expect(balanceEffect(row({ balance_after: null, source: "import" }), card)).toBe(0);
    expect(balanceEffect(row({ balance_after: null, source: "manual" }), card)).toBe(0);
  });

  it("counts every manual entry on a cash wallet", () => {
    const cash = { type: "cash", currency: "AZN", balance_at: null };
    expect(balanceEffect(row({ balance_after: null, source: "manual" }), cash)).toBe(-1000);
    expect(balanceEffect(row({ balance_after: null, source: "telegram" }), cash)).toBe(0);
  });

  it("uses the AZN equivalent for foreign-currency payments on an AZN card", () => {
    expect(balanceEffect(row({ currency: "USD", amount: -500, amount_base: -850 }), card)).toBe(-850);
    expect(balanceEffect(row({ currency: "USD", amount: -500, amount_base: -850 }), { ...card, currency: "EUR" })).toBe(0);
  });

  it("does nothing without an account", () => {
    expect(balanceEffect(row(), undefined)).toBe(0);
  });
});
