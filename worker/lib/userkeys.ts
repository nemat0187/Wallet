// Per-user variants of values that are UNIQUE across the whole database (see migrations/0004_users.sql).
// The owner (user 1) keeps the original values, so nothing existing has to be rewritten.

export const OWNER_ID = 1;

/** "u7:budget:3:2026-11-01:80" for user 7; unchanged for the owner. */
export function userKey(userId: number, key: string): string {
  return userId === OWNER_ID ? key : `u${userId}:${key}`;
}

/** Category slug as stored: "food" for the owner, "food@7" for user 7. */
export function storedSlug(userId: number, slug: string): string {
  return userId === OWNER_ID ? slug : `${slug}@${userId}`;
}

/** The slug the app works with ("food"), whoever owns the row. */
export function plainSlug(slug: string | null): string | null {
  return slug === null ? null : slug.replace(/@\d+$/, "");
}

/** Merchant key as stored: normalized text for the owner, "text@7" for user 7. */
export function storedMerchantKey(userId: number, key: string): string {
  return userId === OWNER_ID ? key : `${key}@${userId}`;
}

export function plainMerchantKey(key: string): string {
  return key.replace(/@\d+$/, "");
}

/** Text hashed to detect a repeated bank message; salted per user so two users can receive the same text. */
export function messageHashInput(userId: number, body: string): string {
  return userId === OWNER_ID ? body : `${userId}\n${body}`;
}
