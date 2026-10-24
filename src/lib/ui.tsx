// Small shared UI building blocks.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { X, Loader2 } from "lucide-react";
import { formatMoney } from "@shared/money";

export { clsx };

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-[10px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none",
        size === "sm" ? "h-9 px-3 text-sm" : "h-11 px-4",
        variant === "primary" && "bg-accent text-accent-ink hover:bg-accent-hover",
        variant === "secondary" && "bg-surface border border-line text-ink hover:bg-surface-2",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "bg-bad-soft text-bad hover:brightness-95",
        className,
      )}
    >
      {loading && <Loader2 size={16} className="spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-ink-3" role="status">
      <Loader2 size={18} className="spin" aria-hidden />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="font-semibold text-ink">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-sm text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="rounded-[10px] bg-bad-soft px-3 py-2 text-sm text-bad" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

/** Signed money with colour for income. Expenses stay in ink; only incoming money is tinted. */
export function Money({
  value,
  currency = "AZN",
  sign = false,
  className,
  tint = true,
}: {
  value: number;
  currency?: string;
  sign?: boolean;
  className?: string;
  tint?: boolean;
}) {
  return (
    <span className={clsx("num whitespace-nowrap", tint && value > 0 && sign && "text-good", className)}>
      {formatMoney(value, currency, { sign })}
    </span>
  );
}

export function Section({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("mt-8", className)}>
      {(title || action) && (
        <div className="mb-3 flex items-end justify-between gap-3 px-1">
          {title && <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("rounded-2xl border border-line bg-surface", className)}>{children}</div>;
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-3">
      <span>
        <span className="block text-ink">{label}</span>
        {hint && <span className="block text-sm text-ink-3">{hint}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-7 w-12 rounded-full bg-surface-2 border border-line transition-colors peer-checked:bg-accent peer-checked:border-accent peer-focus-visible:outline-2 peer-focus-visible:outline-accent" />
        <span className="absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={clsx("inline-flex rounded-[10px] bg-surface-2 p-1", className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "h-8 whitespace-nowrap rounded-[8px] px-2.5 text-sm font-medium transition-colors sm:px-3",
            value === o.value ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="mb-1.5 block text-sm font-medium text-ink-2">
      {children}
      {hint && <span className="ml-1 font-normal text-ink-3">{hint}</span>}
    </span>
  );
}

/** Bottom sheet on phones, centred dialog on larger screens. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    setTimeout(() => ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus(), 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="fade-in absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className={clsx(
          "sheet-in relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl bg-surface shadow-sheet sm:rounded-3xl",
          wide ? "sm:max-w-2xl" : "sm:max-w-lg",
        )}
      >
        <div className="flex items-center justify-between gap-4 px-5 pb-2 pt-4">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <button onClick={onClose} className="-mr-2 rounded-full p-2 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 pb-5">{children}</div>
        {footer && <div className="pb-safe border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Toasts

type Toast = { id: number; text: string; tone: "ok" | "error" };
const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 6000 : 3000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-8" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              "sheet-in pointer-events-auto max-w-md rounded-xl px-4 py-2.5 text-sm font-medium shadow-sheet",
              t.tone === "error" ? "bg-bad text-white" : "bg-ink text-paper",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Copy text with feedback. */
export function useCopy() {
  const toast = useToast();
  return async (text: string, what = "Copied") => {
    try {
      await navigator.clipboard.writeText(text);
      toast(what);
    } catch {
      toast("Couldn't copy — select the text and copy it manually", "error");
    }
  };
}
