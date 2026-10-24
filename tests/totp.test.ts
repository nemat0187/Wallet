import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, totpCode, verifyTotp } from "../worker/auth/totp";

// RFC 6238 test secret "12345678901234567890" (ASCII), SHA-1.
const SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

describe("TOTP", () => {
  it("round-trips base32", () => {
    expect(SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(new TextDecoder().decode(base32Decode(SECRET))).toBe("12345678901234567890");
  });
  it("matches the RFC 6238 test vectors (last 6 digits)", async () => {
    expect(await totpCode(SECRET, Math.floor(59 / 30))).toBe("287082");
    expect(await totpCode(SECRET, Math.floor(1111111109 / 30))).toBe("081804");
    expect(await totpCode(SECRET, Math.floor(1234567890 / 30))).toBe("005924");
  });
  it("accepts one step of clock drift and rejects garbage", async () => {
    const now = 1234567890 * 1000;
    expect(await verifyTotp(SECRET, "005924", now)).toBe(true);
    expect(await verifyTotp(SECRET, "005924", now + 30_000)).toBe(true);
    expect(await verifyTotp(SECRET, "005924", now + 90_000)).toBe(false);
    expect(await verifyTotp(SECRET, "12ab56", now)).toBe(false);
  });
});
