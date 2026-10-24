// First-run setup: default categories and a cash wallet.

import { DEFAULT_CATEGORIES } from "@shared/categories";
import { first, nowIso } from "../lib/db";
import { getSetting, setSetting } from "./settings";

const SEED_VERSION = "1";
let seededInThisIsolate = false;

export async function ensureSeeded(db: D1Database): Promise<void> {
  if (seededInThisIsolate) return;
  if ((await getSetting(db, "seed_version")) === SEED_VERSION) {
    seededInThisIsolate = true;
    return;
  }
  const existing = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM categories");
  const now = nowIso();
  if (!existing?.n) {
    // Parents first (one batch), then children referencing parent ids by slug.
    const parents = DEFAULT_CATEGORIES.map((c, i) =>
      db
        .prepare(
          "INSERT INTO categories (parent_id, slug, name, kind, icon, color, sort_order, created_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(c.slug, c.name, c.kind, c.icon, c.color ?? null, i, now),
    );
    await db.batch(parents);
    const children = DEFAULT_CATEGORIES.flatMap((c) =>
      (c.children ?? []).map((child, i) =>
        db
          .prepare(
            `INSERT INTO categories (parent_id, slug, name, kind, icon, color, sort_order, created_at)
             SELECT id, ?, ?, ?, ?, NULL, ?, ? FROM categories WHERE slug = ?`,
          )
          .bind(child.slug, child.name, c.kind, child.icon, i, now, c.slug),
      ),
    );
    if (children.length) await db.batch(children);
  }
  const cash = await first<{ id: number }>(db, "SELECT id FROM accounts WHERE type = 'cash' LIMIT 1");
  if (!cash) {
    await db
      .prepare(
        "INSERT INTO accounts (name, type, currency, color, sort_order, created_at) VALUES ('Cash', 'cash', 'AZN', '#16a34a', 100, ?)",
      )
      .bind(now)
      .run();
  }
  await setSetting(db, "seed_version", SEED_VERSION);
  seededInThisIsolate = true;
}
