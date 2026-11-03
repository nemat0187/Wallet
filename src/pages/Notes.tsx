import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ListChecks, Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import { del, get, post, put } from "../lib/api";
import { Button, Empty, ErrorNote, Sheet, Spinner, clsx, errorText, useToast } from "../lib/ui";
import { PageHeader } from "../components/Layout";

interface Note {
  id: number;
  title: string;
  body: string;
  pinned: boolean;
  color: string | null;
  updated_at: string;
}

const COLORS = ["#d97706", "#2563eb", "#16a34a", "#db2777", "#7c3aed"];
const CHECK = /^(\s*)- \[( |x|X)\] ?(.*)$/;

/** Flip the n-th checklist line of a note body. */
function toggleLine(text: string, lineIndex: number): string {
  return text
    .split("\n")
    .map((line, i) => {
      const m = line.match(CHECK);
      return i === lineIndex && m ? `${m[1]}- [${m[2] === " " ? "x" : " "}] ${m[3]}` : line;
    })
    .join("\n");
}

function useNotes() {
  return useQuery({ queryKey: ["notes"], queryFn: () => get<Note[]>("/notes") });
}

export default function Notes() {
  const notes = useNotes();
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Note | "new" | null>(null);

  const list = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (notes.data ?? []).filter((n) => !needle || n.title.toLowerCase().includes(needle) || n.body.toLowerCase().includes(needle));
  }, [notes.data, search]);

  const save = useMutation({
    mutationFn: (n: Note) => put(`/notes/${n.id}`, { title: n.title, body: n.body, pinned: n.pinned, color: n.color }),
    onMutate: (n) => qc.setQueryData<Note[]>(["notes"], (l) => l?.map((x) => (x.id === n.id ? n : x))),
    onError: (e) => {
      toast(errorText(e), "error");
      qc.invalidateQueries({ queryKey: ["notes"] });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["notes"] }),
  });

  if (notes.isLoading) return <Spinner />;
  return (
    <div>
      <PageHeader
        title="Notes"
        subtitle="Reminders, plans and lists: things to remember about your money"
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
            <Plus size={16} /> New note
          </Button>
        }
      />
      <ErrorNote error={notes.error} />
      {(notes.data?.length ?? 0) > 0 && (
        <div className="relative mt-4">
          <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <input className="field pl-10" placeholder="Search notes" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search notes" />
        </div>
      )}

      {list.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-line">
          <Empty
            title={search ? "No note matches" : "No notes yet"}
            action={!search && <Button variant="primary" onClick={() => setEditing("new")}>Write your first note</Button>}
          >
            {search ? "Try another word." : "Use notes for anything: what to pay this week, a purchase you're saving for, or a checklist for the end of the month."}
          </Empty>
        </div>
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {list.map((n) => (
            <li key={n.id}>
              <NoteCard note={n} onOpen={() => setEditing(n)} onChange={(body) => save.mutate({ ...n, body })} onPin={() => save.mutate({ ...n, pinned: !n.pinned })} />
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <NoteEditor
          key={editing === "new" ? "new" : editing.id}
          note={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function NoteCard({ note, onOpen, onChange, onPin }: { note: Note; onOpen: () => void; onChange: (body: string) => void; onPin: () => void }) {
  const lines = note.body.split("\n");
  const shown = lines.slice(0, 8);
  return (
    <article className="relative h-full rounded-2xl border border-line bg-surface" style={note.color ? { borderTopColor: note.color, borderTopWidth: 4 } : undefined}>
      <button className="block w-full rounded-2xl px-4 pb-3 pt-3.5 text-left hover:bg-surface-2" onClick={onOpen} aria-label={`Open note ${note.title || ""}`}>
        <span className="block truncate pr-8 font-semibold">{note.title || <span className="text-ink-3">Untitled</span>}</span>
        <span className="mt-1.5 block">
          {shown.map((line, i) => {
            const m = line.match(CHECK);
            if (!m) return line.trim() ? <span key={i} className="block truncate text-sm text-ink-2">{line}</span> : null;
            const done = m[2] !== " ";
            return (
              <span key={i} className="flex items-center gap-2 py-0.5 text-sm">
                <span
                  role="checkbox"
                  aria-checked={done}
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(toggleLine(note.body, i));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      onChange(toggleLine(note.body, i));
                    }
                  }}
                  className={clsx("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border", done ? "border-accent bg-accent text-accent-ink" : "border-ink-3")}
                >
                  {done && <Check size={12} strokeWidth={3} />}
                </span>
                <span className={clsx("truncate", done && "text-ink-3 line-through")}>{m[3]}</span>
              </span>
            );
          })}
          {lines.length > shown.length && <span className="block pt-1 text-[13px] text-ink-3">…</span>}
        </span>
      </button>
      <button onClick={onPin} className="absolute right-2 top-2 rounded-full p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={note.pinned ? "Unpin" : "Pin to top"}>
        {note.pinned ? <Pin size={16} className="text-accent" fill="currentColor" /> : <PinOff size={16} />}
      </button>
    </article>
  );
}

function NoteEditor({ note, onClose }: { note: Note | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(note?.title ?? "");
  const [text, setText] = useState(note?.body ?? "");
  const [pinned, setPinned] = useState(note?.pinned ?? false);
  const [color, setColor] = useState<string | null>(note?.color ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = title !== (note?.title ?? "") || text !== (note?.body ?? "") || pinned !== (note?.pinned ?? false) || color !== (note?.color ?? null);
  const empty = !title.trim() && !text.trim();

  const save = useMutation({
    mutationFn: () => {
      const payload = { title: title.trim(), body: text, pinned, color };
      return note ? put(`/notes/${note.id}`, payload) : post("/notes", payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notes"] });
      onClose();
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  const remove = useMutation({
    mutationFn: () => del(`/notes/${note!.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notes"] });
      toast("Note deleted");
      onClose();
    },
    onError: (e) => toast(errorText(e), "error"),
  });

  // Closing keeps your work: anything typed is saved.
  const close = () => {
    if (dirty && !empty) save.mutate();
    else onClose();
  };
  const addChecklist = () => {
    const el = area.current;
    const needsBreak = text.length > 0 && !text.endsWith("\n");
    setText(`${text}${needsBreak ? "\n" : ""}- [ ] `);
    setTimeout(() => el?.focus(), 0);
  };

  return (
    <Sheet
      open
      wide
      onClose={close}
      title={note ? "Note" : "New note"}
      footer={
        <div className="flex items-center gap-2">
          {note &&
            (confirmDelete ? (
              <>
                <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
                  Yes, delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)} aria-label="Delete note">
                <Trash2 size={16} />
              </Button>
            ))}
          <Button className="ml-auto" variant="primary" loading={save.isPending} disabled={empty} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <input className="field text-lg font-semibold" value={title} maxLength={120} placeholder="Title" onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        <textarea
          ref={area}
          className="field min-h-56 leading-relaxed"
          value={text}
          maxLength={20000}
          placeholder={"Write anything.\nStart a line with - [ ] to make a checklist."}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter on a checklist line starts the next item.
            if (e.key !== "Enter" || e.shiftKey) return;
            const el = e.currentTarget;
            const before = el.value.slice(0, el.selectionStart);
            const line = before.slice(before.lastIndexOf("\n") + 1);
            const m = line.match(CHECK);
            if (!m) return;
            e.preventDefault();
            if (!m[3].trim()) {
              // Enter on an empty item ends the list.
              const start = el.selectionStart - line.length;
              setText(el.value.slice(0, start) + el.value.slice(el.selectionEnd));
              return;
            }
            const insert = `\n${m[1]}- [ ] `;
            const pos = el.selectionStart + insert.length;
            setText(el.value.slice(0, el.selectionStart) + insert + el.value.slice(el.selectionEnd));
            setTimeout(() => el.setSelectionRange(pos, pos), 0);
          }}
          aria-label="Note"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={addChecklist}>
            <ListChecks size={16} /> Checklist item
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPinned(!pinned)} aria-pressed={pinned}>
            {pinned ? <Pin size={16} className="text-accent" fill="currentColor" /> : <PinOff size={16} />} {pinned ? "Pinned" : "Pin to top"}
          </Button>
          <span className="ml-auto flex items-center gap-1.5" role="radiogroup" aria-label="Colour">
            <button
              type="button"
              role="radio"
              aria-checked={color === null}
              aria-label="No colour"
              onClick={() => setColor(null)}
              className={clsx("h-6 w-6 rounded-full border border-line bg-surface", color === null && "ring-2 ring-accent ring-offset-2 ring-offset-surface")}
            />
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={`Colour ${c}`}
                onClick={() => setColor(c)}
                style={{ background: c }}
                className={clsx("h-6 w-6 rounded-full", color === c && "ring-2 ring-accent ring-offset-2 ring-offset-surface")}
              />
            ))}
          </span>
        </div>
      </div>
    </Sheet>
  );
}
