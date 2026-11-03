// Asking a provider which models a key can use (this also proves the key works), and picking sensible defaults.

import type { Credentials, Provider } from "./types";
import { ProviderError, httpError } from "./types";

export const DEFAULT_HOSTS: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
};

export const hostOf = (c: Credentials) => (c.baseUrl || DEFAULT_HOSTS[c.provider]).replace(/\/+$/, "");

/** OpenAI lists everything it offers; keep the models that can chat. */
export function isOpenAiChatModel(id: string): boolean {
  if (/embedding|whisper|tts|dall-e|moderation|image|realtime|audio|transcribe|search|computer-use|davinci|babbage|instruct/i.test(id)) return false;
  return /^(gpt-|chatgpt|o\d)/i.test(id);
}

export async function listModels(creds: Credentials, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const host = hostOf(creds);
  let res: Response;
  try {
    if (creds.provider === "anthropic") {
      res = await fetchFn(`${host}/v1/models?limit=100`, { headers: { "x-api-key": creds.apiKey, "anthropic-version": "2023-06-01" } });
    } else if (creds.provider === "openai") {
      res = await fetchFn(`${host}/v1/models`, { headers: { authorization: `Bearer ${creds.apiKey}` } });
    } else {
      res = await fetchFn(`${host}/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": creds.apiKey } });
    }
  } catch {
    throw new ProviderError(creds.provider, "server", "Couldn't reach the provider to check your key. Try again in a moment.");
  }
  if (!res.ok) throw httpError(creds.provider, res.status, await res.text().catch(() => ""));
  const data = (await res.json()) as { data?: { id: string }[]; models?: { name: string; supportedGenerationMethods?: string[] }[] };
  let ids: string[];
  if (creds.provider === "gemini") {
    ids = (data.models ?? []).filter((m) => (m.supportedGenerationMethods ?? ["generateContent"]).includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
    ids = ids.filter((id) => /^gemini/i.test(id) && !/embedding|aqa|imagen|veo|tts|live|image/i.test(id));
  } else {
    ids = (data.data ?? []).map((m) => m.id);
    if (creds.provider === "openai") ids = ids.filter(isOpenAiChatModel);
  }
  return [...new Set(ids)].sort();
}

/**
 * A cheap model for everyday work and a stronger one for reports and questions, chosen by name from the user's own
 * list (model names change too often to hardcode). Returns null for a role when nothing fits.
 */
export function pickDefaults(provider: Provider, models: string[]): { fast: string | null; smart: string | null } {
  const rank = (id: string, words: RegExp[]) => {
    const i = words.findIndex((w) => w.test(id));
    return i === -1 ? Infinity : i;
  };
  const newest = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });
  const best = (words: RegExp[], avoid: RegExp) => {
    const hits = models.filter((m) => !avoid.test(m) && rank(m, words) !== Infinity);
    hits.sort((a, b) => rank(a, words) - rank(b, words) || newest(a, b));
    return hits[0] ?? null;
  };
  const avoid = /preview|exp|latest|-\d{4}-\d{2}-\d{2}$|-\d{8}$|thinking|vision|pro-/i;
  if (provider === "anthropic") return { fast: best([/haiku/], avoid) ?? best([/haiku/], /^$/), smart: best([/opus/, /sonnet/], avoid) ?? best([/opus/, /sonnet/], /^$/) };
  if (provider === "openai") return { fast: best([/mini/, /nano/], avoid) ?? best([/mini/, /nano/], /^$/), smart: best([/^gpt-\d(\.\d)?$/, /^gpt-\d/, /^o\d$/], /mini|nano|preview|codex/i) ?? best([/^gpt-/], /mini|nano/i) };
  return { fast: best([/flash-lite/, /flash/], avoid) ?? best([/flash/], /^$/), smart: best([/pro/, /flash/], /preview|exp|lite/i) ?? best([/pro/], /^$/) };
}
