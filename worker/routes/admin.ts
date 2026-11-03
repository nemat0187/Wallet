// Admin: approve or reject sign-up requests, switch users on and off, open or close sign-ups.
// Admins manage accounts only; this API never returns anyone's financial data.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { body, notFound } from "../lib/http";
import { all, first, nowIso, run } from "../lib/db";
import { PER_USER_TABLES, rawDb, userIdOf } from "../lib/scoped";
import { getSetting, setSetting } from "../services/settings";

const app = new Hono<AppEnv>();

app.use("/*", async (c, next) => {
  if (c.get("role") !== "admin") throw new HTTPException(403, { message: "Admins only" });
  await next();
});

interface UserRow {
  id: number;
  email: string | null;
  name: string;
  role: "admin" | "user";
  status: "pending" | "active" | "disabled";
  created_at: string;
  approved_at: string | null;
}

app.get("/users", async (c) => {
  const db = rawDb(c.env);
  const users = await all<UserRow>(db, "SELECT id, email, name, role, status, created_at, approved_at FROM users ORDER BY (status = 'pending') DESC, id");
  return c.json({ users, registration_open: (await getSetting(db, "registration_open")) === "1" });
});

app.put("/registration", async (c) => {
  const { open } = await body(c, z.object({ open: z.boolean() }));
  await setSetting(rawDb(c.env), "registration_open", open ? "1" : "0");
  return c.json({ ok: true, registration_open: open });
});

async function target(c: { env: AppEnv["Bindings"]; req: { param: (n: string) => string } }, allowSelf = false): Promise<UserRow> {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) notFound();
  if (!allowSelf && id === userIdOf(c.env)) throw new HTTPException(400, { message: "You can't do this to your own account" });
  if (id === 1) throw new HTTPException(400, { message: "The owner account can't be changed" });
  const row = await first<UserRow>(rawDb(c.env), "SELECT id, email, name, role, status, created_at, approved_at FROM users WHERE id = ?", id);
  if (!row) notFound();
  return row;
}

app.post("/users/:id/approve", async (c) => {
  const u = await target(c);
  if (u.status !== "pending") throw new HTTPException(400, { message: "This request was already answered" });
  await run(rawDb(c.env), "UPDATE users SET status = 'active', approved_at = ? WHERE id = ?", nowIso(), u.id);
  return c.json({ ok: true });
});

/** Rejecting a request removes it (the person can ask again later). */
app.post("/users/:id/reject", async (c) => {
  const u = await target(c);
  if (u.status !== "pending") throw new HTTPException(400, { message: "Only waiting requests can be rejected" });
  await run(rawDb(c.env), "DELETE FROM users WHERE id = ?", u.id);
  return c.json({ ok: true });
});

app.post("/users/:id/disable", async (c) => {
  const u = await target(c);
  await run(rawDb(c.env), "UPDATE users SET status = 'disabled' WHERE id = ?", u.id);
  await run(rawDb(c.env), "DELETE FROM sessions WHERE user_id = ?", u.id);
  return c.json({ ok: true });
});

app.post("/users/:id/enable", async (c) => {
  const u = await target(c);
  if (u.status === "pending") throw new HTTPException(400, { message: "Approve the request instead" });
  await run(rawDb(c.env), "UPDATE users SET status = 'active', approved_at = COALESCE(approved_at, ?) WHERE id = ?", nowIso(), u.id);
  return c.json({ ok: true });
});

app.post("/users/:id/role", async (c) => {
  const u = await target(c);
  const { role } = await body(c, z.object({ role: z.enum(["admin", "user"]) }));
  await run(rawDb(c.env), "UPDATE users SET role = ? WHERE id = ?", role, u.id);
  return c.json({ ok: true });
});

/** Remove a user and everything that belongs to them. */
app.delete("/users/:id", async (c) => {
  const u = await target(c);
  const db = rawDb(c.env);
  await db.batch([
    ...PER_USER_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(u.id)),
    db.prepare("DELETE FROM user_settings WHERE user_id = ?").bind(u.id),
    db.prepare("DELETE FROM users WHERE id = ?").bind(u.id),
  ]);
  return c.json({ ok: true });
});

export default app;
