// Settings -> Security: lock time, lock now, change PIN.

import { useState } from "react";
import { Lock } from "lucide-react";
import { useBootstrap } from "../lib/data";
import { LOCK_OPTIONS, checkRecord, loadRecord, lockAfterMinutes, makeRecord, saveRecord, setLockAfterMinutes, validPin, MAX_LEN, MIN_LEN } from "../lib/pin";
import { Button, Label, useToast } from "../lib/ui";
import { lockNow } from "./PinGate";

export function PinSection() {
  const boot = useBootstrap();
  const toast = useToast();
  const [after, setAfter] = useState(lockAfterMinutes());
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const record = loadRecord();
    if (!record || !(await checkRecord(record, current))) return setError("The current PIN is not correct.");
    if (!validPin(next)) return setError(`The new PIN must be ${MIN_LEN} to ${MAX_LEN} digits.`);
    if (next !== again) return setError("The two new PINs don't match.");
    saveRecord(await makeRecord(next, boot.data?.user?.id ?? record.uid));
    setChanging(false);
    setCurrent("");
    setNext("");
    setAgain("");
    setError(null);
    toast("PIN changed");
  };
  const digits = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setter(e.target.value.replace(/\D/g, "").slice(0, MAX_LEN));
  };

  return (
    <>
      <h3 className="mt-6 font-semibold">App lock (PIN)</h3>
      <p className="mt-1 text-sm text-ink-2">The PIN opens the app on this device only. It is stored here, never sent to the server, and every new device has its own. It protects a phone that is left unlocked; signing in is still done with your account.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <Label>Lock the app</Label>
          <select
            className="field w-auto"
            value={after}
            onChange={(e) => {
              setAfter(Number(e.target.value));
              setLockAfterMinutes(Number(e.target.value));
            }}
          >
            {LOCK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={lockNow}>
          <Lock size={15} /> Lock now
        </Button>
        {!changing && (
          <Button variant="ghost" onClick={() => setChanging(true)}>
            Change PIN
          </Button>
        )}
      </div>
      {changing && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <Label>Current PIN</Label>
            <input className="field num" type="password" inputMode="numeric" autoComplete="off" value={current} onChange={digits(setCurrent)} />
          </label>
          <label className="block">
            <Label>New PIN</Label>
            <input className="field num" type="password" inputMode="numeric" autoComplete="off" value={next} onChange={digits(setNext)} />
          </label>
          <label className="block">
            <Label>New PIN again</Label>
            <input className="field num" type="password" inputMode="numeric" autoComplete="off" value={again} onChange={digits(setAgain)} />
          </label>
          <div className="flex gap-2 sm:col-span-3">
            <Button variant="primary" onClick={save} disabled={!current || !next || !again}>
              Save new PIN
            </Button>
            <Button variant="ghost" onClick={() => setChanging(false)}>
              Cancel
            </Button>
          </div>
          {error && (
            <p className="text-sm text-bad sm:col-span-3" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}
