import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Clock, Lock } from "lucide-react";
import { post } from "../lib/api";
import { Button, ErrorNote, Label, clsx } from "../lib/ui";

/** What the server tells us when it sends the browser back to "/?auth=…". */
const AUTH_NOTES: Record<string, { tone: "info" | "warn"; title: string; text: string }> = {
  pending: {
    tone: "info",
    title: "Request sent",
    text: "The owner has to approve your account first. Come back and use Continue with Google again once you've been approved.",
  },
  closed: { tone: "warn", title: "Sign-ups are closed", text: "This wallet isn't accepting new people right now. Ask the owner to open sign-ups or invite you." },
  disabled: { tone: "warn", title: "Account switched off", text: "Your access has been turned off. Contact the owner." },
  busy: { tone: "warn", title: "Too many requests", text: "Please try again a bit later." },
  cancelled: { tone: "warn", title: "Google sign-in was cancelled", text: "You can try again." },
  mfa: { tone: "info", title: "One more step", text: "Enter the code from your authenticator app to finish signing in." },
  error: { tone: "warn", title: "Couldn't sign in with Google", text: "Please try again. If it keeps happening, tell the owner." },
};

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

export default function Login({
  onLoggedIn,
  passwordConfigured,
  googleConfigured,
  registrationOpen,
}: {
  onLoggedIn: () => void;
  passwordConfigured: boolean;
  googleConfigured: boolean;
  registrationOpen: boolean;
}) {
  const auth = new URLSearchParams(window.location.search).get("auth");
  const note = auth ? AUTH_NOTES[auth] : null;
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  // The code step is shown after the password (or Google, which comes back with ?auth=mfa).
  const [needCode, setNeedCode] = useState(auth === "mfa");
  // Without Google the password form is the only way in, so it is open; with Google it sits under a toggle.
  const [showPassword, setShowPassword] = useState(!googleConfigured || auth === "closed");
  const codeRef = useRef<HTMLInputElement>(null);
  const login = useMutation({
    mutationFn: () => post<{ ok: boolean; mfa_required?: boolean }>("/auth/login", { password }),
    onSuccess: (r) => {
      if (r.mfa_required) {
        setNeedCode(true);
        setTimeout(() => codeRef.current?.focus(), 20);
      } else onLoggedIn();
    },
  });
  const verify = useMutation({
    mutationFn: () => post("/auth/mfa/verify", { code }),
    onSuccess: () => {
      // Leave the "?auth=mfa" address behind before showing the app.
      window.history.replaceState(null, "", "/");
      onLoggedIn();
    },
  });

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <img src="/icon.svg" alt="" className="mb-6 h-14 w-14" />
        <h1 className="text-[28px] font-semibold tracking-tight">Your wallet</h1>
        <p className="mt-1 text-ink-2">{googleConfigured ? "Sign in to continue." : "This app is private. Enter your password to continue."}</p>

        {note && (
          <div className={clsx("mt-5 flex gap-3 rounded-2xl px-4 py-3 text-sm", note.tone === "info" ? "bg-accent-soft" : "bg-warn-soft")} role="status">
            {note.tone === "info" && <Clock size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />}
            <div>
              <p className="font-semibold">{note.title}</p>
              <p className="mt-0.5 text-ink-2">{note.text}</p>
            </div>
          </div>
        )}

        {googleConfigured && !needCode && (
          <>
            <a
              href="/api/auth/google/start"
              className="mt-6 flex h-12 items-center justify-center gap-3 rounded-[10px] border border-line bg-surface font-medium hover:bg-surface-2"
            >
              <GoogleLogo /> Continue with Google
            </a>
            <p className="mt-2 text-center text-[13px] text-ink-3">
              {registrationOpen ? "New here? Continue with Google to ask for access. The owner approves new people." : "Only people the owner has approved can sign in."}
            </p>
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="mt-6 flex w-full items-center justify-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink"
              aria-expanded={showPassword}
            >
              Owner password login <ChevronDown size={16} className={clsx("transition-transform", showPassword && "rotate-180")} aria-hidden />
            </button>
          </>
        )}

        {needCode ? (
          <form
            className="mt-6"
            onSubmit={(e) => {
              e.preventDefault();
              verify.mutate();
            }}
          >
            <label className="block">
              <Label hint="or a recovery code">Code from your authenticator app</Label>
              <input
                ref={codeRef}
                className="field num tracking-[0.2em]"
                autoFocus
                autoComplete="one-time-code"
                maxLength={11}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <div className="mt-4">
              <ErrorNote error={verify.error} />
            </div>
            <Button type="submit" variant="primary" className="mt-4 w-full" loading={verify.isPending} disabled={code.trim().length < 6}>
              <Lock size={16} /> Continue
            </Button>
          </form>
        ) : (
          showPassword && (
            <form
              className="mt-2"
              onSubmit={(e) => {
                e.preventDefault();
                login.mutate();
              }}
            >
              {!passwordConfigured && (
                <p className="mt-2 rounded-xl bg-warn-soft px-3 py-2 text-sm">No password has been set up yet. Follow step 4 of the setup guide (APP_PASSWORD), then redeploy.</p>
              )}
              <label className="mt-4 block">
                <Label>Password</Label>
                <input type="password" className="field" autoComplete="current-password" autoFocus={!googleConfigured} value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <div className="mt-4">
                <ErrorNote error={login.error} />
              </div>
              <Button type="submit" variant="primary" className="mt-4 w-full" loading={login.isPending} disabled={!password}>
                <Lock size={16} /> Unlock
              </Button>
            </form>
          )
        )}
      </div>
    </main>
  );
}
