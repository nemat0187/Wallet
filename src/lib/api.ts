// Tiny JSON client for the worker API. In the browser, same-origin cookies carry the session.
// In an app shell that bundles the web app (build with VITE_API_BASE=https://your-wallet.workers.dev) there are no
// usable cookies: the client sends "x-client: app", keeps the session token it is given and sends it as a Bearer token.

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? "").replace(/\/+$/, "");
const TOKEN_KEY = "wallet_app_token";
let pendingMfa: string | null = null;

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function keepToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the session just won't survive a restart */
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export async function api<T = unknown>(path: string, method: Method = "GET", body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (API_BASE) {
    headers["x-client"] = "app";
    const token = storedToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (path === "/auth/mfa/verify" && pendingMfa && body && typeof body === "object") body = { ...body, mfa_token: pendingMfa };
  }
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    credentials: API_BASE ? "omit" : "same-origin",
    headers: Object.keys(headers).length ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/auth/login")) {
    window.dispatchEvent(new Event("wallet:logged-out"));
  }
  const data = await res.json().catch(() => ({}));
  if (API_BASE) {
    const d = data as { token?: string; mfa_token?: string };
    if (d.mfa_token) pendingMfa = d.mfa_token;
    if (d.token) {
      keepToken(d.token);
      pendingMfa = null;
    }
    if (path === "/auth/logout" || res.status === 401) keepToken(null);
  }
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, "POST", body);
export const patch = <T>(path: string, body: unknown) => api<T>(path, "PATCH", body);
export const put = <T>(path: string, body: unknown) => api<T>(path, "PUT", body);
export const del = <T>(path: string) => api<T>(path, "DELETE");
