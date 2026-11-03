import { describe, expect, it } from "vitest";
import { scopeSql } from "../worker/lib/scoped";

const U = 7;
const shadow = (t: string) => `${t} AS NOT MATERIALIZED (SELECT * FROM main.${t} WHERE user_id = ${U})`;

describe("scopeSql: reads", () => {
  it("shadows every per-user table named, including joins and subqueries", () => {
    const sql = scopeSql("SELECT t.*, m.name FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id WHERE t.category_id IN (SELECT id FROM categories WHERE parent_id = ?)", U);
    expect(sql.startsWith("WITH ")).toBe(true);
    for (const t of ["transactions", "merchants", "categories"]) expect(sql).toContain(shadow(t));
    expect(sql).toContain("SELECT t.*, m.name FROM transactions t");
  });

  it("merges into an existing WITH", () => {
    const sql = scopeSql("WITH a AS (SELECT 1) SELECT * FROM transactions", U);
    expect(sql).toBe(`WITH ${shadow("transactions")}, a AS (SELECT 1) SELECT * FROM transactions`);
  });

  it("leaves shared tables alone", () => {
    expect(scopeSql("SELECT * FROM fx_rates WHERE date = ?", U)).toBe("SELECT * FROM fx_rates WHERE date = ?");
    expect(scopeSql("SELECT value FROM settings WHERE key = ?", U)).toBe("SELECT value FROM settings WHERE key = ?");
  });

  it("ignores table names inside text", () => {
    expect(scopeSql("SELECT * FROM fx_rates WHERE currency = 'transactions'", U)).not.toContain("WITH");
  });
});

describe("scopeSql: writes", () => {
  it("adds user_id to inserts", () => {
    expect(scopeSql("INSERT INTO notes (title, body) VALUES (?, ?)", U)).toBe("INSERT INTO notes (user_id, title, body) VALUES (7, ?, ?)");
    expect(scopeSql("INSERT OR IGNORE INTO merchants (key, name) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", U)).toBe(
      "INSERT OR IGNORE INTO merchants (user_id, key, name) VALUES (7, ?, ?) ON CONFLICT(key) DO NOTHING",
    );
  });

  it("does not add it twice", () => {
    expect(scopeSql("INSERT INTO notes (user_id, title) VALUES (?, ?)", U)).toBe("INSERT INTO notes (user_id, title) VALUES (?, ?)");
  });

  it("shadows tables used in subqueries of an insert", () => {
    const sql = scopeSql("INSERT INTO budgets (category_id, amount) VALUES ((SELECT id FROM categories WHERE slug = ?), ?)", U);
    expect(sql).toContain(shadow("categories"));
    expect(sql).not.toContain(shadow("budgets"));
    expect(sql).toContain("INSERT INTO budgets (user_id, category_id, amount) VALUES (7, (SELECT id FROM categories");
  });

  it("restricts updates and deletes to the user's rows", () => {
    expect(scopeSql("UPDATE transactions SET note = ?, updated_at = ? WHERE id = ?", U)).toBe("UPDATE transactions SET note = ?, updated_at = ? WHERE user_id = 7 AND ( id = ?)");
    expect(scopeSql("DELETE FROM rules WHERE id = ?", U)).toBe("DELETE FROM rules WHERE user_id = 7 AND ( id = ?)");
    expect(scopeSql("UPDATE accounts SET archived = 1", U)).toBe("UPDATE accounts SET archived = 1 WHERE user_id = 7");
  });

  it("uses the top-level WHERE, not one inside a subquery", () => {
    const sql = scopeSql("UPDATE transactions SET pair_id = NULL WHERE pair_id IN (SELECT id FROM transactions WHERE kind = 'x') OR id = ?", U);
    expect(sql).toBe("UPDATE transactions SET pair_id = NULL WHERE user_id = 7 AND ( pair_id IN (SELECT id FROM transactions WHERE kind = 'x') OR id = ?)");
    const set = scopeSql("UPDATE transactions SET c = (SELECT id FROM categories WHERE slug = ?) WHERE id = ?", U);
    expect(set).toContain(shadow("categories"));
    expect(set).toContain("WHERE user_id = 7 AND ( id = ?)");
  });

  it("leaves writes to shared tables alone", () => {
    expect(scopeSql("INSERT INTO fx_rates (date, currency, rate) VALUES (?, ?, ?)", U)).toBe("INSERT INTO fx_rates (date, currency, rate) VALUES (?, ?, ?)");
    expect(scopeSql("DELETE FROM login_attempts WHERE key = ?", U)).toBe("DELETE FROM login_attempts WHERE key = ?");
  });
});

describe("scopeSql: refuses what it cannot make safe", () => {
  const refused = [
    "INSERT INTO notes (title) VALUES (?), (?)",
    "INSERT INTO notes (title) SELECT title FROM notes",
    "INSERT OR REPLACE INTO notes (id, title) VALUES (?, ?)",
    "REPLACE INTO notes (id) VALUES (1)",
    "SELECT 1; DELETE FROM notes",
    "DELETE FROM notes WHERE id = ? LIMIT 1",
    "UPDATE notes SET title = ? RETURNING id",
  ];
  for (const sql of refused) it(sql, () => expect(() => scopeSql(sql, U)).toThrow(/Unscoped query refused/));

  it("needs a real user id", () => {
    expect(() => scopeSql("SELECT 1", 0)).toThrow();
    expect(() => scopeSql("SELECT 1", 1.5)).toThrow();
  });
});
