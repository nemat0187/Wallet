// Brute-force protection for the login form: per-IP lockout plus a global
// lockout that also stops attackers rotating IP addresses.

import { first, run } from "../lib/db";

const IP_MAX_FAILURES = 5;
const IP_LOCK_MINUTES = 15;
const GLOBAL_MAX_FAILURES = 30;
const GLOBAL_LOCK_MINUTES = 30;
const WINDOW_MINUTES = 60;

interface AttemptRow {
  failures: number;
  window_start: string;
  locked_until: string | null;
}

/** Returns the number of seconds until the login is unlocked, or 0 if allowed. */
export async function lockedFor(db: D1Database, ip: string): Promise<number> {
  const now = Date.now();
  let wait = 0;
  for (const key of [`ip:${ip}`, "global"]) {
    const row = await first<AttemptRow>(db, "SELECT * FROM login_attempts WHERE key = ?", key);
    if (row?.locked_until && Date.parse(row.locked_until) > now) {
      wait = Math.max(wait, Math.ceil((Date.parse(row.locked_until) - now) / 1000));
    }
  }
  return wait;
}

export async function recordFailure(db: D1Database, ip: string): Promise<void> {
  await bump(db, `ip:${ip}`, IP_MAX_FAILURES, IP_LOCK_MINUTES);
  await bump(db, "global", GLOBAL_MAX_FAILURES, GLOBAL_LOCK_MINUTES);
}

export async function resetFailures(db: D1Database, ip: string): Promise<void> {
  await run(db, "DELETE FROM login_attempts WHERE key = ?", `ip:${ip}`);
}

async function bump(db: D1Database, key: string, max: number, lockMinutes: number): Promise<void> {
  const now = new Date();
  const row = await first<AttemptRow>(db, "SELECT * FROM login_attempts WHERE key = ?", key);
  let failures = 1;
  let windowStart = now.toISOString();
  if (row && now.getTime() - Date.parse(row.window_start) < WINDOW_MINUTES * 60_000) {
    failures = row.failures + 1;
    windowStart = row.window_start;
  }
  const lockedUntil = failures >= max ? new Date(now.getTime() + lockMinutes * 60_000).toISOString() : null;
  await run(
    db,
    `INSERT INTO login_attempts (key, failures, window_start, locked_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until`,
    key,
    lockedUntil ? 0 : failures,
    lockedUntil ? now.toISOString() : windowStart,
    lockedUntil,
  );
}
