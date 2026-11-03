// A stand-in for the Claude, ChatGPT and Gemini APIs on one local port, to exercise the app's AI code without real
// keys. Keys decide behaviour: "BADKEY" is rejected, "QUOTAKEY" lists models but is out of quota when asked to answer,
// "REJECTAFTER" lists models but is rejected when asked to answer. Used by scripts/ai-check.mjs (local only).

import { createServer } from "node:http";

export function startMock(port = 8798) {
  const log = [];
  const usage = { in: 1200, out: 300 };

  /** What a model would answer, whichever provider is asked. */
  function answer({ system, userText, hasTools, toolResult }) {
    if (hasTools) {
      if (toolResult == null) return { tool: { name: "spending_summary", args: { date_from: "2026-10-01", date_to: "2026-10-24", group_by: "parent_category", kind: "expense", limit: 5 } } };
      return { text: `Here is your spending by category this month:\n${toolResult}` };
    }
    if (system.includes("categorize bank card transactions")) {
      const find = (name) => Number(system.match(new RegExp(`(\\d+): [^\\n]*${name}`))?.[1] ?? 1);
      const results = [...userText.matchAll(/merchant_id=(\d+) \| raw="([^"]*)"/g)].map(([, id, raw]) => ({
        merchant_id: Number(id),
        display_name: raw.slice(0, 30),
        category_id: /ZXQ|KEBAB|KAFE/i.test(raw) ? find("Restaurants") : find("Uncategorized"),
        confidence: 0.92,
      }));
      return { json: { results } };
    }
    if (system.includes("extract structured data from bank card notification")) {
      return { json: { is_transaction: true, direction: "out", type: "purchase", amount: 18.4, currency: "AZN", original_amount: null, original_currency: null, merchant: "PAPA JOHNS NARIMANOV", card_last4: "1234", local_datetime: null, balance_after: 500.1, balance_currency: "AZN" } };
    }
    if (system.includes("read bank account/card statements")) {
      return { json: { card_last4: "1234", currency: "AZN", transactions: [{ date: "2026-06-03", time: "13:10", description: "BRAVO SUPERMARKET", amount: -23.5 }, { date: "2026-06-04", time: null, description: "SALARY", amount: 2800 }] } };
    }
    if (system.includes("personal finance coach")) {
      return { json: { headline: "Eating out pushed you over budget.", summary: "You spent more than planned. Groceries and eating out are the largest flexible categories.", health_score: 58, highlights: ["Income covered spending."], bad_habits: [{ title: "Frequent delivery", detail: "12 orders.", monthly_cost: 268, suggestion: "Cook at home on weekdays." }], recommendations: [{ title: "Cap eating out", detail: "You usually spend 460.", potential_monthly_savings: 120 }], anomalies: [{ title: "Large purchase", detail: "245 AZN on 21 Oct." }], budget_suggestions: [{ category: "Eating out", suggested_monthly_amount: 350, reason: "Realistic step down." }] } };
    }
    if (system.includes("connection test")) return { json: { ok: true } };
    return { json: {} };
  }

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const keyIn = (req) => (req.headers["x-api-key"] ?? req.headers["x-goog-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "")).toString();

  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/__log") return send(res, 200, log);
      const key = keyIn(req);
      const provider = url.pathname.startsWith("/v1beta") ? "gemini" : url.pathname === "/v1/chat/completions" || (url.pathname === "/v1/models" && req.headers.authorization) ? "openai" : "anthropic";
      const body = data ? JSON.parse(data) : {};
      const generating = req.method === "POST";
      log.push({ provider, method: req.method, path: url.pathname, key, model: body.model ?? url.pathname.match(/models\/([^:]+):/)?.[1] ?? null, tools: (body.tools ?? []).length });

      const denied = () => {
        if (key.includes("BADKEY") || (generating && key.includes("REJECTAFTER"))) {
          if (provider === "gemini" && key.includes("BADKEY")) return send(res, 400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } });
          return send(res, 401, { error: { message: "invalid key" } });
        }
        if (generating && key.includes("QUOTAKEY")) return send(res, 429, { error: { message: "You exceeded your current quota" } });
        return null;
      };
      if (denied() !== null && res.writableEnded) return;

      // --- model lists
      if (req.method === "GET") {
        if (provider === "anthropic") return send(res, 200, { data: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"].map((id) => ({ id })) });
        if (provider === "openai") return send(res, 200, { data: ["gpt-5-mini", "gpt-5", "gpt-4o", "text-embedding-3-small", "whisper-1"].map((id) => ({ id })) });
        return send(res, 200, { models: [["gemini-2.5-flash", ["generateContent"]], ["gemini-2.5-pro", ["generateContent"]], ["embedding-001", ["embedContent"]]].map(([n, m]) => ({ name: `models/${n}`, supportedGenerationMethods: m })) });
      }

      // --- answers
      if (provider === "anthropic") {
        const system = Array.isArray(body.system) ? body.system.map((s) => s.text).join("\n") : body.system || "";
        const last = body.messages.at(-1);
        const userText = typeof last.content === "string" ? last.content : (last.content.find?.((c) => c.type === "text")?.text ?? "");
        const result = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === "tool_result");
        const toolText = result ? (typeof result.content === "string" ? result.content : result.content.map((c) => c.text).join("\n")) : null;
        const a = answer({ system, userText, hasTools: (body.tools ?? []).length > 0, toolResult: toolText });
        const content = a.tool ? [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "toolu_1", name: a.tool.name, input: a.tool.args }] : [{ type: "text", text: a.text ?? JSON.stringify(a.json) }];
        return send(res, 200, { id: "msg_1", type: "message", role: "assistant", model: body.model, content, stop_reason: a.tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: usage.in, output_tokens: usage.out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
      }
      if (provider === "openai") {
        const system = body.messages[0].content;
        const last = body.messages.at(-1);
        const userContent = typeof last.content === "string" ? last.content : (last.content ?? []).find?.((c) => c.type === "text")?.text ?? "";
        const toolText = last.role === "tool" ? last.content : null;
        const a = answer({ system, userText: userContent, hasTools: (body.tools ?? []).length > 0 && body.tool_choice !== "none", toolResult: toolText });
        const message = a.tool ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: a.tool.name, arguments: JSON.stringify(a.tool.args) } }] } : { role: "assistant", content: a.text ?? JSON.stringify(a.json) };
        return send(res, 200, { id: "c1", model: body.model, choices: [{ index: 0, finish_reason: a.tool ? "tool_calls" : "stop", message }], usage: { prompt_tokens: usage.in, completion_tokens: usage.out, prompt_tokens_details: { cached_tokens: 0 } } });
      }
      const system = body.systemInstruction?.parts?.[0]?.text ?? "";
      const lastContent = body.contents.at(-1);
      const userText = lastContent.parts.find((p) => p.text)?.text ?? "";
      const fr = lastContent.parts.find((p) => p.functionResponse)?.functionResponse?.response?.result ?? null;
      const a = answer({ system, userText, hasTools: (body.tools ?? []).length > 0, toolResult: fr });
      const parts = a.tool ? [{ functionCall: { name: a.tool.name, args: a.tool.args } }] : [{ text: a.text ?? JSON.stringify(a.json) }];
      return send(res, 200, { modelVersion: "gemini-2.5-flash", candidates: [{ finishReason: "STOP", content: { role: "model", parts } }], usageMetadata: { promptTokenCount: usage.in, candidatesTokenCount: usage.out, thoughtsTokenCount: 10 } });
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ log, close: () => server.close() })));
}
