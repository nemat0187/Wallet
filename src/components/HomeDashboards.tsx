import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Widget } from "@shared/widgets";
import { get } from "../lib/api";
import { WidgetCard } from "./Widget";

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

/** Pinned dashboards on the Home screen. */
export function HomeDashboards({ today, monthStartDay }: { today: string; monthStartDay: number }) {
  const list = useDashboards();
  const pinned = (list.data ?? []).filter((d) => d.show_on_home && d.widgets.length > 0);
  return (
    <>
      {pinned.map((d) => (
        <section key={d.id} className="mt-8">
          <div className="mb-3 flex items-end justify-between gap-3 px-1">
            <h2 className="text-[17px] font-semibold tracking-tight">{d.name}</h2>
            <Link to={`/dashboards?d=${d.id}`} className="text-sm font-medium text-accent">
              Edit
            </Link>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {d.widgets.map((w) => (
              <WidgetCard key={w.id} widget={w} today={today} monthStartDay={monthStartDay} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
