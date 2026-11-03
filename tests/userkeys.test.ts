import { describe, expect, it } from "vitest";
import { messageHashInput, plainMerchantKey, plainSlug, storedMerchantKey, storedSlug, userKey } from "../worker/lib/userkeys";

describe("per-user keys", () => {
  it("leaves the owner's values untouched", () => {
    expect(userKey(1, "budget:overall:2026-11-01:90")).toBe("budget:overall:2026-11-01:90");
    expect(storedSlug(1, "food")).toBe("food");
    expect(storedMerchantKey(1, "bravo")).toBe("bravo");
    expect(messageHashInput(1, "text")).toBe("text");
  });

  it("separates other users from the owner and from each other", () => {
    expect(userKey(7, "k")).toBe("u7:k");
    expect(storedSlug(7, "food.supermarket")).toBe("food.supermarket@7");
    expect(storedSlug(7, "food")).not.toBe(storedSlug(8, "food"));
    expect(storedMerchantKey(7, "bravo")).not.toBe(storedMerchantKey(8, "bravo"));
    expect(messageHashInput(7, "text")).not.toBe(messageHashInput(8, "text"));
    expect(messageHashInput(7, "text")).not.toBe("text");
  });

  it("recovers the plain values", () => {
    expect(plainSlug("food@7")).toBe("food");
    expect(plainSlug("food.supermarket")).toBe("food.supermarket");
    expect(plainSlug(null)).toBeNull();
    expect(plainMerchantKey("bravo@12")).toBe("bravo");
    expect(plainMerchantKey("bravo")).toBe("bravo");
  });
});
