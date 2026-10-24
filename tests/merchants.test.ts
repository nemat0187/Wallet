import { describe, expect, it } from "vitest";
import { builtinMatch, merchantKey, prettifyMerchant } from "../worker/services/merchants";

describe("merchantKey", () => {
  it("removes terminal numbers, cities and legal suffixes", () => {
    expect(merchantKey("BRAVO SUPERMARKET 0123 BAKU AZ")).toBe("BRAVO SUPERMARKET");
    expect(merchantKey("WOLT AZERBAIJAN")).toBe("WOLT");
    expect(merchantKey("BOLT.EU")).toBe("BOLT");
    expect(merchantKey("Azərsu ASC")).toBe("AZERSU");
    expect(merchantKey("GOOGLE *YouTube")).toBe("GOOGLE YOUTUBE");
  });
  it("is stable for the same merchant written differently", () => {
    expect(merchantKey("Bravo Supermarket, Baku")).toBe(merchantKey("BRAVO SUPERMARKET 0456 BAKU AZE"));
  });
});

describe("prettifyMerchant", () => {
  it("title-cases shouting names but keeps acronyms", () => {
    expect(prettifyMerchant("BRAVO SUPERMARKET")).toBe("Bravo Supermarket");
    expect(prettifyMerchant("KFC GANJLIK")).toBe("KFC Ganjlik");
    expect(prettifyMerchant("Coffee Moffie")).toBe("Coffee Moffie");
  });
});

describe("builtinMatch", () => {
  const slug = (raw: string) => builtinMatch(merchantKey(raw))?.slug ?? null;
  it("recognises common Azerbaijani merchants", () => {
    expect(slug("BRAVO HYPERMARKET")).toBe("food.supermarket");
    expect(slug("WOLT")).toBe("dining.delivery");
    expect(slug("BOLT FOOD")).toBe("dining.delivery");
    expect(slug("BOLT.EU")).toBe("transport.taxi");
    expect(slug("AZERCELL TELECOM")).toBe("utilities.mobile");
    expect(slug("SOCAR PETROLEUM 12")).toBe("transport.fuel");
    expect(slug("NETFLIX.COM")).toBe("subscriptions.streaming");
    expect(slug("ZEYTUN APTEK 5")).toBe("health.pharmacy");
    expect(slug("KONTAKT HOME")).toBe("shopping.electronics");
  });
  it("uses whole words only", () => {
    expect(slug("PUBLIC LIBRARY")).toBeNull();
    expect(slug("SPARKLE")).toBeNull();
    expect(slug("SOME UNKNOWN PLACE LLC")).toBeNull();
  });
});
