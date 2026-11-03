// ChatGPT: the Chat Completions API over fetch. Structured answers use JSON mode plus a schema in the prompt,
// checked with zod (one retry that quotes the problem); tool use is the function-calling loop.

import type { z } from "zod";
import type { Adapter, ChatRequest, ChatResult, Credentials, Part, StructuredRequest, StructuredResult, Usage } from "./types";
import { hostOf } from "./models";
import { jsonSchemaOf, schemaInstruction, validate } from "./schema";
import { postJson, runTool } from "./http";

interface Completion {
  model?: string;
  choices?: { finish_reason?: string; message?: { role: string; content?: string | null; refusal?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

const reasoning = (model: string) => /^(o\d|gpt-5)/i.test(model);

export function usageOf(c: Completion): Usage {
  const cached = c.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return { input_tokens: Math.max(0, (c.usage?.prompt_tokens ?? 0) - cached), output_tokens: c.usage?.completion_tokens ?? 0, cache_read_input_tokens: cached };
}

function userContent(content: string | Part[]): unknown {
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "file", file: { filename: "statement.pdf", file_data: `data:application/pdf;base64,${p.base64}` } }));
}

/** Request fields that differ between model families: reasoning models count thinking against the token limit. */
export function modelParams(model: string, maxTokens: number, effort: string): Record<string, unknown> {
  return reasoning(model) ? { max_completion_tokens: Math.max(maxTokens, 4096), reasoning_effort: effort } : { max_completion_tokens: maxTokens };
}

const call = (c: Credentials, body: unknown, timeoutMs?: number) =>
  postJson<Completion>("openai", `${hostOf(c)}/v1/chat/completions`, { authorization: `Bearer ${c.apiKey}` }, body, timeoutMs);

export const openaiAdapter: Adapter = {
  async structured<T extends z.ZodType>(creds: Credentials, req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    const messages: unknown[] = [
      { role: "system", content: `${req.system}\n\n${schemaInstruction(req.schema)}` },
      { role: "user", content: userContent(req.content) },
    ];
    const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    let model = req.model;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await call(creds, { model: req.model, messages, response_format: { type: "json_object" }, ...modelParams(req.model, req.maxTokens, req.effort) }, req.timeoutMs);
      const u = usageOf(res);
      usage.input_tokens += u.input_tokens;
      usage.output_tokens += u.output_tokens;
      usage.cache_read_input_tokens = (usage.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      model = res.model ?? model;
      const choice = res.choices?.[0];
      if (choice?.message?.refusal || choice?.finish_reason === "content_filter") return { data: null, usage, model };
      if (choice?.finish_reason === "length") return { data: null, usage, model };
      const text = choice?.message?.content ?? "";
      const checked = validate(req.schema, text);
      if (checked.ok) return { data: checked.data, usage, model };
      messages.push({ role: "assistant", content: text }, { role: "user", content: `That was not valid: ${checked.error}. Reply again with only the corrected JSON object.` });
    }
    return { data: null, usage, model };
  },

  async chat(creds: Credentials, req: ChatRequest): Promise<ChatResult> {
    const tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: jsonSchemaOf(t.schema) } }));
    const messages: unknown[] = [{ role: "system", content: `${req.system}\n\n${req.context}` }, ...req.history.map((m) => ({ role: m.role, content: m.content }))];
    for (let i = 0; i <= req.maxIterations; i++) {
      const last = i === req.maxIterations; // out of lookups: ask for the answer with what we have
      const res = await call(creds, { model: req.model, messages, tools, tool_choice: last ? "none" : "auto", ...modelParams(req.model, 8000, "low") });
      await req.onUsage(res.model ?? req.model, usageOf(res));
      const msg = res.choices?.[0]?.message;
      if (msg?.refusal) return { refused: true };
      const calls = msg?.tool_calls ?? [];
      if (!calls.length || last) return { reply: (msg?.content ?? "").trim() };
      messages.push({ role: "assistant", content: msg?.content ?? null, tool_calls: calls });
      for (const c of calls) {
        const tool = req.tools.find((t) => t.name === c.function.name);
        let args: unknown = {};
        try {
          args = JSON.parse(c.function.arguments || "{}");
        } catch {
          args = null;
        }
        messages.push({ role: "tool", tool_call_id: c.id, content: tool ? await runTool(tool, args) : `Unknown tool ${c.function.name}` });
      }
    }
    return { reply: "" };
  },
};
