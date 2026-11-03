// Two-step verification with an authenticator app, plus single-use recovery codes.
// Everything here acts on one user: pass the user's own Env (forUser).

import type { Env } from "../env";
import { randomBytes, sha256Hex } from "../lib/crypto";
import { open, seal } from "../lib/secretbox";
import { getSetting, setSetting } from "../services/settings";
import { generateTotpSecret, matchTotpStep, totpUri } from "./totp";

export interface MfaStatus {
  enabled: boolean;
  skipped: boolean;
  recovery_remaining: number;
}

const CODES = 8;

export function newRecoveryCode(): string {
  const hex = [...randomBytes(5)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 5)}-${hex.slice(5)}`;
}

export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^0-9a-f]/g, "");

async function storedCodes(env: Env): Promise<string[]> {
  try {
    return JSON.parse((await getSetting(env.DB, "recovery_codes")) ?? "[]") as string[];
  } catch {
    return [];
  }
}

async function replaceRecoveryCodes(env: Env): Promise<string[]> {
  const codes = Array.from({ length: CODES }, newRecoveryCode);
  const hashes = await Promise.all(codes.map((c) => sha256Hex(normalizeRecoveryCode(c))));
  await setSetting(env.DB, "recovery_codes", JSON.stringify(hashes));
  return codes;
}

export async function mfaStatus(env: Env): Promise<MfaStatus> {
  return {
    enabled: Boolean(await getSetting(env.DB, "totp_secret")),
    skipped: (await getSetting(env.DB, "mfa_skipped")) === "1",
    recovery_remaining: (await storedCodes(env)).length,
  };
}

export async function mfaEnabled(env: Env): Promise<boolean> {
  return Boolean(await getSetting(env.DB, "totp_secret"));
}

/** Begin enrolment: a new secret, kept (encrypted) until the user proves their app works. */
export async function startEnrolment(env: Env, label: string): Promise<{ secret: string; uri: string }> {
  const secret = generateTotpSecret();
  await setSetting(env.DB, "totp_pending_secret", await seal(env, secret));
  return { secret, uri: totpUri(secret, label, "Wallet") };
}

/** Confirm with a code from the app. Returns the recovery codes, shown to the user exactly once. */
export async function confirmEnrolment(env: Env, code: string): Promise<string[] | null> {
  const pending = await getSetting(env.DB, "totp_pending_secret");
  if (!pending) return null;
  const secret = await open(env, pending);
  const step = await matchTotpStep(secret, code);
  if (step === null) return null;
  await setSetting(env.DB, "totp_secret", await seal(env, secret));
  await setSetting(env.DB, "totp_pending_secret", null);
  await setSetting(env.DB, "totp_last_step", String(step));
  await setSetting(env.DB, "mfa_skipped", null);
  return replaceRecoveryCodes(env);
}

/** A 6-digit code (each one usable once) or a recovery code (removed when used). */
export async function verifySecondFactor(env: Env, input: string): Promise<boolean> {
  const stored = await getSetting(env.DB, "totp_secret");
  if (!stored) return false;
  const cleaned = input.trim();
  if (/^\d{3}\s?\d{3}$/.test(cleaned)) {
    const step = await matchTotpStep(await open(env, stored), cleaned);
    if (step === null) return false;
    const last = Number((await getSetting(env.DB, "totp_last_step")) ?? 0);
    if (step <= last) return false; // this code (or an older one) was already used
    await setSetting(env.DB, "totp_last_step", String(step));
    // Upgrade a secret saved before encryption existed.
    if (!stored.startsWith("enc1:")) await setSetting(env.DB, "totp_secret", await seal(env, await open(env, stored)));
    return true;
  }
  const hash = await sha256Hex(normalizeRecoveryCode(cleaned));
  const codes = await storedCodes(env);
  if (normalizeRecoveryCode(cleaned).length !== 10 || !codes.includes(hash)) return false;
  await setSetting(env.DB, "recovery_codes", JSON.stringify(codes.filter((h) => h !== hash)));
  return true;
}

export async function disableMfa(env: Env, code: string): Promise<boolean> {
  if (!(await verifySecondFactor(env, code))) return false;
  for (const key of ["totp_secret", "totp_pending_secret", "totp_last_step", "recovery_codes"]) await setSetting(env.DB, key, null);
  return true;
}

export async function regenerateRecoveryCodes(env: Env, code: string): Promise<string[] | null> {
  if (!(await verifySecondFactor(env, code))) return null;
  return replaceRecoveryCodes(env);
}

export const skipMfa = (env: Env) => setSetting(env.DB, "mfa_skipped", "1");
