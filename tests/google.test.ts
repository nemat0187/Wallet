import { describe, expect, it } from "vitest";
import { authUrl, checkClaims, decodeJwtPayload, redirectUri } from "../worker/services/google";
import type { Env } from "../worker/env";

const NOW = 1_800_000_000;
const good = { iss: "https://accounts.google.com", aud: "client-1", sub: "123", email: "a@b.test", email_verified: true, nonce: "n1", exp: NOW + 600, name: "A" };
const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

describe("checkClaims", () => {
  it("accepts a good token", () => expect(checkClaims(good, "client-1", "n1", NOW).email).toBe("a@b.test"));
  it("accepts the bare issuer form and a string email_verified", () => {
    expect(() => checkClaims({ ...good, iss: "accounts.google.com", email_verified: "true" }, "client-1", "n1", NOW)).not.toThrow();
  });
  const bad: [string, object][] = [
    ["issuer", { iss: "https://evil.test" }],
    ["audience", { aud: "other" }],
    ["expiry", { exp: NOW - 1 }],
    ["nonce", { nonce: "zzz" }],
    ["missing nonce", { nonce: undefined }],
    ["subject", { sub: "" }],
    ["email", { email: "" }],
    ["unverified email", { email_verified: false }],
    ["unverified email string", { email_verified: "false" }],
  ];
  for (const [name, patch] of bad) it(`rejects a wrong ${name}`, () => expect(() => checkClaims({ ...good, ...patch }, "client-1", "n1", NOW)).toThrow());
});

describe("decodeJwtPayload", () => {
  it("reads unicode names", () => expect(decodeJwtPayload(jwt({ name: "Nəmət Rəhimli" })).name).toBe("Nəmət Rəhimli"));
  it("rejects garbage", () => expect(() => decodeJwtPayload("nope")).toThrow());
});

describe("authUrl", () => {
  const env = { GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "s" } as Env;
  it("asks for openid email profile and passes state and nonce", () => {
    const url = new URL(authUrl(env, "https://wallet.example.dev", "S", "N"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("S");
    expect(url.searchParams.get("nonce")).toBe("N");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri("https://wallet.example.dev"));
  });
});
