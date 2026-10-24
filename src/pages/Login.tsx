import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { post } from "../lib/api";
import { Button, ErrorNote, Label } from "../lib/ui";

export default function Login({ onLoggedIn, passwordConfigured }: { onLoggedIn: () => void; passwordConfigured: boolean }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const login = useMutation({
    mutationFn: () => post<{ ok: boolean; totp_required?: boolean }>("/auth/login", { password, code: needCode ? code : undefined }),
    onSuccess: (r) => {
      if (r.totp_required) {
        setNeedCode(true);
        setTimeout(() => codeRef.current?.focus(), 20);
      } else onLoggedIn();
    },
  });

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <form
        className="w-full max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <img src="/icon.svg" alt="" className="mb-6 h-14 w-14" />
        <h1 className="text-[28px] font-semibold tracking-tight">Your wallet</h1>
        <p className="mt-1 text-ink-2">This app is private. Enter your password to continue.</p>
        {!passwordConfigured && (
          <p className="mt-4 rounded-xl bg-warn-soft px-3 py-2 text-sm">
            No password has been set up yet. Follow step 4 of the setup guide (APP_PASSWORD), then redeploy.
          </p>
        )}
        <label className="mt-6 block">
          <Label>Password</Label>
          <input
            type="password"
            className="field"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {needCode && (
          <label className="mt-4 block">
            <Label>6-digit code from your authenticator app</Label>
            <input
              ref={codeRef}
              className="field num tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
        )}
        <div className="mt-4">
          <ErrorNote error={login.error} />
        </div>
        <Button type="submit" variant="primary" className="mt-4 w-full" loading={login.isPending} disabled={!password}>
          <Lock size={16} /> Unlock
        </Button>
      </form>
    </main>
  );
}
