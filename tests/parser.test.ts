import { describe, expect, it } from "vitest";
import { parseBankMessage, foldText } from "../worker/services/parser";

// 24 Oct 2026, 15:00 in Baku (UTC+4)
const opts = { receivedAt: new Date("2026-10-24T11:00:00Z"), tzOffsetMinutes: 240 };
const parse = (t: string) => parseBankMessage(t, opts);

describe("foldText", () => {
  it("keeps length and strips Azerbaijani letters", () => {
    const s = "Ödəniş İLƏ Şəki Çay Ğ ı";
    expect(foldText(s)).toBe("odenis ile seki cay g i");
    expect(foldText(s).length).toBe(s.length);
  });
});

describe("parseBankMessage — key/value layouts", () => {
  it("multi-line Azerbaijani purchase", () => {
    const r = parse("ABB\nMəxaric: 12.50 AZN\nBRAVO SUPERMARKET\nKart: 4169***1234\nTarix: 24.10.2026 14:32\nBalans: 1 000.00 AZN");
    expect(r.is_transaction).toBe(true);
    expect(r.direction).toBe("out");
    expect(r.type).toBe("purchase");
    expect(r.amount).toBe(1250);
    expect(r.currency).toBe("AZN");
    expect(r.merchant).toBe("BRAVO SUPERMARKET");
    expect(r.card_last4).toBe("1234");
    expect(r.balance_after).toBe(100000);
    expect(r.occurred_at).toBe("2026-10-24T10:32:00.000Z");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("labeled fields with Ödəniş and Obyekt", () => {
    const r = parse("Ödəniş: 7.90 AZN\nObyekt: WOLT AZERBAIJAN\nKart: *5678\nTarix: 24.10.26 09:05\nMövcud balans: 250.10 AZN");
    expect(r.amount).toBe(790);
    expect(r.merchant).toBe("WOLT AZERBAIJAN");
    expect(r.card_last4).toBe("5678");
    expect(r.balance_after).toBe(25010);
    expect(r.occurred_at).toBe("2026-10-24T05:05:00.000Z");
  });

  it("income (Mədaxil) is incoming", () => {
    const r = parse("Mədaxil: 1500.00 AZN\nKart: 4169****9012\nTarix: 24.10.2026 10:00\nBalans: 2750.00 AZN");
    expect(r.direction).toBe("in");
    expect(r.type).toBe("income");
    expect(r.amount).toBe(150000);
    expect(r.card_last4).toBe("9012");
  });

  it("operation field decides the type", () => {
    const r = parse("Əməliyyat: Nağdlaşdırma\nMəbləğ: 100.00 AZN\nYer: ABB ATM NIZAMI\nKart: *1234\nBalans: 400.00 AZN");
    expect(r.type).toBe("cash_withdrawal");
    expect(r.direction).toBe("out");
    expect(r.amount).toBe(10000);
  });

  it("foreign currency purchase keeps both amounts", () => {
    const r = parse("Ödəniş: 9.99 USD (16.98 AZN)\nYer: NETFLIX.COM\nKart: *1234\nBalans: 500.00 AZN");
    expect(r.amount).toBe(1698);
    expect(r.currency).toBe("AZN");
    expect(r.orig_amount).toBe(999);
    expect(r.orig_currency).toBe("USD");
    expect(r.merchant).toBe("NETFLIX.COM");
  });

  it("foreign-only amount is reported in its own currency", () => {
    const r = parse("Purchase: 20.00 EUR\nMerchant: AMAZON EU\nCard: ****4321\nAvailable: 300.00 AZN");
    expect(r.amount).toBe(2000);
    expect(r.currency).toBe("EUR");
    expect(r.orig_amount).toBeNull();
    expect(r.balance_after).toBe(30000);
  });
});

describe("parseBankMessage — free text layouts", () => {
  it("comma separated Azerbaijani (no diacritics)", () => {
    const r = parse("Odenis 12.50 AZN, BRAVO HYPERMARKET, Kart *1234, 24.10.2026 14:32, Balans 987.65 AZN");
    expect(r.amount).toBe(1250);
    expect(r.merchant).toBe("BRAVO HYPERMARKET");
    expect(r.card_last4).toBe("1234");
    expect(r.balance_after).toBe(98765);
  });

  it("English sentence with 'at' merchant", () => {
    const r = parse("Purchase of 12.40 AZN at WOLT on card *1234. Available balance 1,234.56 AZN");
    expect(r.amount).toBe(1240);
    expect(r.merchant).toBe("WOLT");
    expect(r.card_last4).toBe("1234");
    expect(r.balance_after).toBe(123456);
    expect(r.direction).toBe("out");
  });

  it("merchant before the amount", () => {
    const r = parse("ABB: 24.10.2026 14:32 *1234 POS BRAVO SUPERMARKET 12.50 AZN Balans: 1000.00 AZN");
    expect(r.amount).toBe(1250);
    expect(r.merchant).toBe("BRAVO SUPERMARKET");
    expect(r.card_last4).toBe("1234");
  });

  it("Azerbaijani prose with Obyekt clause", () => {
    const r = parse("Kartınızdan 25.00 AZN məbləğində ödəniş edildi. Obyekt: ARAZ MARKET. Balans: 475.00 AZN");
    expect(r.direction).toBe("out");
    expect(r.amount).toBe(2500);
    expect(r.merchant).toBe("ARAZ MARKET");
    expect(r.balance_after).toBe(47500);
  });

  it("'from your balance' is not mistaken for the balance figure", () => {
    const r = parse("*1234 balansınızdan 3.20 AZN silindi. BOLT.EU. Qalıq: 96.80 AZN");
    expect(r.amount).toBe(320);
    expect(r.direction).toBe("out");
    expect(r.balance_after).toBe(9680);
    expect(r.merchant).toBe("BOLT.EU");
  });

  it("Russian purchase", () => {
    const r = parse("Покупка 15.00 AZN, KFC GANJLIK, карта *1234, Остаток: 85.00 AZN");
    expect(r.amount).toBe(1500);
    expect(r.direction).toBe("out");
    expect(r.merchant).toBe("KFC GANJLIK");
    expect(r.balance_after).toBe(8500);
  });

  it("signed amounts", () => {
    expect(parse("Kart *1234: +200.00 AZN. Balans 300.00 AZN").direction).toBe("in");
    expect(parse("Kart *1234: -20.00 AZN AZERCELL. Balans 280.00 AZN").direction).toBe("out");
  });

  it("refund is incoming", () => {
    const r = parse("Geri qaytarma: 30.00 AZN, TRENDYOL, Kart *1234, Balans 330.00 AZN");
    expect(r.type).toBe("refund");
    expect(r.direction).toBe("in");
    expect(r.merchant).toBe("TRENDYOL");
  });

  it("card-to-card transfer received", () => {
    const r = parse("Köçürmə: 50.00 AZN kartınıza daxil oldu. Kart: *1234. Balans: 350.00 AZN");
    expect(r.direction).toBe("in");
    expect(r.type).toBe("transfer_in");
  });

  it("card-to-card transfer sent", () => {
    const r = parse("Köçürmə: 50.00 AZN kartınızdan. Kart: *1234. Balans: 300.00 AZN");
    expect(r.direction).toBe("out");
    expect(r.type).toBe("transfer_out");
  });

  it("thousands with comma and manat sign", () => {
    const r = parse("Mədaxil 2,500.00 ₼ Kart *1234");
    expect(r.amount).toBe(250000);
    expect(r.direction).toBe("in");
  });

  it("uses the arrival day when only a time is given", () => {
    const r = parse("Odenis 5.00 AZN, CAFE, Kart *1234, 14:10");
    expect(r.occurred_at).toBe("2026-10-24T10:10:00.000Z");
  });
});

describe("parseBankMessage — not transactions", () => {
  it("ignores one-time passwords even when they mention an amount", () => {
    expect(parse("3D Secure kod: 482913. Ödəniş 50.00 AZN ALIEXPRESS. Kodu heç kimə deməyin").is_transaction).toBe(false);
    expect(parse("Your code is 123456").is_transaction).toBe(false);
    expect(parse("Ваш код подтверждения: 5521").is_transaction).toBe(false);
  });

  it("ignores messages without an amount", () => {
    expect(parse("ABB: Yeni kampaniya! Kartla ödənişlərdə 5% keşbek").is_transaction).toBe(false);
  });

  it("does not read the card number or date as amounts", () => {
    const r = parse("Kart 4169 50.00 AZN odenis BRAVO 24.10.2026");
    expect(r.amount).toBe(5000);
  });
});

describe("parseBankMessage — descriptions and names", () => {
  it("uses the purpose line for incoming salary instead of a key/value line", () => {
    const r = parse("Mədaxil: 2800.00 AZN\nKart: 4169****9012\nTəyinat: ƏMƏK HAQQI\nTarix: 01.10.2026 10:02\nBalans: 3000.00 AZN");
    expect(r.merchant).toBe("ƏMƏK HAQQI");
    expect(r.type).toBe("income");
  });
  it("keeps store names that contain words like 'saat'", () => {
    const a = parse("ABB\nMəxaric: 5.00 AZN\nMAGAZA 24 SAAT\nKart: 4169***1234\nTarix: 24.10.2026 23:10\nBalans: 10.00 AZN");
    const b = parse("Ödəniş: 5.00 AZN\nObyekt: MAGAZA 24 SAAT\nKart: *1234\nTarix: 24.10.2026 23:10\nMövcud balans: 10.00 AZN");
    expect(a.merchant).toBe("MAGAZA 24 SAAT");
    expect(b.merchant).toBe("MAGAZA 24 SAAT");
  });
});
