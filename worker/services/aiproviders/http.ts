// Calling provider REST APIs with timeouts and friendly errors.

import type { Provider } from "./types";
import { ProviderError, PROVIDER_LABEL, httpError } from "./types";

export async function postJson<T>(provider: Provider, url: string, headers: Record<string, string>, body: unknown, timeoutMs = 120_000, fetchFn: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
    throw new ProviderError(provider, timedOut ? "timeout" : "server", timedOut ? `${PROVIDER_LABEL[provider]} took too long to answer. Please try again.` : `${PROVIDER_LABEL[provider]} could not be reached. Please try again in a moment.`);
  }
  if (!res.ok) throw httpError(provider, res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

/** Run a tool the model asked for. Bad input or a failing tool is reported back to the model, not thrown. */
export async function runTool(
  tool: { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[]; message: string }[] } } }; run: (a: never) => Promise<string> },
  args: unknown,
): Promise<string> {
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) return `Invalid input: ${parsed.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
  try {
    return await tool.run(parsed.data as never);
  } catch (e) {
    return `The lookup failed: ${(e as Error).message}`;
  }
}
