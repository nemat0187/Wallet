// App-lock PIN for this device. It never leaves the device: only a salted PBKDF2 hash is kept in browser storage.
// It guards a phone that is left unlocked; the server session is what actually signs you in.

export const MIN_LEN = 4;
export const MAX_LEN = 6;
export const MAX_TRIES = 5;
const ITERATIONS = 200_000;

export interface PinRecord {
  uid: number; // the user this PIN belongs to
  len: number;
  salt: string;
  hash: string;
  iter: number;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations: iter }, key, 256));
}

export const validPin = (pin: string) => new RegExp(`^\\d{${MIN_LEN},${MAX_LEN}}$`).test(pin);

export async function makeRecord(pin: string, uid: number, iter = ITERATIONS): Promise<PinRecord> {
  if (!validPin(pin)) throw new Error(`A PIN is ${MIN_LEN} to ${MAX_LEN} digits`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { uid, len: pin.length, salt: b64(salt), hash: b64(await derive(pin, salt, iter)), iter };
}

export async function checkRecord(record: PinRecord, pin: string): Promise<boolean> {
  if (!validPin(pin)) return false;
  const got = await derive(pin, unb64(record.salt), record.iter);
  const want = unb64(record.hash);
  let diff = got.length ^ want.length;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ (want[i] ?? 0);
  return diff === 0;
}

// --- storage (private-mode safe) -----------------------------------------------------------------------------
const KEY = "wallet-pin";
const TRIES = "wallet-pin-tries";
const TIMEOUT = "wallet-lock-after";
const ACTIVE = "wallet-last-active";

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // storage unavailable: the lock simply won't persist
  }
};

export function loadRecord(): PinRecord | null {
  try {
    const r = JSON.parse(read(KEY) ?? "null") as PinRecord | null;
    return r && typeof r.hash === "string" && typeof r.uid === "number" ? r : null;
  } catch {
    return null;
  }
}
export const saveRecord = (r: PinRecord) => {
  write(KEY, JSON.stringify(r));
  write(TRIES, null);
};
/** Forget the PIN of this device (sign-out, too many wrong tries). */
export function clearPin() {
  write(KEY, null);
  write(TRIES, null);
  write(ACTIVE, null);
}

export const triesLeft = () => MAX_TRIES - Number(read(TRIES) ?? 0);
export function recordWrongTry(): number {
  const n = Number(read(TRIES) ?? 0) + 1;
  write(TRIES, String(n));
  return MAX_TRIES - n;
}
export const resetTries = () => write(TRIES, null);

/** How long the app may be out of sight before it locks, in minutes (0 = lock whenever it is left). */
export const LOCK_OPTIONS = [
  { value: 0, label: "Right away" },
  { value: 1, label: "After 1 minute" },
  { value: 5, label: "After 5 minutes" },
  { value: 15, label: "After 15 minutes" },
];
export const lockAfterMinutes = () => {
  const v = Number(read(TIMEOUT) ?? 1);
  return LOCK_OPTIONS.some((o) => o.value === v) ? v : 1;
};
export const setLockAfterMinutes = (m: number) => write(TIMEOUT, String(m));

export const touchActive = () => write(ACTIVE, String(Date.now()));
/** Has the app been out of use for longer than the lock time (or is this a fresh start with no record)? */
export function shouldLock(now = Date.now()): boolean {
  const last = Number(read(ACTIVE) ?? 0);
  if (!last) return true;
  return now - last >= lockAfterMinutes() * 60_000 && (lockAfterMinutes() > 0 || now - last > 0);
}
