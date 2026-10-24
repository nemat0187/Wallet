import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText, FileSpreadsheet } from "lucide-react";
import { formatMoney } from "@shared/money";
import { post } from "../lib/api";
import { useAccounts, useRefresh } from "../lib/data";
import { amountCell, guessDateFormat, parseCsv, parseDateCell, type DateFormat } from "../lib/csv";
import { Button, ErrorNote, Label, Section, Segmented, Toggle, clsx, useToast } from "../lib/ui";
import { PageHeader } from "../components/Layout";

interface Row {
  date: string;
  time: string | null;
  amount: number;
  currency?: string;
  description: string;
}

export default function ImportPage() {
  const accounts = useAccounts();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [mode, setMode] = useState<"pdf" | "csv">("pdf");
  const [rows, setRows] = useState<Row[] | null>(null);
  const effectiveAccount = accountId ?? accounts.active.find((a) => a.type === "card")?.id ?? null;

  return (
    <div>
      <PageHeader title="Import statement" subtitle="Add your history from before the app was connected, or fill gaps." />
      <ol className="mt-4 flex flex-col gap-1 text-sm text-ink-2">
        <li>In the ABB app, open a card → Statement (Çıxarış) → choose a month → share or download it as PDF.</li>
        <li>Upload it here. The app reads it, shows you every row, and skips anything already recorded from SMS.</li>
      </ol>

      <section className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <Label>Card or account</Label>
          <select className="field" value={effectiveAccount ?? ""} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
            {accounts.active.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <Label>File type</Label>
          <Segmented
            value={mode}
            onChange={(m) => {
              setMode(m);
              setRows(null);
            }}
            options={[
              { value: "pdf", label: "PDF (read by AI)" },
              { value: "csv", label: "CSV / Excel" },
            ]}
          />
        </div>
      </section>

      {!rows && (mode === "pdf" ? <PdfUpload onRows={setRows} /> : <CsvUpload onRows={setRows} />)}
      {rows && <Preview rows={rows} accountId={effectiveAccount} onReset={() => setRows(null)} />}
    </div>
  );
}

function PdfUpload({ onRows }: { onRows: (rows: Row[]) => void }) {
  const read = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 10 * 1024 * 1024) throw new Error("This file is larger than 10 MB. Try a single month.");
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Couldn't read the file"));
        reader.readAsDataURL(file);
      });
      return post<{ rows: Row[] }>("/import/pdf", { file_base64: base64 });
    },
    onSuccess: (r) => onRows(r.rows),
  });
  return (
    <Section title="Upload PDF statement">
      <label
        className={clsx(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line bg-surface px-6 py-10 text-center hover:border-accent",
          read.isPending && "pointer-events-none opacity-60",
        )}
      >
        <FileText size={28} className="text-accent" aria-hidden />
        <span className="font-medium">{read.isPending ? "Reading your statement… (up to a minute)" : "Choose a PDF statement"}</span>
        <span className="text-sm text-ink-3">Uses AI · usually costs less than one cent</span>
        <input type="file" accept="application/pdf" className="sr-only" onChange={(e) => e.target.files?.[0] && read.mutate(e.target.files[0])} />
      </label>
      <div className="mt-3">
        <ErrorNote error={read.error} />
      </div>
    </Section>
  );
}

function CsvUpload({ onRows }: { onRows: (rows: Row[]) => void }) {
  const [table, setTable] = useState<string[][] | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [dateCol, setDateCol] = useState(0);
  const [descCol, setDescCol] = useState(1);
  const [amountMode, setAmountMode] = useState<"single" | "split">("single");
  const [amountCol, setAmountCol] = useState(2);
  const [debitCol, setDebitCol] = useState(2);
  const [creditCol, setCreditCol] = useState(3);
  const [invert, setInvert] = useState(false);
  const [format, setFormat] = useState<DateFormat>("dmy");
  const [error, setError] = useState<string | null>(null);

  const load = async (file: File) => {
    setError(null);
    const text = await file.text();
    const t = parseCsv(text);
    if (t.length < 2) return setError("The file looks empty. In Excel, use File → Save as → CSV.");
    setTable(t);
    const header = t[0].map((h) => h.toLowerCase());
    const find = (re: RegExp, fallback: number) => {
      const i = header.findIndex((h) => re.test(h));
      return i >= 0 ? i : fallback;
    };
    setDateCol(find(/date|tarix|дата/, 0));
    setDescCol(find(/desc|təsvir|tesvir|merchant|назнач|описан|details|təyinat|teyinat/, 1));
    setAmountCol(find(/amount|məbləğ|mebleg|сумма|sum/, 2));
    setDebitCol(find(/debit|məxaric|mexaric|расход|withdraw/, 2));
    setCreditCol(find(/credit|mədaxil|medaxil|приход|deposit/, 3));
    setFormat(guessDateFormat(t.slice(1, 20).map((r) => r[find(/date|tarix|дата/, 0)] ?? "")));
  };

  const columns = table?.[0] ?? [];
  const body = table ? table.slice(hasHeader ? 1 : 0) : [];
  const mapped = useMemo(() => {
    const out: Row[] = [];
    let skipped = 0;
    for (const r of body) {
      const d = parseDateCell(r[dateCol] ?? "", format);
      let amount: number | null;
      if (amountMode === "single") amount = amountCell(r[amountCol] ?? "");
      else {
        const debit = amountCell(r[debitCol] ?? "");
        const credit = amountCell(r[creditCol] ?? "");
        amount = credit ? Math.abs(credit) : debit ? -Math.abs(debit) : null;
      }
      if (!d || !amount) {
        skipped++;
        continue;
      }
      out.push({ date: d.date, time: d.time, amount: invert ? -amount : amount, description: (r[descCol] ?? "").slice(0, 300) || "Imported" });
    }
    return { rows: out, skipped };
  }, [body, dateCol, descCol, amountMode, amountCol, debitCol, creditCol, invert, format]);

  const colSelect = (value: number, onChange: (v: number) => void, label: string) => (
    <label className="block">
      <Label>{label}</Label>
      <select className="field" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {columns.map((c, i) => (
          <option key={i} value={i}>
            {hasHeader ? c || `Column ${i + 1}` : `Column ${i + 1} (${c.slice(0, 20)})`}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Section title="Upload CSV">
      {!table ? (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line bg-surface px-6 py-10 text-center hover:border-accent">
          <FileSpreadsheet size={28} className="text-accent" aria-hidden />
          <span className="font-medium">Choose a CSV file</span>
          <span className="text-sm text-ink-3">From Excel: File → Save as → CSV</span>
          <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
        </label>
      ) : (
        <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4">
          <Toggle checked={hasHeader} onChange={setHasHeader} label="First row contains column names" />
          <div className="grid gap-3 sm:grid-cols-3">
            {colSelect(dateCol, setDateCol, "Date column")}
            <label className="block">
              <Label>Date format</Label>
              <select className="field" value={format} onChange={(e) => setFormat(e.target.value as DateFormat)}>
                <option value="dmy">31.12.2026 (day first)</option>
                <option value="ymd">2026-12-31</option>
                <option value="mdy">12/31/2026 (month first)</option>
              </select>
            </label>
            {colSelect(descCol, setDescCol, "Description column")}
          </div>
          <Segmented
            value={amountMode}
            onChange={setAmountMode}
            options={[
              { value: "single", label: "One amount column" },
              { value: "split", label: "Separate in / out columns" },
            ]}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            {amountMode === "single" ? (
              colSelect(amountCol, setAmountCol, "Amount column")
            ) : (
              <>
                {colSelect(debitCol, setDebitCol, "Money out column")}
                {colSelect(creditCol, setCreditCol, "Money in column")}
              </>
            )}
          </div>
          {amountMode === "single" && <Toggle checked={invert} onChange={setInvert} label="Spending is shown as positive numbers" hint="Turn on if purchases appear without a minus sign." />}
          <p className="text-sm text-ink-2">
            {mapped.rows.length} rows ready{mapped.skipped ? `, ${mapped.skipped} skipped (no date or amount)` : ""}.
          </p>
          <div className="flex gap-2">
            <Button variant="primary" disabled={!mapped.rows.length} onClick={() => onRows(mapped.rows)}>
              Review {mapped.rows.length} rows
            </Button>
            <Button variant="ghost" onClick={() => setTable(null)}>
              Choose another file
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </Section>
  );
}

function Preview({ rows, accountId, onReset }: { rows: Row[]; accountId: number | null; onReset: () => void }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [skip, setSkip] = useState(true);
  const dup = useQuery({
    queryKey: ["import-preview", accountId, rows],
    queryFn: () => post<{ duplicates: boolean[] }>("/import/preview", { account_id: accountId, rows }),
    staleTime: Infinity,
  });
  const commit = useMutation({
    mutationFn: () => post<{ imported: number; skipped: number }>("/import/commit", { account_id: accountId, rows, skip_duplicates: skip }),
    onSuccess: (r) => {
      toast(`Imported ${r.imported} transactions${r.skipped ? ` · skipped ${r.skipped} already recorded` : ""}`);
      refresh();
      onReset();
    },
  });
  const duplicates = dup.data?.duplicates;
  const dupCount = duplicates?.filter(Boolean).length ?? 0;
  const spent = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
  const income = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);

  return (
    <Section title={`Review ${rows.length} transactions`}>
      <p className="text-sm text-ink-2">
        Money out {formatMoney(spent)} · money in {formatMoney(income)}
        {duplicates ? ` · ${dupCount} already recorded` : ""}
      </p>
      <div className="mt-3 max-h-[420px] overflow-auto rounded-2xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-line text-left text-ink-3">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r, i) => (
              <tr key={i} className={clsx(duplicates?.[i] && skip && "text-ink-3 line-through")}>
                <td className="num whitespace-nowrap px-3 py-2">{r.date}</td>
                <td className="px-3 py-2">{r.description}</td>
                <td className={clsx("num whitespace-nowrap px-3 py-2 text-right", r.amount > 0 && "text-good")}>{formatMoney(r.amount, r.currency ?? "AZN", { sign: r.amount > 0 })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dupCount > 0 && <Toggle checked={skip} onChange={setSkip} label={`Skip the ${dupCount} rows that are already recorded`} hint="Matched by card, amount and date." />}
      <ErrorNote error={commit.error ?? dup.error} />
      <div className="mt-3 flex gap-2">
        <Button variant="primary" loading={commit.isPending} onClick={() => commit.mutate()}>
          Import {skip ? rows.length - dupCount : rows.length} transactions
        </Button>
        <Button variant="ghost" onClick={onReset}>
          Cancel
        </Button>
      </div>
    </Section>
  );
}
