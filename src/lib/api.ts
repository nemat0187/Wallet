// Tiny JSON client for the worker API. Same-origin cookies carry the session.

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export async function api<T = unknown>(path: string, method: Method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/auth/login")) {
    window.dispatchEvent(new Event("wallet:logged-out"));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, "POST", body);
export const patch = <T>(path: string, body: unknown) => api<T>(path, "PATCH", body);
export const put = <T>(path: string, body: unknown) => api<T>(path, "PUT", body);
export const del = <T>(path: string) => api<T>(path, "DELETE");
