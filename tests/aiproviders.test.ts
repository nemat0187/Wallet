import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { extractJson, jsonSchemaOf, toGeminiSchema, validate } from "../worker/services/aiproviders/schema";
import { modelParams, openaiAdapter } from "../worker/services/aiproviders/openai";
import { geminiAdapter } from "../worker/services/aiproviders/gemini";
import { runTool } from "../worker/services/aiproviders/http";
import type { ChatTool } from "../worker/services/aiproviders/types";

afterEach(() => vi.unstubAllGlobals());

/** Replace the network: each call gets the next reply; every request is recorded. */
function fakeNetwork(...replies: unknown[]) {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(replies[Math.min(i++, replies.length - 1)]), { status: 200 });
  });
  return seen;
}

const Schema = z.object({ merchant: z.string(), amount: z.number(), note: z.string().nullable().optional(), kind: z.enum(["in", "out"]) });
const creds = (provider: "openai" | "gemini") => ({ provider, apiKey: "KEY123", baseUrl: "https://mock.test" });
const structuredReq = (model: string, content: any = "read this") => ({ model, system: "You read things.", content, schema: Schema, maxTokens: 1000, effort: "low" as const });

describe("JSON handling", () => {
  it("finds JSON inside fences and sentences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":{"b":2}} Hope that helps.')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json here")).toThrow();
  });
  it("explains what is wrong", () => {
    const bad = validate(Schema, '{"merchant":"X","amount":"ten","kind":"sideways"}');
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toMatch(/amount/);
    expect(validate(Schema, '{"merchant":"X","amount":10,"kind":"in"}').ok).toBe(true);
  });
  it("Gemini schema: nullable instead of anyOf, no unsupported keys", () => {
    const g = toGeminiSchema(jsonSchemaOf(z.object({ text: z.string().nullable().optional().describe("Substring"), limit: z.number().int().min(1).max(40).default(20), kind: z.enum(["expense", "income"]) })));
    const json = JSON.stringify(g);
    expect(json).not.toMatch(/anyOf|additionalProperties|\$schema|default|"format"/);
    expect((g.properties as any).text).toMatchObject({ type: "string", nullable: true, description: "Substring" });
    expect((g.properties as any).limit).toMatchObject({ type: "integer", minimum: 1, maximum: 40 });
    expect((g.properties as any).kind.enum).toEqual(["expense", "income"]);
    expect(g.required).toContain("kind");
  });
});

describe("OpenAI structured", () => {
  const ok = (content: string, extra: object = {}) => ({ model: "gpt-5-mini-2026", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } }, ...extra });
  it("sends JSON mode with the schema, the key and the right token parameter", async () => {
    const seen = fakeNetwork(ok('{"merchant":"Bravo","amount":12.5,"kind":"out"}'));
    const r = await openaiAdapter.structured(creds("openai"), structuredReq("gpt-5-mini"));
    expect(r.data).toEqual({ merchant: "Bravo", amount: 12.5, kind: "out" });
    expect(seen[0].url).toBe("https://mock.test/v1/chat/completions");
    expect(seen[0].headers.authorization).toBe("Bearer KEY123");
    expect(seen[0].body.response_format).toEqual({ type: "json_object" });
    expect(seen[0].body.messages[0].content).toContain('"merchant"');
    expect(seen[0].body.max_completion_tokens).toBeGreaterThanOrEqual(4096);
    expect(seen[0].body.reasoning_effort).toBe("low");
    expect(r.usage).toMatchObject({ input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20 });
    expect(r.model).toBe("gpt-5-mini-2026");
  });
  it("does not send reasoning settings to models that don't take them", () => {
    expect(modelParams("gpt-4o", 1000, "low")).toEqual({ max_completion_tokens: 1000 });
    expect(modelParams("o3", 1000, "high")).toMatchObject({ reasoning_effort: "high" });
  });
  it("attaches a PDF as a file part", async () => {
    const seen = fakeNetwork(ok('{"merchant":"X","amount":1,"kind":"in"}'));
    await openaiAdapter.structured(creds("openai"), structuredReq("gpt-4o", [{ type: "pdf", base64: "QUJD" }, { type: "text", text: "list rows" }]));
    const user = seen[0].body.messages[1].content;
    expect(user[0]).toEqual({ type: "file", file: { filename: "statement.pdf", file_data: "data:application/pdf;base64,QUJD" } });
    expect(user[1]).toEqual({ type: "text", text: "list rows" });
  });
  it("retries once with the problem quoted, and adds up the usage", async () => {
    const seen = fakeNetwork(ok("not json at all"), ok('{"merchant":"Y","amount":2,"kind":"in"}'));
    const r = await openaiAdapter.structured(creds("openai"), structuredReq("gpt-4o"));
    expect(r.data?.merchant).toBe("Y");
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen[1].body.messages)).toContain("That was not valid");
    expect(r.usage.output_tokens).toBe(60);
  });
  it("gives up after one retry, and treats truncation or refusal as no answer", async () => {
    expect((await (fakeNetwork(ok("nope"), ok("still nope")), openaiAdapter.structured(creds("openai"), structuredReq("gpt-4o")))).data).toBeNull();
    fakeNetwork({ choices: [{ finish_reason: "length", message: { role: "assistant", content: '{"merchant":"cut' } }], usage: {} });
    expect((await openaiAdapter.structured(creds("openai"), structuredReq("gpt-4o"))).data).toBeNull();
    fakeNetwork({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: null, refusal: "no" } }], usage: {} });
    expect((await openaiAdapter.structured(creds("openai"), structuredReq("gpt-4o"))).data).toBeNull();
  });
});

describe("OpenAI chat with tools", () => {
  it("runs a lookup the model asks for, then answers", async () => {
    const run = vi.fn(async (a: { days: number; kind: string }) => `spent 42 over ${a.days} days (${a.kind})`);
    const tool: ChatTool = { name: "spending", description: "totals", schema: z.object({ days: z.number(), kind: z.string().default("expense") }), run: run as never };
    const seen = fakeNetwork(
      { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "spending", arguments: '{"days":7}' } }] } }], usage: { prompt_tokens: 50, completion_tokens: 10 } },
      { choices: [{ message: { role: "assistant", content: "You spent 42 AZN." } }], usage: { prompt_tokens: 80, completion_tokens: 8 } },
    );
    const usages: number[] = [];
    const r = await openaiAdapter.chat(creds("openai"), { model: "gpt-4o", system: "S", context: "Today is X", history: [{ role: "user", content: "how much?" }], tools: [tool], maxIterations: 6, onUsage: async (_m, u) => void usages.push(u.output_tokens) });
    expect(r).toEqual({ reply: "You spent 42 AZN." });
    expect(run).toHaveBeenCalledWith({ days: 7, kind: "expense" }); // defaults from the schema are applied
    expect(seen[0].body.tools[0].function.name).toBe("spending");
    expect(seen[1].body.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "spent 42 over 7 days (expense)" });
    expect(usages).toEqual([10, 8]);
  });
  it("stops looping after the allowed number of lookups and asks for an answer without tools", async () => {
    const tool: ChatTool = { name: "t", description: "d", schema: z.object({}), run: (async () => "x") as never };
    const loop = { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c", function: { name: "t", arguments: "{}" } }] } }], usage: {} };
    const seen = fakeNetwork(loop, loop, { choices: [{ message: { role: "assistant", content: "final" } }], usage: {} });
    const r = await openaiAdapter.chat(creds("openai"), { model: "gpt-4o", system: "S", context: "C", history: [{ role: "user", content: "q" }], tools: [tool], maxIterations: 2, onUsage: async () => {} });
    expect(r).toEqual({ reply: "final" });
    expect(seen.at(-1)!.body.tool_choice).toBe("none");
  });
});

describe("Gemini", () => {
  const ok = (text: string, extra: object = {}) => ({ modelVersion: "gemini-2.5-flash", candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 }, ...extra });
  it("sends JSON mode, the key in a header and the PDF inline", async () => {
    const seen = fakeNetwork(ok('{"merchant":"Wolt","amount":9,"kind":"out"}'));
    const r = await geminiAdapter.structured(creds("gemini"), structuredReq("gemini-2.5-flash", [{ type: "pdf", base64: "QUJD" }, { type: "text", text: "rows" }]));
    expect(r.data?.merchant).toBe("Wolt");
    expect(seen[0].url).toBe("https://mock.test/v1beta/models/gemini-2.5-flash:generateContent");
    expect(seen[0].headers["x-goog-api-key"]).toBe("KEY123");
    expect(seen[0].url).not.toContain("KEY123");
    expect(seen[0].body.generationConfig.responseMimeType).toBe("application/json");
    expect(seen[0].body.contents[0].parts[0]).toEqual({ inline_data: { mime_type: "application/pdf", data: "QUJD" } });
    expect(r.usage).toMatchObject({ input_tokens: 100, output_tokens: 50 }); // thinking counts as output
  });
  it("retries once on invalid JSON; blocked or truncated answers are no answer", async () => {
    const seen = fakeNetwork(ok("garbage"), ok('{"merchant":"Z","amount":3,"kind":"in"}'));
    expect((await geminiAdapter.structured(creds("gemini"), structuredReq("gemini-2.5-flash"))).data?.merchant).toBe("Z");
    expect(seen[1].body.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
    fakeNetwork(ok("", { promptFeedback: { blockReason: "SAFETY" } }));
    expect((await geminiAdapter.structured(creds("gemini"), structuredReq("gemini-2.5-flash"))).data).toBeNull();
    fakeNetwork({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"merchant":"cu' }] } }], usageMetadata: {} });
    expect((await geminiAdapter.structured(creds("gemini"), structuredReq("gemini-2.5-flash"))).data).toBeNull();
  });
  it("answers questions with function calling", async () => {
    const run = vi.fn(async (a: { text?: string | null }) => `found ${a.text ?? "all"}`);
    const tool: ChatTool = { name: "find", description: "find", schema: z.object({ text: z.string().nullable().optional() }), run: run as never };
    const seen = fakeNetwork(
      { candidates: [{ content: { parts: [{ functionCall: { name: "find", args: { text: "taxi" } } }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } },
      { candidates: [{ content: { parts: [{ text: "Three taxi rides." }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
    );
    const r = await geminiAdapter.chat(creds("gemini"), { model: "gemini-2.5-flash", system: "S", context: "C", history: [{ role: "user", content: "taxis?" }, { role: "assistant", content: "ok" }, { role: "user", content: "again" }], tools: [tool], maxIterations: 6, onUsage: async () => {} });
    expect(r).toEqual({ reply: "Three taxi rides." });
    expect(run).toHaveBeenCalledWith({ text: "taxi" });
    expect(seen[0].body.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
    expect(seen[0].body.tools[0].functionDeclarations[0].parameters.properties.text.nullable).toBe(true);
    expect(seen[1].body.contents.at(-1).parts[0].functionResponse).toEqual({ name: "find", response: { result: "found taxi" } });
  });
});

describe("tool safety", () => {
  const tool = { schema: z.object({ n: z.number() }), run: (async (a: { n: number }) => String(a.n * 2)) as never };
  it("reports bad input to the model instead of crashing", async () => {
    expect(await runTool(tool, { n: "x" })).toMatch(/^Invalid input: n/);
    expect(await runTool(tool, null)).toMatch(/^Invalid input/);
    expect(await runTool(tool, { n: 4 })).toBe("8");
    expect(await runTool({ schema: z.object({}), run: (async () => { throw new Error("db down"); }) as never }, {})).toMatch(/lookup failed: db down/);
  });
});
