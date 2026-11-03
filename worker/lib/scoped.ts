// Per-user database access. A request for user N gets an Env whose DB can only see and change N's rows:
//
//  - SELECT (and subqueries anywhere): every per-user table named in the statement is shadowed by a CTE of the
//    same name that only contains the user's rows ("main." makes the CTE body read the real table).
//  - UPDATE / DELETE on a per-user table: "user_id = N AND (...)" is added to the top-level WHERE.
//  - INSERT into a per-user table: user_id is added to the column list and values.
//  - Anything it cannot make safe (several statements, INSERT ... SELECT, several VALUES rows, REPLACE) throws, so a
//    new query can never silently run unscoped.
//
// N is an integer taken from the signed-in session, so it is written into the SQL as a literal; this also keeps
// bound parameter numbering unchanged.

import type { Env } from "../env";

/** Tables whose rows belong to one user. */
export const PER_USER_TABLES = [
  "accounts",
  "categories",
  "merchants",
  "rules",
  "transactions",
  "raw_messages",
  "budgets",
  "range_budgets",
  "dashboards",
  "notes",
  "insights",
  "ai_usage",
  "api_tokens",
  "sessions",
  "notifications_sent",
  "goals",
] as const;
const PER_USER = new Set<string>(PER_USER_TABLES);
const TABLE_WORDS = new RegExp(`\\b(${PER_USER_TABLES.join("|")})\\b`, "gi");

/** Replace the inside of '...' and "..." with spaces (same length) so keywords in text are ignored. */
function maskQuotes(sql: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += " ";
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += " ";
          i++;
        } else quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += " ";
    } else out += ch;
  }
  return out;
}

/** Same as maskQuotes, and everything inside parentheses is masked too (only top-level text remains). */
function maskNested(sql: string): string {
  const q = maskQuotes(sql);
  let depth = 0;
  let out = "";
  for (const ch of q) {
    if (ch === "(") {
      out += depth === 0 ? "(" : " ";
      depth++;
    } else if (ch === ")") {
      depth--;
      out += depth === 0 ? ")" : " ";
    } else out += depth > 0 ? " " : ch;
  }
  return out;
}

/**
 * Columns of the two tables whose unique text column carries a per-user suffix for users other than the owner
 * (see worker/lib/userkeys.ts). The shadow table hands the app the plain value. tests/scoped.test.ts checks these
 * lists against the migrations so a new column cannot be forgotten.
 */
export const CATEGORY_COLUMNS = ["id", "parent_id", "slug", "name", "kind", "icon", "color", "sort_order", "archived", "created_at", "user_id"];
export const MERCHANT_COLUMNS = ["id", "key", "name", "category_id", "category_source", "ai_confidence", "created_at", "updated_at", "user_id"];

function plainColumn(column: string, userId: number): string {
  return userId === 1 ? column : `substr(${column}, 1, length(${column}) - ${String(userId).length + 1})`;
}

/** The SELECT that makes up a user's rows of one table. */
function userRows(table: string, userId: number): string {
  const columns = table === "categories" ? CATEGORY_COLUMNS : table === "merchants" ? MERCHANT_COLUMNS : null;
  const swap = table === "categories" ? "slug" : table === "merchants" ? "key" : null;
  if (!columns || !swap || userId === 1) return `SELECT * FROM main.${table} WHERE user_id = ${userId}`;
  const list = columns.map((c) => (c === swap ? `${plainColumn(c, userId)} AS ${c}` : c)).join(", ");
  return `SELECT ${list} FROM main.${table} WHERE user_id = ${userId}`;
}

function fail(reason: string, sql: string): never {
  throw new Error(`Unscoped query refused (${reason}): ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
}

export function scopeSql(sqlIn: string, userId: number): string {
  if (!Number.isInteger(userId) || userId < 1) throw new Error("scopeSql needs a valid user id");
  const sql = sqlIn.trim().replace(/;\s*$/, "");
  const q = maskQuotes(sql);
  if (q.includes(";")) fail("several statements", sql);
  const top = maskNested(sql);

  // What kind of statement is this, and which per-user table does it write to?
  const startsWithWith = /^\s*WITH\b/i.test(sql);
  const verb = (startsWithWith ? top.match(/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i)?.[1] : top.match(/^\s*(\w+)/)?.[1])?.toUpperCase() ?? "SELECT";
  if (verb === "REPLACE") fail("REPLACE", sql);
  if (/^\s*INSERT\s+OR\s+REPLACE\b/i.test(sql)) fail("INSERT OR REPLACE", sql);

  let target: string | null = null;
  let body = sql;

  if (verb === "INSERT") {
    const m = sql.match(/^(\s*INSERT(?:\s+OR\s+\w+)?\s+INTO\s+)(\w+)(\s*\()([^)]*)(\)\s*VALUES\s*\()/i);
    if (!m) {
      const t = sql.match(/INTO\s+(\w+)/i)?.[1]?.toLowerCase();
      if (t && !PER_USER.has(t)) {
        // not a per-user table; fall through to shadowing subqueries
      } else fail("INSERT form", sql);
    } else {
      const table = m[2].toLowerCase();
      if (PER_USER.has(table)) {
        target = table;
        const cols = m[4].split(",").map((c) => c.trim().toLowerCase());
        if (!cols.includes("user_id")) {
          // exactly one VALUES row
          let depth = 0;
          let i = m[0].length - 1;
          for (; i < q.length; i++) {
            if (q[i] === "(") depth++;
            else if (q[i] === ")" && --depth === 0) break;
          }
          if (/^\s*,/.test(q.slice(i + 1))) fail("several VALUES rows", sql);
          body = `${m[1]}${m[2]}${m[3]}user_id, ${m[4]}${m[5]}${userId}, ${sql.slice(m[0].length)}`;
        }
      }
    }
  } else if (verb === "UPDATE" || verb === "DELETE") {
    const m =
      verb === "UPDATE"
        ? top.match(/^\s*UPDATE\s+(?:OR\s+\w+\s+)?(\w+)/i)
        : top.match(/^\s*DELETE\s+FROM\s+(\w+)/i);
    const table = m?.[1]?.toLowerCase();
    if (!table && !startsWithWith) fail(`${verb} form`, sql);
    if (table && PER_USER.has(table)) {
      target = table;
      if (/\b(RETURNING|ORDER\s+BY|LIMIT)\b/i.test(top)) fail(`${verb} with RETURNING/ORDER/LIMIT`, sql);
      const w = top.search(/\bWHERE\b/i);
      body = w === -1 ? `${sql} WHERE user_id = ${userId}` : `${sql.slice(0, w)}WHERE user_id = ${userId} AND (${sql.slice(w + 5)})`;
    }
  }

  // Shadow every other per-user table the statement mentions.
  const mentioned = new Set<string>();
  for (const m of q.matchAll(TABLE_WORDS)) mentioned.add(m[1].toLowerCase());
  if (target) mentioned.delete(target);
  if (!mentioned.size) return body;
  const ctes = [...mentioned].map((t) => `${t} AS NOT MATERIALIZED (${userRows(t, userId)})`).join(", ");
  const withMatch = body.match(/^\s*WITH(\s+RECURSIVE)?\s+/i);
  return withMatch ? `WITH${withMatch[1] ?? ""} ${ctes}, ${body.slice(withMatch[0].length)}` : `WITH ${ctes} ${body}`;
}

/** A D1 database that only sees one user's rows. Implements the parts of D1Database the app uses. */
export class ScopedD1 {
  constructor(
    readonly raw: D1Database,
    readonly userId: number,
  ) {}
  prepare(sql: string): D1PreparedStatement {
    return this.raw.prepare(scopeSql(sql, this.userId));
  }
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return this.raw.batch<T>(statements);
  }
  exec(): never {
    throw new Error("exec() is not available on a per-user database");
  }
  dump(): never {
    throw new Error("dump() is not available on a per-user database");
  }
}

/** The same Env, but its DB is limited to this user. Safe to call on an already scoped Env. */
export function forUser(env: Env, userId: number): Env {
  const raw = rawDb(env);
  return { ...env, DB: new ScopedD1(raw, userId) as unknown as D1Database, userId };
}

/** The unrestricted database: only for login, sessions, background jobs that loop over users, and shared data. */
export function rawDb(env: Env): D1Database {
  const db = env.DB as unknown as ScopedD1;
  return db instanceof ScopedD1 ? db.raw : env.DB;
}

/** The user a (scoped) database belongs to; throws for the unrestricted database. */
export function userIdOfDb(db: D1Database): number {
  if (db instanceof ScopedD1) return db.userId;
  throw new Error("This code needs a per-user database (use forUser)");
}

/** The user an Env is scoped to. */
export function userIdOf(env: Env): number {
  if (!env.userId) throw new Error("This code needs a per-user Env (use forUser)");
  return env.userId;
}
