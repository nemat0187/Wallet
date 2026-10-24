import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Copy, LayoutGrid, Maximize2, Minimize2, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { localDate } from "@shared/money";
import { newWidgetId, type Widget } from "@shared/widgets";
import { del, post, put } from "../lib/api";
import { useBootstrap } from "../lib/data";
import { TEMPLATES, blankWidget } from "../lib/templates";
import { Button, Chip, Empty, ErrorNote, Label, Sheet, Spinner, Toggle, clsx, errorText, useToast } from "../lib/ui";
import { PageHeader } from "../components/Layout";
import { WidgetCard } from "../components/Widget";
import { WidgetEditor } from "../components/WidgetEditor";
import { useDashboards, type Dashboard } from "../components/HomeDashboards";

/** Save a dashboard, updating the cached list right away so the screen never waits. */
function useSaveDashboard() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (d: Dashboard) => put(`/dashboards/${d.id}`, { name: d.name, widgets: d.widgets, show_on_home: d.show_on_home }),
    onMutate: (d) => {
      const prev = qc.getQueryData<Dashboard[]>(["dashboards"]);
      qc.setQueryData<Dashboard[]>(["dashboards"], (list) => list?.map((x) => (x.id === d.id ? d : x)));
      return { prev };
    },
    onError: (e, _d, ctx) => {
      qc.setQueryData(["dashboards"], ctx?.prev);
      toast(errorText(e), "error");
    },
  });
}

export default function Dashboards() {
  const boot = useBootstrap();
  const settings = boot.data?.settings;
  const today = localDate(new Date(), settings?.tz_offset_minutes ?? 240);
  const monthStartDay = settings?.month_start_day ?? 1;
  const list = useDashboards();
  const save = useSaveDashboard();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [editingDash, setEditingDash] = useState(false);
  const [editor, setEditor] = useState<{ widget: Widget; isNew: boolean } | null>(null);
  const [menuFor, setMenuFor] = useState<Widget | null>(null);

  const dashboards = list.data ?? [];
  const current = dashboards.find((d) => String(d.id) === params.get("d")) ?? dashboards[0];
  const select = (id: number) => setParams({ d: String(id) }, { replace: true });

  if (list.isLoading || !settings) return <Spinner />;

  const setWidgets = (widgets: Widget[]) => current && save.mutate({ ...current, widgets });
  const index = menuFor && current ? current.widgets.findIndex((w) => w.id === menuFor.id) : -1;
  const move = (delta: number) => {
    if (!current || index < 0) return;
    const ws = [...current.widgets];
    const [item] = ws.splice(index, 1);
    ws.splice(Math.max(0, Math.min(ws.length, index + delta)), 0, item);
    setWidgets(ws);
    setMenuFor(null);
  };

  return (
    <div>
      <PageHeader
        title="Dashboards"
        subtitle="Your own views: pick what to measure, the period and the chart"
        actions={
          dashboards.length > 0 && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus size={16} /> New dashboard
            </Button>
          )
        }
      />
      <ErrorNote error={list.error} />

      {dashboards.length === 0 ? (
        <div className="mt-6">
          <p className="mb-3 px-1 text-ink-2">Start from a ready-made dashboard. You can change every widget afterwards.</p>
          <TemplatePicker onCreated={(id) => select(id)} />
        </div>
      ) : (
        current && (
          <>
            <div className="scroll-x -mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1">
              {dashboards.map((d) => (
                <Chip key={d.id} active={d.id === current.id} onClick={() => select(d.id)}>
                  {d.name}
                  {d.show_on_home && <span className="ml-1.5 text-[12px] text-ink-3">· Home</span>}
                </Chip>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[19px] font-semibold tracking-tight">{current.name}</h2>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditingDash(true)}>
                  <Settings2 size={16} /> Dashboard settings
                </Button>
                <Button size="sm" variant="primary" onClick={() => setEditor({ widget: blankWidget(), isNew: true })}>
                  <Plus size={16} /> Add widget
                </Button>
              </div>
            </div>

            {current.widgets.length === 0 ? (
              <div className="mt-4 rounded-2xl border border-dashed border-line">
                <Empty title="No widgets yet" action={<Button variant="primary" onClick={() => setEditor({ widget: blankWidget(), isNew: true })}>Add your first widget</Button>}>
                  A widget is one number, chart or table. For example “Taxi spending by month” or “Money out per card”.
                </Empty>
              </div>
            ) : (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {current.widgets.map((w) => (
                  <WidgetCard key={w.id} widget={w} today={today} monthStartDay={monthStartDay} onMenu={() => setMenuFor(w)} />
                ))}
              </div>
            )}
          </>
        )
      )}

      {/* Widget actions */}
      <Sheet open={Boolean(menuFor)} onClose={() => setMenuFor(null)} title={menuFor?.title || "Widget"}>
        {menuFor && current && (
          <div className="flex flex-col">
            <MenuItem
              icon={Pencil}
              onClick={() => {
                setEditor({ widget: menuFor, isNew: false });
                setMenuFor(null);
              }}
            >
              Edit
            </MenuItem>
            <MenuItem icon={ArrowUp} disabled={index <= 0} onClick={() => move(-1)}>
              Move up
            </MenuItem>
            <MenuItem icon={ArrowDown} disabled={index >= current.widgets.length - 1} onClick={() => move(1)}>
              Move down
            </MenuItem>
            <MenuItem
              icon={menuFor.size === "full" ? Minimize2 : Maximize2}
              onClick={() => {
                setWidgets(current.widgets.map((w) => (w.id === menuFor.id ? { ...w, size: w.size === "full" ? "half" : "full" } : w)));
                setMenuFor(null);
              }}
            >
              {menuFor.size === "full" ? "Make half width" : "Make full width"}
            </MenuItem>
            <MenuItem
              icon={Copy}
              onClick={() => {
                const ws = [...current.widgets];
                ws.splice(index + 1, 0, { ...menuFor, id: newWidgetId(), title: `${menuFor.title} (copy)` });
                setWidgets(ws);
                setMenuFor(null);
              }}
            >
              Duplicate
            </MenuItem>
            <MenuItem
              icon={Trash2}
              danger
              onClick={() => {
                setWidgets(current.widgets.filter((w) => w.id !== menuFor.id));
                setMenuFor(null);
              }}
            >
              Delete widget
            </MenuItem>
          </div>
        )}
      </Sheet>

      {editor && current && (
        <WidgetEditor
          widget={editor.widget}
          isNew={editor.isNew}
          today={today}
          monthStartDay={monthStartDay}
          onClose={() => setEditor(null)}
          onDelete={() => {
            setWidgets(current.widgets.filter((w) => w.id !== editor.widget.id));
            setEditor(null);
          }}
          onSave={(w) => {
            setWidgets(editor.isNew ? [...current.widgets, w] : current.widgets.map((x) => (x.id === w.id ? w : x)));
            setEditor(null);
          }}
        />
      )}

      <Sheet open={creating} onClose={() => setCreating(false)} title="New dashboard" wide>
        <TemplatePicker
          onCreated={(id) => {
            setCreating(false);
            select(id);
          }}
        />
      </Sheet>

      {current && editingDash && (
        <DashboardSettings
          key={current.id}
          dashboard={current}
          dashboards={dashboards}
          onClose={() => setEditingDash(false)}
          onDeleted={() => {
            setEditingDash(false);
            setParams({}, { replace: true });
          }}
        />
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  children,
  onClick,
  disabled,
  danger,
}: {
  icon: typeof Plus;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx("flex items-center gap-3 rounded-[10px] px-2 py-3 text-left hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent", danger && "text-bad")}
    >
      <Icon size={18} aria-hidden className={danger ? "" : "text-ink-2"} />
      {children}
    </button>
  );
}

function TemplatePicker({ onCreated }: { onCreated: (id: number) => void }) {
  const boot = useBootstrap();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(TEMPLATES[0].key);
  const create = useMutation({
    mutationFn: () => {
      const t = TEMPLATES.find((x) => x.key === template) ?? TEMPLATES[0];
      return post<{ id: number }>("/dashboards", { name: name.trim() || t.name, widgets: t.widgets(boot.data?.categories ?? []), show_on_home: false });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["dashboards"] });
      onCreated(r.id);
    },
  });
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        {TEMPLATES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTemplate(t.key)}
            aria-pressed={template === t.key}
            className={clsx(
              "rounded-2xl border bg-surface px-4 py-3 text-left transition-colors",
              template === t.key ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2",
            )}
          >
            <span className="flex items-center gap-2 font-medium">
              <LayoutGrid size={16} className="text-accent" aria-hidden /> {t.name}
            </span>
            <span className="mt-1 block text-sm text-ink-2">{t.description}</span>
          </button>
        ))}
      </div>
      <label className="mt-4 block">
        <Label hint="optional">Name</Label>
        <input className="field" value={name} maxLength={60} placeholder={TEMPLATES.find((t) => t.key === template)?.name} onChange={(e) => setName(e.target.value)} />
      </label>
      <ErrorNote error={create.error} />
      <Button variant="primary" className="mt-4 w-full" loading={create.isPending} onClick={() => create.mutate()}>
        Create dashboard
      </Button>
    </div>
  );
}

function DashboardSettings({
  dashboard,
  dashboards,
  onClose,
  onDeleted,
}: {
  dashboard: Dashboard;
  dashboards: Dashboard[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const save = useSaveDashboard();
  const [name, setName] = useState(dashboard.name);
  const [home, setHome] = useState(dashboard.show_on_home);
  const [confirm, setConfirm] = useState(false);
  const i = dashboards.findIndex((d) => d.id === dashboard.id);
  const reorder = async (delta: number) => {
    const ids = dashboards.map((d) => d.id);
    ids.splice(i, 1);
    ids.splice(i + delta, 0, dashboard.id);
    await post("/dashboards/reorder", { ids });
    await qc.invalidateQueries({ queryKey: ["dashboards"] });
  };
  const remove = useMutation({
    mutationFn: () => del(`/dashboards/${dashboard.id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["dashboards"] });
      toast("Dashboard deleted");
      onDeleted();
    },
  });

  return (
    <Sheet
      open
      onClose={onClose}
      title="Dashboard settings"
      footer={
        <div className="flex gap-2">
          <Button variant="ghost" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={() => {
              save.mutate({ ...dashboard, name: name.trim(), show_on_home: home });
              onClose();
            }}
          >
            Save
          </Button>
        </div>
      }
    >
      <label className="block">
        <Label>Name</Label>
        <input className="field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>
      <Toggle checked={home} onChange={setHome} label="Show on Home" hint="Its widgets appear on the Home screen, under your monthly overview." />
      {dashboards.length > 1 && (
        <div className="flex gap-2 py-2">
          <Button size="sm" disabled={i <= 0} onClick={() => reorder(-1)}>
            <ArrowUp size={16} /> Move earlier
          </Button>
          <Button size="sm" disabled={i >= dashboards.length - 1} onClick={() => reorder(1)}>
            <ArrowDown size={16} /> Move later
          </Button>
        </div>
      )}
      <div className="mt-4 border-t border-line pt-4">
        {confirm ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Delete “{dashboard.name}” and its {dashboard.widgets.length} widgets? Your transactions are not affected.</span>
            <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Yes, delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
            <Trash2 size={16} /> Delete dashboard
          </Button>
        )}
      </div>
    </Sheet>
  );
}
