import { useQuery } from "@tanstack/react-query";
import type { Widget } from "@shared/widgets";
import { get } from "./api";

export interface Dashboard {
  id: number;
  name: string;
  widgets: Widget[];
  show_on_home: boolean;
  sort_order: number;
}

export function useDashboards() {
  return useQuery({ queryKey: ["dashboards"], queryFn: () => get<Dashboard[]>("/dashboards"), staleTime: 60_000 });
}
