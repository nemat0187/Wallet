import { useEffect, useState, lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get } from "./lib/api";
import { Spinner } from "./lib/ui";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Activity from "./pages/Activity";

/** After a new version is deployed, old page files disappear; reload once to pick up the new ones. */
function page<T extends { default: React.ComponentType }>(load: () => Promise<T>) {
  return lazy(() =>
    load().catch((err) => {
      const key = "wallet-reloaded-at";
      const last = Number(sessionStorage.getItem(key) ?? 0);
      if (Date.now() - last > 30_000) {
        sessionStorage.setItem(key, String(Date.now()));
        window.location.reload();
      }
      throw err;
    }),
  );
}

const Budgets = page(() => import("./pages/Budgets"));
const Insights = page(() => import("./pages/Insights"));
const Analytics = page(() => import("./pages/Analytics"));
const Categories = page(() => import("./pages/Categories"));
const Merchants = page(() => import("./pages/Merchants"));
const Accounts = page(() => import("./pages/Accounts"));
const InboxPage = page(() => import("./pages/Inbox"));
const ImportPage = page(() => import("./pages/Import"));
const SettingsPage = page(() => import("./pages/Settings"));
const More = page(() => import("./pages/More"));

export default function App() {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => get<{ authenticated: boolean; password_configured: boolean }>("/auth/me"),
    staleTime: Infinity,
  });
  // null = follow the server's answer; true/false = what happened in this tab since.
  const [authed, setAuthed] = useState<boolean | null>(null);
  const dropCachedData = () => qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });

  useEffect(() => {
    const onLogout = () => {
      setAuthed(false);
      dropCachedData();
    };
    window.addEventListener("wallet:logged-out", onLogout);
    return () => window.removeEventListener("wallet:logged-out", onLogout);
  });

  if (me.isLoading) return <Spinner label="Opening your wallet" />;
  if (!(authed ?? me.data?.authenticated)) {
    return (
      <Login
        passwordConfigured={me.data?.password_configured ?? true}
        onLoggedIn={() => {
          dropCachedData();
          setAuthed(true);
        }}
      />
    );
  }

  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="activity" element={<Activity />} />
          <Route path="budgets" element={<Budgets />} />
          <Route path="insights" element={<Insights />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="categories" element={<Categories />} />
          <Route path="merchants" element={<Merchants />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="more" element={<More />} />
          <Route path="*" element={<Dashboard />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
