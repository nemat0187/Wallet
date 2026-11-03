import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ShieldCheck, Trash2, UserCheck, UserX, X } from "lucide-react";
import { del, get, post, put } from "../lib/api";
import { useBootstrap } from "../lib/data";
import { Button, Empty, ErrorNote, Spinner, Toggle, clsx, errorText, useToast } from "../lib/ui";
import { PageHeader } from "../components/Layout";

interface AdminUser {
  id: number;
  email: string | null;
  name: string;
  role: "admin" | "user";
  status: "pending" | "active" | "disabled";
  created_at: string;
  approved_at: string | null;
}

const STATUS = {
  pending: { label: "Waiting", cls: "bg-warn-soft text-warn" },
  active: { label: "Active", cls: "bg-good-soft text-good" },
  disabled: { label: "Switched off", cls: "bg-surface-2 text-ink-3" },
} as const;

export default function Admin() {
  const boot = useBootstrap();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["admin-users"], queryFn: () => get<{ users: AdminUser[]; registration_open: boolean }>("/admin/users"), enabled: boot.data?.user?.role === "admin" });
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-users"] });
    qc.invalidateQueries({ queryKey: ["bootstrap"] });
  };
  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: "approve" | "reject" | "disable" | "enable" | "delete" }) =>
      action === "delete" ? del(`/admin/users/${id}`) : post(`/admin/users/${id}/${action}`),
    onSuccess: (_r, v) => {
      toast({ approve: "Approved. They can sign in now.", reject: "Request removed", disable: "Access switched off", enable: "Access switched on", delete: "User and their data deleted" }[v.action]);
      setConfirmDelete(null);
      refresh();
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  const registration = useMutation({
    mutationFn: (open: boolean) => put("/admin/registration", { open }),
    onSuccess: refresh,
    onError: (e) => toast(errorText(e), "error"),
  });

  if (boot.data && boot.data.user?.role !== "admin") return <Empty title="Admins only">This page is for the owner of this wallet.</Empty>;
  if (!list.data) return list.error ? <ErrorNote error={list.error} /> : <Spinner />;
  const { users, registration_open } = list.data;
  const me = boot.data?.user?.id;

  return (
    <div className="max-w-3xl">
      <PageHeader title="Users & access" subtitle="Approve people who ask for access and switch accounts on or off" />

      <section className="mt-5 rounded-3xl border border-line bg-surface px-5 py-1 sm:px-6">
        <Toggle
          checked={registration_open}
          onChange={(open) => registration.mutate(open)}
          label="Accept new sign-up requests"
          hint="When on, someone who continues with Google is added to the list below as waiting. Nobody gets in until you approve them. When off, only people already on the list can sign in."
        />
      </section>

      <ul className="mt-5 flex flex-col divide-y divide-line rounded-3xl border border-line bg-surface">
        {users.map((u) => (
          <li key={u.id} className="px-5 py-4 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  <span className="truncate">{u.name || u.email || "Owner"}</span>
                  {u.role === "admin" && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[12px] font-medium text-accent">
                      <ShieldCheck size={12} aria-hidden /> Admin
                    </span>
                  )}
                  {u.id === me && <span className="text-[13px] font-normal text-ink-3">(you)</span>}
                </p>
                <p className="truncate text-sm text-ink-3">{u.email ?? "No email linked yet"}</p>
              </div>
              <span className={clsx("rounded-full px-2.5 py-1 text-[12px] font-semibold", STATUS[u.status].cls)}>{STATUS[u.status].label}</span>
            </div>

            {u.id !== me && u.id !== 1 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {u.status === "pending" && (
                  <>
                    <Button size="sm" variant="primary" loading={act.isPending && act.variables?.id === u.id && act.variables.action === "approve"} onClick={() => act.mutate({ id: u.id, action: "approve" })}>
                      <Check size={16} /> Approve
                    </Button>
                    <Button size="sm" onClick={() => act.mutate({ id: u.id, action: "reject" })}>
                      <X size={16} /> Reject
                    </Button>
                  </>
                )}
                {u.status === "active" && (
                  <Button size="sm" onClick={() => act.mutate({ id: u.id, action: "disable" })}>
                    <UserX size={16} /> Switch off
                  </Button>
                )}
                {u.status === "disabled" && (
                  <Button size="sm" onClick={() => act.mutate({ id: u.id, action: "enable" })}>
                    <UserCheck size={16} /> Switch on
                  </Button>
                )}
                {u.status !== "pending" &&
                  (confirmDelete === u.id ? (
                    <>
                      <Button size="sm" variant="danger" onClick={() => act.mutate({ id: u.id, action: "delete" })}>
                        Yes, delete everything of theirs
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(u.id)}>
                      <Trash2 size={16} /> Delete
                    </Button>
                  ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
