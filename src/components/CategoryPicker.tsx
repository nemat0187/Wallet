import { useMemo, useState } from "react";
import { Search, Check } from "lucide-react";
import type { CategoryKind } from "@shared/types";
import { clsx } from "../lib/ui";
import { useCategories } from "../lib/data";

/** Searchable, grouped category list. */
export function CategoryPicker({
  value,
  onChange,
  kinds,
  allowParents = true,
}: {
  value: number | null;
  onChange: (id: number) => void;
  kinds?: CategoryKind[];
  allowParents?: boolean;
}) {
  const cats = useCategories();
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cats.parents
      .filter((p) => !p.archived && (!kinds || kinds.includes(p.kind)))
      .map((p) => {
        const children = cats.childrenOf(p.id).filter((c) => !c.archived);
        const parentHit = !needle || p.name.toLowerCase().includes(needle);
        const kids = children.filter((c) => parentHit || c.name.toLowerCase().includes(needle));
        return { parent: p, children: kids, show: parentHit || kids.length > 0 };
      })
      .filter((g) => g.show);
  }, [cats, q, kinds]);

  return (
    <div className="rounded-2xl border border-line">
      <div className="relative border-b border-line">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search categories"
          className="h-11 w-full rounded-t-2xl bg-transparent pl-9 pr-3 outline-none"
          aria-label="Search categories"
        />
      </div>
      <div className="max-h-72 overflow-y-auto p-1.5" role="listbox">
        {groups.map(({ parent, children }) => (
          <div key={parent.id} className="py-0.5">
            <Option
              icon={parent.icon}
              label={parent.name}
              selected={value === parent.id}
              disabled={!allowParents && children.length > 0}
              strong
              onClick={() => onChange(parent.id)}
            />
            {children.map((c) => (
              <Option key={c.id} icon={c.icon} label={c.name} selected={value === c.id} indent onClick={() => onChange(c.id)} />
            ))}
          </div>
        ))}
        {groups.length === 0 && <p className="px-3 py-4 text-sm text-ink-3">No category matches “{q}”. You can add one on the Categories page.</p>}
      </div>
    </div>
  );
}

function Option({
  icon,
  label,
  selected,
  indent,
  strong,
  disabled,
  onClick,
}: {
  icon: string | null;
  label: string;
  selected: boolean;
  indent?: boolean;
  strong?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors disabled:cursor-default",
        indent && "pl-8",
        selected ? "bg-accent-soft" : "hover:bg-surface-2 disabled:hover:bg-transparent",
        strong ? "font-medium" : "text-ink-2",
      )}
    >
      <span className="w-5 text-center" aria-hidden>
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {selected && <Check size={16} className="text-accent" aria-hidden />}
    </button>
  );
}
