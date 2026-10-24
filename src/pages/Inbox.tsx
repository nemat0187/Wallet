import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RotateCcw, EyeOff, Trash2, CheckCircle2, AlertCircle, MinusCircle } from "lucide-react";
import type { ParsedMessage, RawMessage } from "@shared/types";
import { formatMoney } from "@shared/money";
import { del, get, post } from "../lib/api";
import { useRefresh } from "../lib/data";
import { Button, Empty, ErrorNote, Label, Section, Segmented, Spinner, clsx, errorText, useToast } from "../lib/ui";
import { PageHeader } from "../components/Layout";

type Filter = "" | "failed" | "parsed" | "ignored";

export default function Inbox() {
  const [filter, setFilter] = useState<Filter>("");
  const list = useQuery({ queryKey: ["messages", filter], queryFn: () => get<RawMessage[]>(`/messages${filter ? `?status=${filter}` : ""}`) });
  return (
    <div>
      <PageHeader title="Bank messages" subtitle="Every SMS or notification your phone forwarded, and what the app read from it." />
      <PasteBox />
      <Section title="Received">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "", label: "All" },
            { value: "failed", label: "Couldn't read" },
            { value: "parsed", label: "Recorded" },
            { value: "ignored", label: "Ignored" },
          ]}
        />
        <div className="mt-4">
          {!list.data ? (
            <Spinner />
          ) : list.data.length === 0 ? (
            <Empty title={filter === "failed" ? "Nothing to fix" : "No messages yet"}>
              {filter ? "" : "Once your phone is connected (Settings → Phone connection), messages appear here within seconds."}
            </Empty>
          ) : (
            <ul className="flex flex-col gap-3">
              {list.data.map((m) => (
                <MessageCard key={m.id} m={m} />
              ))}
            </ul>
          )}
        </div>
      </Section>
    </div>
  );
}

const STATUS = {
  parsed: { label: "Recorded", icon: CheckCircle2, cls: "text-good" },
  failed: { label: "Couldn't read", icon: AlertCircle, cls: "text-bad" },
  ignored: { label: "Ignored", icon: MinusCircle, cls: "text-ink-3" },
  duplicate: { label: "Duplicate", icon: MinusCircle, cls: "text-ink-3" },
  pending: { label: "Waiting", icon: MinusCircle, cls: "text-ink-3" },
};

function MessageCard({ m }: { m: RawMessage }) {
  const refresh = useRefresh();
  const toast = useToast();
  const s = STATUS[m.status];
  let parsed: ParsedMessage | null = null;
  try {
    parsed = m.parse_result ? JSON.parse(m.parse_result) : null;
  } catch {
    parsed = null;
  }
  const act = useMutation({
    mutationFn: (action: "reprocess" | "ignore" | "delete") =>
      action === "delete" ? del(`/messages/${m.id}`) : post<{ status?: string; error?: string }>(`/messages/${m.id}/${action}`),
    onSuccess: (r, action) => {
      const res = r as { status?: string; error?: string };
      if (action === "reprocess") toast(res.status === "parsed" ? "Recorded" : `Still couldn't read it${res.error ? `: ${res.error}` : ""}`, res.status === "parsed" ? "ok" : "error");
      refresh();
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center gap-2 text-sm">
        <s.icon size={16} className={s.cls} aria-hidden />
        <span className={clsx("font-medium", s.cls)}>{s.label}</span>
        <span className="text-ink-3">
          · {new Date(m.received_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
          {m.sender ? ` · ${m.sender}` : ""}
          {m.parse_method?.includes("ai") ? " · read with AI" : ""}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-relaxed">{m.body}</p>
      {parsed?.is_transaction && m.status === "parsed" && (
        <p className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-sm text-ink-2">
          {parsed.direction === "in" ? "Money in" : "Money out"} <strong className="num text-ink">{formatMoney(parsed.amount, parsed.currency)}</strong>
          {parsed.merchant ? ` · ${parsed.merchant}` : ""}
          {parsed.card_last4 ? ` · card •${parsed.card_last4}` : ""}
        </p>
      )}
      {m.error && m.status !== "parsed" && <p className="mt-2 text-sm text-ink-3">{m.error}</p>}
      {m.status !== "parsed" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => act.mutate("reprocess")} loading={act.isPending && act.variables === "reprocess"}>
            <RotateCcw size={15} /> Try again
          </Button>
          {m.status === "failed" && (
            <Button size="sm" variant="ghost" onClick={() => act.mutate("ignore")}>
              <EyeOff size={15} /> Ignore
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => act.mutate("delete")}>
            <Trash2 size={15} /> Delete
          </Button>
        </div>
      )}
    </li>
  );
}

function PasteBox() {
  const refresh = useRefresh();
  const toast = useToast();
  const [text, setText] = useState("");
  const check = useMutation({ mutationFn: () => post<ParsedMessage>("/messages/test", { text }) });
  const save = useMutation({
    mutationFn: () => post<{ status: string; error?: string }>("/messages", { text }),
    onSuccess: (r) => {
      toast(r.status === "parsed" ? "Transaction recorded" : r.status === "duplicate" ? "This message was already recorded" : `Couldn't read it: ${r.error ?? r.status}`, r.status === "parsed" || r.status === "duplicate" ? "ok" : "error");
      if (r.status === "parsed") setText("");
      check.reset();
      refresh();
    },
  });
  const p = check.data;
  return (
    <section className="mt-5 rounded-2xl border border-line bg-surface p-4">
      <label className="block">
        <Label>Paste a bank message</Label>
        <textarea
          className="field min-h-24"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            check.reset();
          }}
          placeholder={"e.g.\nMəxaric: 12.50 AZN\nBRAVO SUPERMARKET\nKart: 4169***1234\nBalans: 987.65 AZN"}
        />
      </label>
      <p className="mt-1.5 text-[13px] text-ink-3">Useful for testing, or for an old SMS your phone didn't forward.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={!text.trim()} loading={check.isPending} onClick={() => check.mutate()}>
          Check what the app reads
        </Button>
        <Button size="sm" variant="primary" disabled={!text.trim()} loading={save.isPending} onClick={() => save.mutate()}>
          Record it
        </Button>
      </div>
      <ErrorNote error={check.error ?? save.error} />
      {p && (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-surface-2 p-3 text-sm sm:grid-cols-3">
          {p.is_transaction ? (
            <>
              <Item k="Direction" v={p.direction === "in" ? "Money in" : "Money out"} />
              <Item k="Amount" v={formatMoney(p.amount, p.currency)} />
              <Item k="Type" v={p.type.replace("_", " ")} />
              <Item k="Merchant" v={p.merchant ?? "—"} />
              <Item k="Card" v={p.card_last4 ? `•${p.card_last4}` : "—"} />
              <Item k="Balance after" v={p.balance_after !== null ? formatMoney(p.balance_after, p.balance_currency ?? "AZN") : "—"} />
              <Item k="Date" v={p.occurred_at ? new Date(p.occurred_at).toLocaleString("en-GB") : "time received"} />
              <Item k="Certainty" v={`${Math.round(p.confidence * 100)}%${p.confidence < 0.75 ? " (AI will double-check)" : ""}`} />
            </>
          ) : (
            <p className="col-span-full text-ink-2">This doesn't look like a card transaction (no amount found, or it's a one-time code).</p>
          )}
        </dl>
      )}
    </section>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-ink-3">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
