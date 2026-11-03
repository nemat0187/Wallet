// What every AI provider (Claude, ChatGPT, Gemini) has to offer the rest of the app.

import type { z } from "zod";

export type Provider = "anthropic" | "openai" | "gemini";
export const PROVIDERS: Provider[] = ["anthropic", "openai", "gemini"];
export const PROVIDER_LABEL: Record<Provider, string> = { anthropic: "Claude", openai: "ChatGPT", gemini: "Gemini" };
export const isProvider = (v: unknown): v is Provider => PROVIDERS.includes(v as Provider);

/** A key (the user's own, or the owner's installation key) and where to send requests. */
export interface Credentials {
  provider: Provider;
  apiKey: string;
  /** Testing and gateways only. */
  baseUrl?: string;
}

export type Part = { type: "text"; text: string } | { type: "pdf"; base64: string };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export type Effort = "low" | "medium" | "high";

export interface StructuredRequest<T extends z.ZodType> {
  model: string;
  system: string;
  content: string | Part[];
  schema: T;
  maxTokens: number;
  effort: Effort;
  timeoutMs?: number;
}

export interface StructuredResult<T> {
  /** null when the model declined or could not produce valid JSON */
  data: T | null;
  usage: Usage;
  model: string;
}

/** A question the assistant may ask the app (the same three tools for every provider). */
export interface ChatTool {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (args: never) => Promise<string>;
}

export interface ChatRequest {
  model: string;
  system: string;
  /** Changes every day, so it comes after the cacheable part. */
  context: string;
  history: { role: "user" | "assistant"; content: string }[];
  tools: ChatTool[];
  maxIterations: number;
  onUsage: (model: string, usage: Usage) => Promise<void>;
}

export type ChatResult = { reply: string } | { refused: true };

export interface Adapter {
  structured<T extends z.ZodType>(creds: Credentials, req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>>;
  chat(creds: Credentials, req: ChatRequest): Promise<ChatResult>;
}

export type ErrorKind = "auth" | "quota" | "model" | "bad_request" | "server" | "timeout";

/** A provider problem with a message that is safe to show to the user. */
export class ProviderError extends Error {
  constructor(
    readonly provider: Provider,
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
  }
  /** Something the user can fix themselves (shown as a 400), as opposed to a provider outage (502). */
  get userFixable() {
    return this.kind === "auth" || this.kind === "quota" || this.kind === "model";
  }
}

/** The human part of a provider's JSON error body, if it has one. */
function errorMessage(detail: string): string {
  try {
    const j = JSON.parse(detail) as { error?: { message?: string } | string; message?: string };
    return (typeof j.error === "string" ? j.error : j.error?.message) ?? j.message ?? "";
  } catch {
    return detail;
  }
}

export function httpError(provider: Provider, status: number, detail = ""): ProviderError {
  const name = PROVIDER_LABEL[provider];
  const message = errorMessage(detail);
  const rejectedKey = new ProviderError(provider, "auth", `${name} rejected your API key. Check it in Settings → AI and paste it again.`);
  // Gemini answers a wrong key with 400 "API key not valid", not 401.
  if (status === 401 || status === 403 || (status === 400 && /api key not valid|api_key_invalid|invalid api key|incorrect api key/i.test(`${detail} ${message}`))) return rejectedKey;
  if (status === 429) return new ProviderError(provider, "quota", `Your ${name} account has run out of quota or credit, or is sending too many requests. Check your plan and billing with ${name}.`);
  if (status === 404) return new ProviderError(provider, "model", `${name} doesn't know the chosen model. Pick another model in Settings → AI.`);
  if (status === 400) return new ProviderError(provider, "bad_request", `${name} refused the request${message ? `: ${message.slice(0, 200)}` : ""}.`);
  return new ProviderError(provider, "server", `${name} is having trouble right now (${status}). Please try again in a moment.`);
}
