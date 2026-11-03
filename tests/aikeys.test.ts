import { describe, expect, it } from "vitest";
import { cleanKey, validKeyShape } from "../worker/services/aikeys";
import { isOpenAiChatModel, listModels, pickDefaults } from "../worker/services/aiproviders/models";
import { ProviderError, httpError } from "../worker/services/aiproviders/types";
import { costUsd, describeBlock } from "../worker/services/ai";

describe("pasted keys", () => {
  it("are cleaned of spaces, line breaks and quotes", () => {
    expect(cleanKey('  "sk-ant-abc123\n  DEF456"  ')).toBe("sk-ant-abc123DEF456");
    expect(cleanKey("AIza SyA-1234\r\n5678")).toBe("AIzaSyA-12345678");
  });
  it("must look like a key", () => {
    expect(validKeyShape("sk-ant-api03-abcdefghijklmnop")).toBe(true);
    expect(validKeyShape("short")).toBe(false);
    expect(validKeyShape("has spaces in it already 123456")).toBe(false);
    expect(validKeyShape("x".repeat(401))).toBe(false);
  });
});

describe("OpenAI model filter", () => {
  it("keeps chat models and drops the rest", () => {
    for (const ok of ["gpt-4o", "gpt-4o-mini", "gpt-5", "o3", "o4-mini", "chatgpt-4o-latest"]) expect(isOpenAiChatModel(ok), ok).toBe(true);
    for (const no of ["text-embedding-3-small", "whisper-1", "tts-1", "dall-e-3", "gpt-image-1", "gpt-4o-realtime-preview", "omni-moderation-latest", "gpt-4o-transcribe", "davinci-002"]) expect(isOpenAiChatModel(no), no).toBe(false);
  });
});

describe("default models", () => {
  it("Claude: haiku for everyday, opus before sonnet for smart", () => {
    const d = pickDefaults("anthropic", ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-4-8"]);
    expect(d.fast).toBe("claude-haiku-5-5");
    expect(d.smart).toBe("claude-opus-5-5");
  });
  it("OpenAI: a mini model and a full model", () => {
    const d = pickDefaults("openai", ["gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5-mini", "o3", "gpt-5-codex"]);
    expect(d.fast).toBe("gpt-5-mini");
    expect(d.smart).toBe("gpt-5");
  });
  it("Gemini: flash for everyday, pro for smart, avoiding previews when a stable one exists", () => {
    const d = pickDefaults("gemini", ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3-pro-preview"]);
    expect(d.fast).toBe("gemini-2.5-flash-lite");
    expect(d.smart).toBe("gemini-2.5-pro");
  });
  it("falls back to previews when that is all there is, and to null when nothing fits", () => {
    expect(pickDefaults("gemini", ["gemini-3-pro-preview", "gemini-3-flash-preview"])).toEqual({ fast: "gemini-3-flash-preview", smart: "gemini-3-pro-preview" });
    expect(pickDefaults("openai", ["gpt-4o"]).fast).toBeNull();
  });
});

describe("listing models", () => {
  const res = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  it("reads each provider's format and sends the key the way that provider expects", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const f = ((url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return res({ data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }], models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }] });
    }) as unknown as typeof fetch;
    expect(await listModels({ provider: "openai", apiKey: "k" }, f)).toEqual(["gpt-4o"]);
    expect(seen!.headers.authorization).toBe("Bearer k");
    expect(await listModels({ provider: "gemini", apiKey: "k" }, f)).toEqual(["gemini-2.5-flash"]);
    expect(seen!.headers["x-goog-api-key"]).toBe("k");
    expect(seen!.url).not.toContain("key=");
    await listModels({ provider: "anthropic", apiKey: "k" }, f);
    expect(seen!.headers["x-api-key"]).toBe("k");
  });
  it("turns provider failures into messages for the user", async () => {
    const f = (status: number) => (() => res({ error: "x" }, status)) as unknown as typeof fetch;
    await expect(listModels({ provider: "openai", apiKey: "k" }, f(401))).rejects.toMatchObject({ kind: "auth" });
    await expect(listModels({ provider: "gemini", apiKey: "k" }, f(429))).rejects.toMatchObject({ kind: "quota" });
    await expect(listModels({ provider: "anthropic", apiKey: "k" }, f(500))).rejects.toMatchObject({ kind: "server" });
    await expect(listModels({ provider: "openai", apiKey: "k" }, (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("errors, costs and limits", () => {
  it("explains what to do", () => {
    expect(httpError("gemini", 401).message).toMatch(/Gemini rejected your API key/);
    expect(httpError("openai", 429).message).toMatch(/ChatGPT.*quota/);
    expect(httpError("anthropic", 404).userFixable).toBe(true);
    expect(httpError("anthropic", 503).userFixable).toBe(false);
    // Google reports a wrong key as 400; other 400s keep the provider's own explanation, not a raw JSON blob.
    const gemini400 = JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } });
    expect(httpError("gemini", 400, gemini400).kind).toBe("auth");
    const other400 = httpError("openai", 400, JSON.stringify({ error: { message: "Unsupported parameter: max_tokens" } }));
    expect(other400.kind).toBe("bad_request");
    expect(other400.message).toContain("Unsupported parameter");
    expect(other400.message).not.toContain("{");
  });
  it("knows Claude prices only", () => {
    expect(costUsd("anthropic", "claude-haiku-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(0.6);
    expect(costUsd("openai", "gpt-5", { input_tokens: 10, output_tokens: 10 })).toBeNull();
    expect(costUsd("gemini", "gemini-2.5-pro", { input_tokens: 10, output_tokens: 10 })).toBeNull();
  });
  it("every blocked reason has a message pointing to Settings", () => {
    for (const r of ["no_key", "key_rejected", "no_model", "disabled", "cap_reached", "tokens_reached"] as const) expect(describeBlock(r)).toMatch(/Settings/);
  });
});
