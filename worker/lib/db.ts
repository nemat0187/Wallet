// Thin helpers over the D1 API.

export type SqlValue = string | number | null;

export async function all<T>(db: D1Database, sql: string, ...params: SqlValue[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

export async function first<T>(db: D1Database, sql: string, ...params: SqlValue[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...params: SqlValue[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

export async function insert(db: D1Database, sql: string, ...params: SqlValue[]): Promise<number> {
  const res = await db.prepare(sql).bind(...params).run();
  return Number(res.meta.last_row_id);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Build "?, ?, ?" for IN clauses. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}
