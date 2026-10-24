/** Flatten the parent/child breakdown returned by /analytics/categories into a lookup by category id. */
export function rollupSpending(rows: { category_id: number; spent: number; children: { category_id: number; spent: number }[] }[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const r of rows) {
    map.set(r.category_id, r.spent);
    for (const c of r.children) map.set(c.category_id, c.spent);
  }
  return map;
}
