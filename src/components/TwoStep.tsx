// Two-step verification with an authenticator app: set-up flow (QR, confirm, recovery codes) and the
// management section for Settings.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Copy, Download, ShieldCheck } from "lucide-react";
import { get, post } from "../lib/api";
import { Button, ErrorNote, Label, useCopy } from "../lib/ui";

interface Status {
  enabled: boolean;
  skipped: boolean;
  recovery_remaining: number;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const copy = useCopy();
  const text = codes.join("\n");
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Wallet recovery codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "wallet-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  const [saved, setSaved] = useState(false);
  return (
    <div>
      <p className="font-semibold">Save your recovery codes</p>
      <p className="mt-1 text-sm text-ink-2">If you lose your phone, each of these codes lets you sign in once instead of the 6-digit code. They are shown only now. Keep them somewhere safe, not on the same phone.</p>
      <ul className="num mt-3 grid grid-cols-2 gap-2 rounded-2xl bg-surface-2 p-3 text-center font-mono text-[15px]">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => copy(text, "Recovery codes copied")}>
          <Copy size={15} /> Copy
        </Button>
        <Button size="sm" onClick={download}>
          <Download size={15} /> Download
        </Button>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--accent)]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I saved these codes</span>
      </label>
      <Button className="mt-3 w-full" variant="primary" disabled={!saved} onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

/** Scan, confirm, save recovery codes. `onDone` runs when the user has finished all three steps. */
export function TwoStepSetup({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const start = useMutation({
    mutationFn: async () => {
      const r = await post<{ secret: string; uri: string }>("/auth/mfa/setup");
      return { secret: r.secret, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 220 }) };
    },
    onSuccess: setSetup,
  });
  const confirm = useMutation({
    mutationFn: () => post<{ recovery_codes: string[] }>("/auth/mfa/confirm", { code }),
    onSuccess: (r) => {
      setCodes(r.recovery_codes);
      qc.invalidateQueries({ queryKey: ["bootstrap"] });
      qc.invalidateQueries({ queryKey: ["mfa"] });
    },
  });
  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;
  if (!setup)
    return (
      <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>
        <ShieldCheck size={16} /> Set up two-step verification
      </Button>
    );
  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      <img src={setup.qr} alt="QR code for your authenticator app" className="h-44 w-44 shrink-0 self-center rounded-xl bg-white p-2" />
      <div className="flex-1 text-sm">
        <p>Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator…), or type this key in by hand:</p>
        <code className="mt-1 block break-all rounded-lg bg-surface-2 px-3 py-2">{setup.secret}</code>
        <label className="mt-3 block">
          <Label>Then type the 6-digit code it shows</Label>
          <div className="flex gap-2">
            <input className="field num w-36 tracking-[0.2em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            <Button variant="primary" loading={confirm.isPending} disabled={code.length !== 6} onClick={() => confirm.mutate()}>
              Turn on
            </Button>
          </div>
        </label>
        <div className="mt-2">
          <ErrorNote error={confirm.error} />
        </div>
      </div>
    </div>
  );
}

/** Settings → Security: status, new recovery codes, turn off. */
export function TwoStepSection() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["mfa"], queryFn: () => get<Status>("/auth/mfa") });
  const [code, setCode] = useState("");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [setting, setSetting] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["mfa"] });
    qc.invalidateQueries({ queryKey: ["bootstrap"] });
  };
  const disable = useMutation({
    mutationFn: () => post("/auth/mfa/disable", { code }),
    onSuccess: () => {
      setCode("");
      refresh();
    },
  });
  const regenerate = useMutation({
    mutationFn: () => post<{ recovery_codes: string[] }>("/auth/mfa/recovery-codes", { code }),
    onSuccess: (r) => {
      setCode("");
      setNewCodes(r.recovery_codes);
      refresh();
    },
  });
  if (!status.data) return null;

  return (
    <>
      <h3 className="font-semibold">Two-step verification</h3>
      <p className="mt-1 text-sm text-ink-2">Ask for a 6-digit code from an authenticator app after your password or Google sign-in.</p>
      {newCodes ? (
        <div className="mt-3">
          <RecoveryCodes codes={newCodes} onDone={() => setNewCodes(null)} />
        </div>
      ) : setting ? (
        // The set-up flow stays on screen until the recovery codes were saved, even though two-step is already on.
        <div className="mt-3">
          <TwoStepSetup onDone={() => setSetting(false)} />
        </div>
      ) : status.data.enabled ? (
        <div className="mt-3">
          <p className="text-sm text-good">
            On · {status.data.recovery_remaining} recovery {status.data.recovery_remaining === 1 ? "code" : "codes"} left
          </p>
          <label className="mt-3 block">
            <Label hint="(a code from your app, or a recovery code)">To change this, enter a code</Label>
            <input className="field w-48 num" autoComplete="one-time-code" maxLength={11} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" loading={regenerate.isPending} disabled={code.length < 6} onClick={() => regenerate.mutate()}>
              New recovery codes
            </Button>
            <Button size="sm" variant="danger" loading={disable.isPending} disabled={code.length < 6} onClick={() => disable.mutate()}>
              Turn off
            </Button>
          </div>
          <div className="mt-2">
            <ErrorNote error={disable.error ?? regenerate.error} />
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <p className="mb-2 text-sm text-warn">Off{status.data.skipped ? " (you skipped it)" : ""}. Turning it on protects your account if your password or Google account is ever stolen.</p>
          <Button variant="primary" onClick={() => setSetting(true)}>
            <ShieldCheck size={16} /> Turn on
          </Button>
        </div>
      )}
    </>
  );
}
