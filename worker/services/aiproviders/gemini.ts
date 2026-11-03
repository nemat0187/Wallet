// Gemini: the generateContent API over fetch (JSON response mode, function calling, PDF as inline data).

import type { z } from "zod";
import type { Adapter, ChatRequest, ChatResult, Credentials, Part, StructuredRequest, StructuredResult, Usage } from "./types";
import { hostOf } from "./models";
import { jsonSchemaOf, schemaInstruction, toGeminiSchema, validate } from "./schema";
import { postJson, runTool } from "./http";

type GPart = { text?: string; inline_data?: { mime_type: string; data: string }; functionCall?: { name: string; args?: unknown }; functionResponse?: { name: string; response: unknown } };
interface Response_ {
  candidates?: { finishReason?: string; content?: { parts?: GPart[] } }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  modelVersion?: string;
}

export function usageOf(r: Response_): Usage {
  const cached = r.usageMetadata?.cachedContentTokenCount ?? 0;
  return {
    input_tokens: Math.max(0, (r.usageMetadata?.promptTokenCount ?? 0) - cached),
    // Thinking tokens are billed and counted as output.
    output_tokens: (r.usageMetadata?.candidatesTokenCount ?? 0) + (r.usageMetadata?.thoughtsTokenCount ?? 0),
    cache_read_input_tokens: cached,
  };
}

function parts(content: string | Part[]): GPart[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((p) => (p.type === "text" ? { text: p.text } : { inline_data: { mime_type: "application/pdf", data: p.base64 } }));
}

const textOf = (r: Response_) =>
  (r.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();

const blocked = (r: Response_) => Boolean(r.promptFeedback?.blockReason) || ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(r.candidates?.[0]?.finishReason ?? "");

const call = (c: Credentials, model: string, body: unknown, timeoutMs?: number) =>
  postJson<Response_>("gemini", `${hostOf(c)}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": c.apiKey }, body, timeoutMs);

export const geminiAdapter: Adapter = {
  async structured<T extends z.ZodType>(creds: Credentials, req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    const contents: { role: string; parts: GPart[] }[] = [{ role: "user", parts: parts(req.content) }];
    const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    let model = req.model;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await call(
        creds,
        req.model,
        {
          systemInstruction: { parts: [{ text: `${req.system}\n\n${schemaInstruction(req.schema)}` }] },
          contents,
          // Thinking models count their thinking against the limit, so leave room for it.
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: Math.max(req.maxTokens, 8192) },
        },
        req.timeoutMs,
      );
      const u = usageOf(res);
      usage.input_tokens += u.input_tokens;
      usage.output_tokens += u.output_tokens;
      usage.cache_read_input_tokens = (usage.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      model = res.modelVersion ?? model;
      if (blocked(res) || res.candidates?.[0]?.finishReason === "MAX_TOKENS") return { data: null, usage, model };
      const text = textOf(res);
      const checked = validate(req.schema, text);
      if (checked.ok) return { data: checked.data, usage, model };
      contents.push({ role: "model", parts: [{ text }] }, { role: "user", parts: [{ text: `That was not valid: ${checked.error}. Reply again with only the corrected JSON object.` }] });
    }
    return { data: null, usage, model };
  },

  async chat(creds: Credentials, req: ChatRequest): Promise<ChatResult> {
    const declarations = req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(jsonSchemaOf(t.schema)) }));
    const contents: { role: string; parts: GPart[] }[] = req.history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    for (let i = 0; i <= req.maxIterations; i++) {
      const last = i === req.maxIterations;
      const res = await call(creds, req.model, {
        systemInstruction: { parts: [{ text: `${req.system}\n\n${req.context}` }] },
        contents,
        tools: [{ functionDeclarations: declarations }],
        toolConfig: { functionCallingConfig: { mode: last ? "NONE" : "AUTO" } },
        generationConfig: { maxOutputTokens: 8192 },
      });
      await req.onUsage(res.modelVersion ?? req.model, usageOf(res));
      if (blocked(res)) return { refused: true };
      const modelParts = res.candidates?.[0]?.content?.parts ?? [];
      const calls = modelParts.filter((p) => p.functionCall);
      if (!calls.length || last) return { reply: textOf(res) };
      contents.push({ role: "model", parts: modelParts });
      const answers: GPart[] = [];
      for (const p of calls) {
        const c = p.functionCall!;
        const tool = req.tools.find((t) => t.name === c.name);
        answers.push({ functionResponse: { name: c.name, response: { result: tool ? await runTool(tool, c.args) : `Unknown tool ${c.name}` } } });
      }
      contents.push({ role: "user", parts: answers });
    }
    return { reply: "" };
  },
};
