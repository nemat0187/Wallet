// The Home screen layout: which blocks show, in which column and order.

import type { Widget } from "./widgets";

export const HOME_BLOCKS = ["hero", "attention", "where", "latest", "cards", "budgets", "coach", "places"] as const;
export type HomeBlockId = (typeof HOME_BLOCKS)[number];

export type HomeColumn = "main" | "aside" | "wide";

export interface HomeItem {
  /** A built-in block id, "dash:<dashboardId>" for a pinned dashboard, or "w:<widgetId>" for a widget made on Home. */
  id: string;
  col: HomeColumn;
  hidden?: boolean;
  /** Only for "w:" items. */
  widget?: Widget;
}

export const HOME_BLOCK_LABELS: Record<HomeBlockId, string> = {
  hero: "Overview",
  attention: "Things to check",
  where: "Where it went",
  latest: "Latest transactions",
  cards: "Cards",
  budgets: "Budgets",
  coach: "AI coach",
  places: "Top places",
};

const DEFAULT_COLUMN: Record<HomeBlockId, HomeColumn> = {
  hero: "main",
  attention: "main",
  where: "main",
  latest: "main",
  cards: "aside",
  budgets: "aside",
  coach: "aside",
  places: "aside",
};

export const defaultHomeLayout = (): HomeItem[] => HOME_BLOCKS.map((id) => ({ id, col: DEFAULT_COLUMN[id] }));

/**
 * Bring a saved layout in line with what exists today: built-in blocks that are missing are added back, pinned
 * dashboards appear (full width) and ones that were unpinned or deleted are dropped.
 */
export function resolveHomeLayout(saved: HomeItem[] | null | undefined, pinnedDashboardIds: number[]): HomeItem[] {
  const pinned = new Set(pinnedDashboardIds.map((id) => `dash:${id}`));
  const builtins = new Set<string>(HOME_BLOCKS);
  const out: HomeItem[] = [];
  const seen = new Set<string>();
  for (const item of saved?.length ? saved : defaultHomeLayout()) {
    if (seen.has(item.id)) continue;
    const keep = builtins.has(item.id) || pinned.has(item.id) || (item.id.startsWith("w:") && item.widget);
    if (!keep) continue;
    seen.add(item.id);
    out.push(item);
  }
  for (const id of HOME_BLOCKS) if (!seen.has(id)) out.push({ id, col: DEFAULT_COLUMN[id] });
  for (const id of pinned) if (!seen.has(id)) out.push({ id, col: "wide" });
  return out;
}

/** Move an item up or down among the items of its own column. */
export function moveInColumn(items: HomeItem[], id: string, delta: -1 | 1): HomeItem[] {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return items;
  let j = i + delta;
  while (j >= 0 && j < items.length && items[j].col !== items[i].col) j += delta;
  if (j < 0 || j >= items.length) return items;
  const next = [...items];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
