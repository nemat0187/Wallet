// Shared queries and lookup helpers.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Account, Category, Settings } from "@shared/types";
import { get } from "./api";

export interface Bootstrap {
  settings: Settings;
  categories: Category[];
  accounts: Account[];
  counts: { review: number; failed: number; tokens: number; transactions: number };
  origin: string;
}

export function useBootstrap() {
  return useQuery({ queryKey: ["bootstrap"], queryFn: () => get<Bootstrap>("/bootstrap"), staleTime: 60_000 });
}

export interface CategoryInfo {
  id: number;
  name: string;
  icon: string;
  color: string;
  kind: Category["kind"];
  parent: Category | null;
  path: string;
}

/** Category lookups (with inherited parent colour) derived from bootstrap data. */
export function useCategories() {
  const { data } = useBootstrap();
  return useMemo(() => {
    const list = data?.categories ?? [];
    const byId = new Map(list.map((c) => [c.id, c]));
    const info = (id: number | null | undefined): CategoryInfo | null => {
      if (!id) return null;
      const c = byId.get(id);
      if (!c) return null;
      const parent = c.parent_id ? (byId.get(c.parent_id) ?? null) : null;
      return {
        id: c.id,
        name: c.name,
        icon: c.icon ?? parent?.icon ?? "•",
        color: c.color ?? parent?.color ?? "#94a3b8",
        kind: c.kind,
        parent,
        path: parent ? `${parent.name} › ${c.name}` : c.name,
      };
    };
    const parents = list.filter((c) => c.parent_id === null);
    const childrenOf = (id: number) => list.filter((c) => c.parent_id === id);
    return { list, byId, info, parents, childrenOf };
  }, [data]);
}

export function useAccounts() {
  const { data } = useBootstrap();
  return useMemo(() => {
    const list = data?.accounts ?? [];
    return { list, active: list.filter((a) => !a.archived), byId: new Map(list.map((a) => [a.id, a])) };
  }, [data]);
}

/** Invalidate everything derived from transactions after a change. */
export function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}
