// First-run setup for a user: default categories and a cash wallet.

import { DEFAULT_CATEGORIES } from "@shared/categories";
import { all, first, nowIso } from "../lib/db";
import { userIdOfDb } from "../lib/scoped";
import { storedSlug } from "../lib/userkeys";
import { getSetting, setSetting } from "./settings";

const SEED_VERSION = "1";
/** Users already checked in this isolate (a worker instance), so most requests skip the settings lookup. */
const seededInThisIsolate = new Set<number>();

/** `db` must be a per-user database (forUser). */
export async function ensureSeeded(db: D1Database): Promise<void> {
  const userId = userIdOfDb(db);
  if (seededInThisIsolate.has(userId)) return;
  if ((await getSetting(db, "seed_version")) === SEED_VERSION) {
    seededInThisIsolate.add(userId);
    return;
  }
  const existing = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM categories");
  const now = nowIso();
  if (!existing?.n) {
    // Parents first (one batch), then children that point at their parent's id.
    // Slugs are stored with a per-user suffix for users other than the owner (see worker/lib/userkeys.ts).
    await db.batch(
      DEFAULT_CATEGORIES.map((c, i) =>
        db
          .prepare("INSERT INTO categories (parent_id, slug, name, kind, icon, color, sort_order, created_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)")
          .bind(storedSlug(userId, c.slug), c.name, c.kind, c.icon, c.color ?? null, i, now),
      ),
    );
    // The scoped database shows plain slugs.
    const parentIds = new Map((await all<{ id: number; slug: string }>(db, "SELECT id, slug FROM categories")).map((r) => [r.slug, r.id]));
    const children = DEFAULT_CATEGORIES.flatMap((c) =>
      (c.children ?? []).map((child, i) =>
        db
          .prepare("INSERT INTO categories (parent_id, slug, name, kind, icon, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)")
          .bind(parentIds.get(c.slug) ?? null, storedSlug(userId, child.slug), child.name, c.kind, child.icon, i, now),
      ),
    );
    if (children.length) await db.batch(children);
  }
  const cash = await first<{ id: number }>(db, "SELECT id FROM accounts WHERE type = 'cash' LIMIT 1");
  if (!cash) {
    await db
      .prepare("INSERT INTO accounts (name, type, currency, color, sort_order, created_at) VALUES ('Cash', 'cash', 'AZN', '#16a34a', 100, ?)")
      .bind(now)
      .run();
  }
  await setSetting(db, "seed_version", SEED_VERSION);
  seededInThisIsolate.add(userId);
}
