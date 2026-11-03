import { describe, expect, it } from "vitest";
import { isSealed, open, seal, signToken, verifyToken, MissingKeyError } from "../worker/lib/secretbox";
import { newRecoveryCode, normalizeRecoveryCode } from "../worker/auth/mfa";
import { matchTotpStep, totpCode } from "../worker/auth/totp";
import type { Env } from "../worker/env";

const key = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const env = (fill = 7) => ({ ENCRYPTION_KEY: key(fill) }) as Env;

describe("seal / open", () => {
  it("round-trips and does not repeat itself", async () => {
    const a = await seal(env(), "JBSWY3DPEHPK3PXP");
    const b = await seal(env(), "JBSWY3DPEHPK3PXP");
    expect(a).not.toBe(b);
    expect(isSealed(a)).toBe(true);
    expect(a).not.toContain("JBSWY3DPEHPK3PXP");
    expect(await open(env(), a)).toBe("JBSWY3DPEHPK3PXP");
  });
  it("fails with another key or tampered data", async () => {
    const sealed = await seal(env(1), "secret");
    await expect(open(env(2), sealed)).rejects.toThrow();
    const [iv, ct] = sealed.slice(5).split(":");
    await expect(open(env(1), `enc1:${iv}:${ct.slice(0, -4)}AAAA`)).rejects.toThrow();
  });
  it("reads values saved before encryption existed", async () => expect(await open(env(), "PLAINSECRET")).toBe("PLAINSECRET"));
  it("explains a missing key", async () => {
    await expect(seal({} as Env, "x")).rejects.toBeInstanceOf(MissingKeyError);
    await expect(seal({ ENCRYPTION_KEY: btoa("short") } as Env, "x")).rejects.toThrow(/32 bytes/);
  });
});

describe("signed tokens", () => {
  it("accepts its own token and carries the payload", async () => {
    const t = await signToken(env(), { u: 5 }, 60);
    expect((await verifyToken<{ u: number }>(env(), t))?.u).toBe(5);
  });
  it("rejects tampering, another key, expiry and junk", async () => {
    const t = await signToken(env(1), { u: 5 }, 60);
    const [body, sig] = t.split(".");
    const forged = `${btoa(JSON.stringify({ u: 1, exp: 9999999999 })).replace(/=+$/, "")}.${sig}`;
    expect(await verifyToken(env(1), forged)).toBeNull();
    expect(await verifyToken(env(2), t)).toBeNull();
    expect(await verifyToken(env(1), t, Date.now() + 61_000)).toBeNull();
    expect(await verifyToken(env(1), `${body}.`)).toBeNull();
    expect(await verifyToken(env(1), undefined)).toBeNull();
    expect(await verifyToken(env(1), "nonsense")).toBeNull();
  });
});

describe("recovery codes", () => {
  it("look like xxxxx-xxxxx and normalise the same way however typed", () => {
    const c = newRecoveryCode();
    expect(c).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
    expect(normalizeRecoveryCode(c.toUpperCase())).toBe(normalizeRecoveryCode(c.replace("-", " ")));
    expect(normalizeRecoveryCode(c)).toHaveLength(10);
  });
  it("are different each time", () => expect(new Set(Array.from({ length: 50 }, newRecoveryCode)).size).toBe(50));
});

describe("matchTotpStep", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const now = 1_800_000_000_000;
  const step = Math.floor(now / 30_000);
  it("returns the step of the matching code, allowing one step of drift", async () => {
    expect(await matchTotpStep(secret, await totpCode(secret, step), now)).toBe(step);
    expect(await matchTotpStep(secret, await totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(await matchTotpStep(secret, await totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(await matchTotpStep(secret, await totpCode(secret, step + 3), now)).toBeNull();
    expect(await matchTotpStep(secret, "12ab56", now)).toBeNull();
  });
});
