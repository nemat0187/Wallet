// Per-device PIN: created (twice) the first time a user signs in on a device, asked again when the app has been out
// of use for the chosen time, and wiped after too many wrong tries.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Delete, Lock } from "lucide-react";
import { post } from "../lib/api";
import { useBootstrap } from "../lib/data";
import {
  MAX_LEN,
  MAX_TRIES,
  MIN_LEN,
  checkRecord,
  clearPin,
  loadRecord,
  makeRecord,
  recordWrongTry,
  resetTries,
  saveRecord,
  shouldLock,
  touchActive,
  triesLeft,
  validPin,
} from "../lib/pin";
import { Button, Spinner, clsx } from "../lib/ui";

export const LOCK_EVENT = "wallet:lock";
export const lockNow = () => window.dispatchEvent(new Event(LOCK_EVENT));

/** Dots and a keypad; also accepts the keyboard. `length` set = submit automatically when full. */
function PinEntry({ value, onChange, length, onSubmit, disabled }: { value: string; onChange: (v: string) => void; length?: number; onSubmit?: () => void; disabled?: boolean }) {
  const dots = length ?? Math.max(MIN_LEN, value.length);
  const press = useCallback(
    (d: string) => {
      if (disabled) return;
      const next = (value + d).slice(0, MAX_LEN);
      onChange(next);
    },
    [value, onChange, disabled],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") onChange(value.slice(0, -1));
      else if (e.key === "Enter") onSubmit?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, onChange, onSubmit, value]);
  useEffect(() => {
    if (length && value.length === length) onSubmit?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, length]);

  return (
    <div>
      <div className="flex justify-center gap-3 py-5" aria-label={`${value.length} digits entered`} role="img">
        {Array.from({ length: dots }, (_, i) => (
          <span key={i} className={clsx("h-3.5 w-3.5 rounded-full border-2", i < value.length ? "border-accent bg-accent" : "border-ink-3")} />
        ))}
      </div>
      <div className="mx-auto grid max-w-[18rem] grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" onClick={() => press(d)} disabled={disabled} className="h-16 rounded-2xl bg-surface-2 text-2xl font-medium num active:bg-line disabled:opacity-50">
            {d}
          </button>
        ))}
        <span />
        <button type="button" onClick={() => press("0")} disabled={disabled} className="h-16 rounded-2xl bg-surface-2 text-2xl font-medium num active:bg-line disabled:opacity-50">
          0
        </button>
        <button type="button" onClick={() => onChange(value.slice(0, -1))} aria-label="Delete last digit" className="flex h-16 items-center justify-center rounded-2xl text-ink-2 active:bg-surface-2">
          <Delete size={24} />
        </button>
      </div>
    </div>
  );
}

function Screen({ title, text, children }: { title: string; text?: ReactNode; children: ReactNode }) {
  return (
    <main className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-paper px-4 py-8">
      <div className="w-full max-w-sm text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Lock size={26} aria-hidden />
        </span>
        <h1 className="mt-4 text-[24px] font-semibold tracking-tight">{title}</h1>
        {text && <p className="mt-1 text-sm text-ink-2">{text}</p>}
        {children}
      </div>
    </main>
  );
}

function Setup({ uid, onDone }: { uid: number; onDone: () => void }) {
  const [first, setFirst] = useState("");
  const [again, setAgain] = useState("");
  const [step, setStep] = useState<"choose" | "confirm">("choose");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = step === "choose" ? first : again;
  const set = (v: string) => {
    setError(null);
    return step === "choose" ? setFirst(v) : setAgain(v);
  };
  const next = async () => {
    if (step === "choose") {
      if (!validPin(first)) return setError(`Use ${MIN_LEN} to ${MAX_LEN} digits`);
      setStep("confirm");
      return;
    }
    if (again !== first) {
      setAgain("");
      return setError("The two PINs don't match. Enter the PIN again.");
    }
    setBusy(true);
    saveRecord(await makeRecord(first, uid));
    touchActive();
    onDone();
  };
  return (
    <Screen
      title={step === "choose" ? "Create a PIN" : "Enter it again"}
      text={step === "choose" ? "This PIN opens the app on this phone or computer. Every new device asks for its own." : "Type the same PIN once more to confirm."}
    >
      <PinEntry value={value} onChange={set} onSubmit={next} disabled={busy} />
      <p className="mt-3 min-h-5 text-sm text-bad" role="alert">
        {error}
      </p>
      <Button variant="primary" className="mt-3 w-full" onClick={next} loading={busy} disabled={value.length < MIN_LEN}>
        {step === "choose" ? "Continue" : "Save PIN"}
      </Button>
      {step === "confirm" && (
        <button
          type="button"
          className="mt-3 text-sm font-medium text-ink-2"
          onClick={() => {
            setStep("choose");
            setFirst("");
            setAgain("");
          }}
        >
          Start over
        </button>
      )}
    </Screen>
  );
}

function Lock_({ onUnlock, onForgot }: { onUnlock: () => void; onForgot: () => void }) {
  // Read once: after the last wrong try the PIN is wiped while this screen is still showing.
  const [record] = useState(() => loadRecord()!);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || pin.length < record.len) return;
    setBusy(true);
    if (await checkRecord(record, pin)) {
      resetTries();
      touchActive();
      onUnlock();
      return;
    }
    const left = recordWrongTry();
    setPin("");
    setBusy(false);
    if (left <= 0) return onForgot();
    setError(`Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left before you're signed out.`);
  };
  return (
    <Screen title="Enter your PIN">
      <PinEntry value={pin} onChange={(v) => { setError(null); setPin(v); }} length={record.len} onSubmit={submit} disabled={busy} />
      <p className="mt-3 min-h-5 text-sm text-bad" role="alert">
        {error ?? (triesLeft() < MAX_TRIES ? `${triesLeft()} tries left` : "")}
      </p>
      <button type="button" className="mt-4 text-sm font-medium text-ink-2 hover:text-ink" onClick={onForgot}>
        Forgot PIN? Sign out
      </button>
    </Screen>
  );
}

export default function PinGate({ children }: { children: ReactNode }) {
  const boot = useBootstrap();
  const uid = boot.data?.user?.id ?? null;
  const [state, setState] = useState<"checking" | "setup" | "locked" | "open">("checking");
  const lastHidden = useRef(0);

  // Decide once the user is known: no PIN for this user on this device -> create one; else lock if idle long enough.
  useEffect(() => {
    if (uid === null || state !== "checking") return;
    const record = loadRecord();
    if (!record || record.uid !== uid) {
      clearPin();
      setState("setup");
    } else setState(shouldLock() ? "locked" : "open");
  }, [uid, state]);

  // Lock again when the app has been out of sight for long enough, or when asked to (Settings -> Lock now).
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        lastHidden.current = Date.now();
        touchActive();
      } else if (loadRecord() && lastHidden.current) {
        if (shouldLock()) setState("locked");
        else touchActive();
      }
    };
    const onLock = () => loadRecord() && setState("locked");
    const beat = setInterval(() => !document.hidden && state === "open" && touchActive(), 10_000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", touchActive);
    window.addEventListener(LOCK_EVENT, onLock);
    return () => {
      clearInterval(beat);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", touchActive);
      window.removeEventListener(LOCK_EVENT, onLock);
    };
  }, [state]);

  const signOut = async () => {
    clearPin();
    try {
      await post("/auth/logout");
    } finally {
      window.location.reload();
    }
  };

  if (uid === null || state === "checking") return <Spinner />;
  if (state === "setup") return <Setup uid={uid} onDone={() => setState("open")} />;
  return (
    <>
      {children}
      {state === "locked" && <Lock_ onUnlock={() => setState("open")} onForgot={signOut} />}
    </>
  );
}
