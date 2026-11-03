import { describe, expect, it } from "vitest";
import { checkRecord, makeRecord, validPin } from "../src/lib/pin";

describe("PIN hashing", () => {
  it("accepts the right PIN only", async () => {
    const r = await makeRecord("4821", 3, 1000);
    expect(await checkRecord(r, "4821")).toBe(true);
    expect(await checkRecord(r, "4822")).toBe(false);
    expect(await checkRecord(r, "482")).toBe(false);
    expect(await checkRecord(r, "48211")).toBe(false);
  });
  it("never stores the PIN and salts every record", async () => {
    const a = await makeRecord("123456", 1, 1000);
    const b = await makeRecord("123456", 1, 1000);
    expect(JSON.stringify(a)).not.toContain("123456");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(a.len).toBe(6);
    expect(a.uid).toBe(1);
  });
  it("checks the shape of a PIN", async () => {
    for (const bad of ["", "123", "1234567", "12a4", "12 34"]) expect(validPin(bad)).toBe(false);
    for (const ok of ["1234", "12345", "123456", "0000"]) expect(validPin(ok)).toBe(true);
    await expect(makeRecord("12", 1, 1000)).rejects.toThrow();
  });
});
