// First sign-in: offer two-step verification before showing the app. It can be skipped and turned on later in
// Settings. The decision is made once, when the app loads, so the recovery-codes step stays on screen after
// two-step verification has switched on in the background.

import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { post } from "../lib/api";
import { useBootstrap } from "../lib/data";
import { Spinner } from "../lib/ui";
import { TwoStepSetup } from "./TwoStep";

export default function MfaGate({ children }: { children: ReactNode }) {
  const boot = useBootstrap();
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState<boolean | null>(null);
  useEffect(() => {
    if (prompt === null && boot.data) setPrompt(Boolean(boot.data.security && !boot.data.security.enabled && !boot.data.security.skipped));
  }, [boot.data, prompt]);
  const skip = useMutation({
    mutationFn: () => post("/auth/mfa/skip"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bootstrap"] });
      setPrompt(false);
    },
  });

  if (prompt === null) return boot.error ? <>{children}</> : <Spinner />;
  if (!prompt) return <>{children}</>;
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <ShieldCheck size={28} aria-hidden />
        </span>
        <h1 className="text-[26px] font-semibold tracking-tight">Secure your account</h1>
        <p className="mt-1 text-ink-2">
          Add a 6-digit code from an authenticator app to your sign-in. It takes a minute and keeps your money data safe even if your password or Google account is stolen.
        </p>
        <div className="mt-6 rounded-3xl border border-line bg-surface p-5">
          <TwoStepSetup onDone={() => setPrompt(false)} />
        </div>
        <button type="button" className="mt-4 w-full text-center text-sm font-medium text-ink-2 hover:text-ink" onClick={() => skip.mutate()} disabled={skip.isPending}>
          Skip for now. You can turn it on later in Settings.
        </button>
      </div>
    </main>
  );
}
