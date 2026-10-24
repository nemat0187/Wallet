import { createContext, useContext, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Home,
  ListOrdered,
  PiggyBank,
  Sparkles,
  Menu,
  BarChart3,
  Tags,
  Store,
  CreditCard,
  Inbox,
  Upload,
  Settings,
  Plus,
} from "lucide-react";
import { clsx } from "../lib/ui";
import { useBootstrap } from "../lib/data";
import { QuickAdd } from "./QuickAdd";

const QuickAddContext = createContext<() => void>(() => {});
export const useQuickAdd = () => useContext(QuickAddContext);

const primary = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/activity", label: "Activity", icon: ListOrdered },
  { to: "/budgets", label: "Budgets", icon: PiggyBank },
  { to: "/insights", label: "Insights", icon: Sparkles },
];

const secondary = [
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/categories", label: "Categories", icon: Tags },
  { to: "/merchants", label: "Merchants & rules", icon: Store },
  { to: "/accounts", label: "Cards & accounts", icon: CreditCard },
  { to: "/inbox", label: "Bank messages", icon: Inbox },
  { to: "/import", label: "Import statement", icon: Upload },
  { to: "/settings", label: "Settings", icon: Settings },
];

export const MORE_LINKS = secondary;

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warn px-1.5 text-[11px] font-semibold text-white num">
      {n > 99 ? "99+" : n}
    </span>
  );
}

export default function Layout() {
  const [quickAdd, setQuickAdd] = useState(false);
  const { data } = useBootstrap();
  const location = useLocation();
  const review = data?.counts.review ?? 0;
  const failed = data?.counts.failed ?? 0;
  const onMorePage = secondary.some((s) => location.pathname.startsWith(s.to)) || location.pathname === "/more";

  return (
    <QuickAddContext.Provider value={() => setQuickAdd(true)}>
      <div className="min-h-dvh lg:flex">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface px-3 py-5 lg:flex">
          <div className="flex items-center gap-2.5 px-3 pb-6">
            <img src="/icon.svg" alt="" className="h-8 w-8" />
            <span className="text-lg font-semibold tracking-tight">Wallet</span>
          </div>
          <button
            onClick={() => setQuickAdd(true)}
            className="mx-1 mb-5 flex h-11 items-center justify-center gap-2 rounded-[10px] bg-accent font-medium text-accent-ink hover:bg-accent-hover"
          >
            <Plus size={18} /> Add expense
          </button>
          <nav className="flex flex-col gap-0.5" aria-label="Main">
            {primary.map((item) => (
              <SideLink key={item.to} {...item} badge={item.to === "/activity" ? review : 0} />
            ))}
            <div className="my-3 border-t border-line" />
            {secondary.map((item) => (
              <SideLink key={item.to} {...item} badge={item.to === "/inbox" ? failed : 0} />
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 pb-28 lg:pb-12">
          <div className="mx-auto w-full max-w-5xl px-4 pt-4 sm:px-6 lg:px-10 lg:pt-8">
            <Outlet />
          </div>
        </main>

        {/* Phone tab bar */}
        <nav
          className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur lg:hidden"
          aria-label="Main"
        >
          <div className="mx-auto grid max-w-lg grid-cols-5 items-end px-2">
            {primary.slice(0, 2).map((item) => (
              <TabLink key={item.to} {...item} badge={item.to === "/activity" ? review : 0} />
            ))}
            <div className="flex justify-center">
              <button
                onClick={() => setQuickAdd(true)}
                aria-label="Add expense"
                className="-mt-5 mb-1 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-ink shadow-sheet hover:bg-accent-hover"
              >
                <Plus size={26} />
              </button>
            </div>
            <TabLink {...primary[2]} />
            <TabLink to="/more" label="More" icon={Menu} forceActive={onMorePage} badge={failed} />
          </div>
        </nav>
      </div>
      <QuickAdd open={quickAdd} onClose={() => setQuickAdd(false)} />
    </QuickAddContext.Provider>
  );
}

function SideLink({ to, label, icon: Icon, end, badge }: { to: string; label: string; icon: typeof Home; end?: boolean; badge?: number }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx(
          "flex h-10 items-center gap-3 rounded-[10px] px-3 text-[15px] transition-colors",
          isActive ? "bg-accent-soft font-medium text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
        )
      }
    >
      <Icon size={18} aria-hidden />
      {label}
      <Badge n={badge ?? 0} />
    </NavLink>
  );
}

function TabLink({
  to,
  label,
  icon: Icon,
  end,
  badge,
  forceActive,
}: {
  to: string;
  label: string;
  icon: typeof Home;
  end?: boolean;
  badge?: number;
  forceActive?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx(
          "relative flex flex-col items-center gap-0.5 pb-2 pt-2.5 text-[11px] font-medium",
          isActive || forceActive ? "text-accent" : "text-ink-3",
        )
      }
    >
      <Icon size={22} aria-hidden />
      {label}
      {badge ? <span className="absolute right-[22%] top-1.5 h-2 w-2 rounded-full bg-warn" aria-label={`${badge} need attention`} /> : null}
    </NavLink>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-2 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
