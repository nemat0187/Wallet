import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, ChevronRight, Archive } from "lucide-react";
import type { Category, CategoryKind } from "@shared/types";
import { del, get, patch, post } from "../lib/api";
import { useRefresh } from "../lib/data";
import { Button, ErrorNote, Label, Segmented, Sheet, Spinner, Toggle, clsx, useToast } from "../lib/ui";
import { PageHeader } from "../components/Layout";
import { CategoryPicker } from "../components/CategoryPicker";

type Row = Category & { tx_count: number };
const EMOJI = ["🛒", "🍽️", "☕", "🚕", "🏠", "💡", "🛍️", "💊", "🎬", "🎁", "✈️", "🎓", "🐾", "💼", "📱", "🧾", "🎮", "🏋️", "💄", "🧸", "⛽", "🍷", "💨", "🕌", "🚬", "📌"];
const COLORS = ["#16a34a", "#ea580c", "#2563eb", "#7c3aed", "#ca8a04", "#db2777", "#dc2626", "#0d9488", "#4f46e5", "#0891b2", "#475569", "#a16207"];

export default function Categories() {
  const [kind, setKind] = useState<CategoryKind>("expense");
  const q = useQuery({ queryKey: ["categories-full"], queryFn: () => get<Row[]>("/categories") });
  const [editing, setEditing] = useState<Partial<Row> | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  if (!q.data) return <Spinner />;
  const parents = q.data.filter((c) => c.parent_id === null && c.kind === kind && (showArchived || !c.archived));
  const children = (id: number) => q.data.filter((c) => c.parent_id === id && (showArchived || !c.archived));

  return (
    <div>
      <PageHeader
        title="Categories"
        subtitle="Rename, add or hide categories. Changes apply everywhere."
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing({ kind, parent_id: null })}>
            <Plus size={16} /> New
          </Button>
        }
      />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "expense", label: "Spending" },
            { value: "income", label: "Income" },
            { value: "transfer", label: "Transfers" },
          ]}
        />
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show hidden
        </label>
      </div>
      <div className="mt-5 flex flex-col gap-3">
        {parents.map((p) => (
          <div key={p.id} className="overflow-hidden rounded-2xl border border-line bg-surface">
            <CatRow c={p} strong onClick={() => setEditing(p)} />
            {children(p.id).map((c) => (
              <CatRow key={c.id} c={c} onClick={() => setEditing(c)} />
            ))}
            <button
              onClick={() => setEditing({ kind, parent_id: p.id })}
              className="flex w-full items-center gap-2 border-t border-line px-4 py-2.5 pl-12 text-sm font-medium text-accent hover:bg-surface-2"
            >
              <Plus size={15} /> Add subcategory
            </button>
          </div>
        ))}
      </div>
      <Editor editing={editing} all={q.data} onClose={() => setEditing(null)} />
    </div>
  );
}

function CatRow({ c, strong, onClick }: { c: Row; strong?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={clsx("flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2", !strong && "border-t border-line pl-12")}>
      <span className="flex h-8 w-8 items-center justify-center rounded-full text-lg" style={{ background: strong ? `${c.color ?? "#94a3b8"}24` : undefined }} aria-hidden>
        {c.icon}
      </span>
      <span className={clsx("flex-1", strong ? "font-semibold" : "text-ink-2", c.archived && "line-through opacity-60")}>{c.name}</span>
      {c.archived ? <Archive size={14} className="text-ink-3" aria-label="Hidden" /> : null}
      <span className="text-[13px] text-ink-3 num">{c.tx_count || ""}</span>
      <ChevronRight size={16} className="text-ink-3" aria-hidden />
    </button>
  );
}

function Editor({ editing, all, onClose }: { editing: Partial<Row> | null; all: Row[]; onClose: () => void }) {
  return (
    <Sheet open={Boolean(editing)} onClose={onClose} title={editing?.id ? "Edit category" : editing?.parent_id ? "New subcategory" : "New category"}>
      {editing && <EditorForm key={editing.id ?? "new"} editing={editing} all={all} onClose={onClose} />}
    </Sheet>
  );
}

function EditorForm({ editing, all, onClose }: { editing: Partial<Row>; all: Row[]; onClose: () => void }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [name, setName] = useState(editing.name ?? "");
  const [icon, setIcon] = useState(editing.icon ?? "📌");
  const [color, setColor] = useState(editing.color ?? COLORS[0]);
  const [archived, setArchived] = useState(Boolean(editing.archived));
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState<number | null>(null);
  const parent = editing.parent_id ? all.find((c) => c.id === editing.parent_id) : null;
  const isParent = !editing.parent_id;

  const save = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error("Give the category a name");
      const body = { name: name.trim(), icon, color: isParent ? color : null, archived };
      return editing.id ? patch(`/categories/${editing.id}`, body) : post("/categories", { ...body, parent_id: editing.parent_id ?? null, kind: editing.kind });
    },
    onSuccess: () => {
      toast(editing.id ? "Category saved" : "Category added");
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/categories/${editing.id}${moveTo ? `?reassign_to=${moveTo}` : ""}`),
    onSuccess: () => {
      toast("Category deleted");
      refresh();
      onClose();
    },
  });

  return (
    <div className="flex flex-col gap-4">
      {parent && <p className="text-sm text-ink-2">Inside {parent.icon} {parent.name}</p>}
      <label className="block">
        <Label>Name</Label>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hookah" />
      </label>
      <div>
        <Label>Icon</Label>
        <div className="flex flex-wrap gap-1.5">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setIcon(e)}
              className={clsx("h-10 w-10 rounded-xl text-xl", icon === e ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2 hover:bg-line")}
              aria-label={`Use ${e}`}
            >
              {e}
            </button>
          ))}
          <input className="field h-10 w-20 text-center text-xl" value={icon} onChange={(e) => setIcon(e.target.value.slice(0, 4))} aria-label="Custom emoji" />
        </div>
      </div>
      {isParent && (
        <div>
          <Label>Colour</Label>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={clsx("h-8 w-8 rounded-full", color === c && "ring-2 ring-ink ring-offset-2 ring-offset-surface")}
                style={{ background: c }}
                aria-label={`Colour ${c}`}
              />
            ))}
          </div>
        </div>
      )}
      {editing.id && <Toggle checked={archived} onChange={setArchived} label="Hide this category" hint="Hidden categories keep their history but can't be picked for new transactions." />}
      <ErrorNote error={save.error ?? remove.error} />
      <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
        {editing.id ? "Save category" : "Add category"}
      </Button>
      {editing.id && editing.slug !== "uncategorized" && (
        <div className="border-t border-line pt-4">
          {!deleting ? (
            <Button variant="danger" className="w-full" onClick={() => setDeleting(true)}>
              Delete category…
            </Button>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-ink-2">
                {editing.tx_count ? `Move its ${editing.tx_count} transactions (and those of its subcategories) to:` : "Pick where any future matches should go:"}
              </p>
              <CategoryPicker value={moveTo} onChange={setMoveTo} kinds={editing.kind ? [editing.kind] : undefined} />
              <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
                Delete {name}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
