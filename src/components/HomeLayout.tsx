// The Home screen as a customizable grid: built-in blocks, pinned dashboards and widgets made right on Home.
// Order, column and visibility are stored in the `home_layout` setting.

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { HOME_BLOCK_LABELS, moveInColumn, resolveHomeLayout, type HomeBlockId, type HomeColumn, type HomeItem } from "@shared/home";
import type { Widget } from "@shared/widgets";
import { patch } from "../lib/api";
import { useBootstrap, type Bootstrap } from "../lib/data";
import { blankWidget } from "../lib/templates";
import { Button, clsx, errorText, useToast } from "../lib/ui";
import { useDashboards } from "../lib/dashboards";
import { WidgetCard } from "./Widget";
import { WidgetEditor } from "./WidgetEditor";

/** The resolved layout plus a saver that updates the screen right away. */
export function useHomeLayout() {
  const boot = useBootstrap();
  const dashboards = useDashboards();
  const qc = useQueryClient();
  const toast = useToast();
  const pinned = (dashboards.data ?? []).filter((d) => d.show_on_home && d.widgets.length > 0);
  const items = resolveHomeLayout(boot.data?.settings.home_layout, pinned.map((d) => d.id));
  const save = useMutation({
    mutationFn: (next: HomeItem[] | null) => patch("/settings", { home_layout: next }),
    onMutate: (next) => {
      const prev = qc.getQueryData<Bootstrap>(["bootstrap"]);
      qc.setQueryData<Bootstrap>(["bootstrap"], (b) => (b ? { ...b, settings: { ...b.settings, home_layout: next } } : b));
      return { prev };
    },
    onError: (e, _next, ctx) => {
      if (ctx?.prev) qc.setQueryData(["bootstrap"], ctx.prev);
      toast(errorText(e), "error");
    },
  });
  return { items, pinned, setItems: (next: HomeItem[] | null) => save.mutate(next) };
}

const COLUMN_LABEL: Record<HomeColumn, string> = { main: "Main", aside: "Side", wide: "Full width" };

export function HomeGrid({
  blocks,
  today,
  monthStartDay,
  editing,
  onDone,
}: {
  blocks: Record<HomeBlockId, ReactNode | null>;
  today: string;
  monthStartDay: number;
  editing: boolean;
  onDone: () => void;
}) {
  const { items, pinned, setItems } = useHomeLayout();
  const [editor, setEditor] = useState<{ widget: Widget; isNew: boolean } | null>(null);

  const update = (id: string, patchItem: Partial<HomeItem>) => setItems(items.map((i) => (i.id === id ? { ...i, ...patchItem } : i)));
  const labelOf = (i: HomeItem) =>
    i.widget ? i.widget.title || "Widget" : i.id.startsWith("dash:") ? (pinned.find((d) => `dash:${d.id}` === i.id)?.name ?? "Dashboard") : HOME_BLOCK_LABELS[i.id as HomeBlockId];

  const contentOf = (i: HomeItem): ReactNode => {
    if (i.widget) return <WidgetCard widget={i.widget} today={today} monthStartDay={monthStartDay} />;
    if (i.id.startsWith("dash:")) {
      const d = pinned.find((x) => `dash:${x.id}` === i.id);
      if (!d) return null;
      return (
        <section>
          <div className="mb-3 flex items-end justify-between gap-3 px-1">
            <h2 className="text-[17px] font-semibold tracking-tight">{d.name}</h2>
            {!editing && (
              <Link to={`/dashboards?d=${d.id}`} className="text-sm font-medium text-accent">
                Edit
              </Link>
            )}
          </div>
          <div className={clsx("grid gap-4", i.col === "wide" && "md:grid-cols-2")}>
            {d.widgets.map((w) => (
              <WidgetCard key={w.id} widget={i.col === "wide" ? w : { ...w, size: "half" }} today={today} monthStartDay={monthStartDay} />
            ))}
          </div>
        </section>
      );
    }
    return blocks[i.id as HomeBlockId];
  };

  const renderItem = (i: HomeItem, position: { first: boolean; last: boolean }) => {
    const content = contentOf(i);
    if (!editing) return content && !i.hidden ? <div key={i.id} className="min-w-0">{content}</div> : null;
    return (
      <div key={i.id} className={clsx("min-w-0 overflow-hidden rounded-2xl border-2 border-dashed border-accent/40", i.hidden && "bg-surface-2/50")}>
        <div className="flex flex-wrap items-center gap-1 bg-accent-soft px-2 py-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate px-1 font-medium">{labelOf(i)}</span>
          <select
            className="h-8 rounded-lg border border-line bg-surface px-1.5 text-[13px]"
            value={i.col}
            onChange={(e) => update(i.id, { col: e.target.value as HomeColumn })}
            aria-label={`Where ${labelOf(i)} goes`}
          >
            {(Object.keys(COLUMN_LABEL) as HomeColumn[]).map((c) => (
              <option key={c} value={c}>
                {COLUMN_LABEL[c]}
              </option>
            ))}
          </select>
          <IconButton label="Move up" disabled={position.first} onClick={() => setItems(moveInColumn(items, i.id, -1))}>
            <ArrowUp size={16} />
          </IconButton>
          <IconButton label="Move down" disabled={position.last} onClick={() => setItems(moveInColumn(items, i.id, 1))}>
            <ArrowDown size={16} />
          </IconButton>
          <IconButton label={i.hidden ? "Show" : "Hide"} onClick={() => update(i.id, { hidden: !i.hidden })}>
            {i.hidden ? <EyeOff size={16} /> : <Eye size={16} />}
          </IconButton>
          {i.widget && (
            <>
              <IconButton label="Edit widget" onClick={() => setEditor({ widget: i.widget!, isNew: false })}>
                <Pencil size={16} />
              </IconButton>
              <IconButton label="Delete widget" onClick={() => setItems(items.filter((x) => x.id !== i.id))}>
                <Trash2 size={16} />
              </IconButton>
            </>
          )}
        </div>
        <div className={clsx("p-2", i.hidden && "pointer-events-none opacity-40")} aria-hidden={i.hidden}>
          {content ?? <p className="px-2 py-6 text-center text-sm text-ink-3">Nothing to show here right now.</p>}
        </div>
      </div>
    );
  };

  const column = (col: HomeColumn) => {
    const list = items.filter((i) => i.col === col);
    return list.map((i, n) => renderItem(i, { first: n === 0, last: n === list.length - 1 }));
  };
  const main = column("main");
  const aside = column("aside");
  const wide = column("wide");

  return (
    <>
      {editing && (
        <div className="sticky top-0 z-30 -mx-4 mb-3 flex flex-wrap items-center gap-2 border-b border-line bg-paper/95 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
          <p className="w-full text-sm text-ink-2 sm:min-w-0 sm:flex-1">
            <strong className="font-semibold text-ink">Customizing Home.</strong> Move, hide or add blocks. Changes save as you go.
          </p>
          <Button size="sm" onClick={() => setEditor({ widget: blankWidget(), isNew: true })}>
            <Plus size={16} /> Add widget
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.confirm("Put Home back to the original layout? Widgets you added here will be removed.") && setItems(null)}>
            <RotateCcw size={16} /> Reset
          </Button>
          <Button size="sm" variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      )}

      <div className="mt-2 grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6 empty:hidden">{main}</div>
        <aside className="flex min-w-0 flex-col gap-6 empty:hidden">{aside}</aside>
      </div>
      {wide.some(Boolean) && <div className="mt-6 flex flex-col gap-6">{wide}</div>}
      {editing && main.length + aside.length + wide.length === 0 && <p className="py-10 text-center text-ink-3">Everything is hidden. Use Reset to start over.</p>}

      {editor && (
        <WidgetEditor
          widget={editor.widget}
          isNew={editor.isNew}
          today={today}
          monthStartDay={monthStartDay}
          onClose={() => setEditor(null)}
          onDelete={() => {
            setItems(items.filter((x) => x.id !== `w:${editor.widget.id}`));
            setEditor(null);
          }}
          onSave={(w) => {
            const id = `w:${w.id}`;
            setItems(editor.isNew ? [...items, { id, col: "main", widget: w }] : items.map((x) => (x.id === id ? { ...x, widget: w } : x)));
            setEditor(null);
          }}
        />
      )}
    </>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-lg p-1.5 text-ink-2 hover:bg-surface hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

