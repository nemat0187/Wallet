// Claude, through the official SDK (structured outputs, refusal fallbacks, prompt caching, tool runner).

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { Adapter, ChatRequest, ChatResult, Credentials, Part, StructuredRequest, StructuredResult } from "./types";

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

export function fallbackParams(model: string): { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: "default" } {
  return FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};
}

export const client = (c: Credentials) => new Anthropic({ apiKey: c.apiKey, baseURL: c.baseUrl || undefined, maxRetries: 2, timeout: 120_000 });

function blocks(content: string | Part[]): string | Anthropic.Beta.BetaContentBlockParam[] {
  if (typeof content === "string") return content;
  return content.map((p) =>
    p.type === "text"
      ? { type: "text" as const, text: p.text }
      : { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: p.base64 } },
  );
}

export const anthropicAdapter: Adapter = {
  async structured<T extends z.ZodType>(creds: Credentials, req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    const res = await client(creds).beta.messages.parse(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: blocks(req.content) }],
        output_config: { format: betaZodOutputFormat(req.schema), effort: req.effort },
        ...fallbackParams(req.model),
      },
      req.timeoutMs ? { timeout: req.timeoutMs } : undefined,
    );
    const ok = res.stop_reason !== "refusal" && res.stop_reason !== "max_tokens";
    return { data: ok ? ((res.parsed_output as z.infer<T> | null) ?? null) : null, usage: res.usage, model: res.model ?? req.model };
  },

  async chat(creds: Credentials, req: ChatRequest): Promise<ChatResult> {
    const runner = client(creds).beta.messages.toolRunner({
      model: req.model,
      max_tokens: 16000,
      system: [
        // The instructions and tools stay cached; the date-dependent block comes after the cache breakpoint.
        { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
        { type: "text", text: req.context },
      ],
      tools: req.tools.map((t) => betaZodTool({ name: t.name, description: t.description, inputSchema: t.schema as z.ZodObject, run: t.run as (a: unknown) => Promise<string> })),
      messages: req.history.map((m) => ({ role: m.role, content: m.content })),
      output_config: { effort: "low" },
      thread: false,
      max_iterations: req.maxIterations,
      ...fallbackParams(req.model),
    });
    let reply = "";
    for await (const message of runner) {
      await req.onUsage(message.model ?? req.model, message.usage);
      if (message.stop_reason === "refusal") return { refused: true };
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) reply = text;
    }
    return { reply };
  },
};
