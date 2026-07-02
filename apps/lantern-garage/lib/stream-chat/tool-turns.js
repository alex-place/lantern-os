// Native tool-use turn helpers — one per provider wire-protocol. Each streams a
// SINGLE assistant turn with `tools`, forwards text deltas via onToken, and returns
// the accumulated tool calls so the caller can run them (lib/tool-runner) and append
// a result turn for the next iteration. Same registry + executor across providers;
// reliable native protocols instead of free-text parsing.
const https = require("https");
const { llmAgent } = require("../insecure-tls");

// ── Anthropic (Claude) — /v1/messages with tool_use blocks ────────────────────
function anthropicToolTurn({ anthropicKey, model, system, messages, tools, maxTokens, onToken }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, max_tokens: maxTokens, stream: true, system, messages, tools });
    const req = https.request({
      agent: llmAgent,
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        reject(new Error(`anthropic_status_${upstream.statusCode}`));
        return;
      }
      const blocks = [];      // index → { type:"text", text } | { type:"tool_use", id, name, jsonbuf }
      let stopReason = null;
      let buf = "";
      upstream.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let evt; try { evt = JSON.parse(raw); } catch { continue; }
          if (evt.type === "content_block_start") {
            const cb = evt.content_block || {};
            blocks[evt.index] = cb.type === "tool_use"
              ? { type: "tool_use", id: cb.id, name: cb.name, jsonbuf: "" }
              : { type: "text", text: "" };
          } else if (evt.type === "content_block_delta") {
            const b = blocks[evt.index];
            if (evt.delta?.type === "text_delta") {
              if (b) b.text += evt.delta.text;
              if (onToken && evt.delta.text) onToken(evt.delta.text);
            } else if (evt.delta?.type === "input_json_delta" && b) {
              b.jsonbuf += evt.delta.partial_json || "";
            }
          } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
            stopReason = evt.delta.stop_reason;
          }
        }
      });
      upstream.on("end", () => {
        const assistantContent = [];
        const toolUses = [];
        for (const b of blocks) {
          if (!b) continue;
          if (b.type === "text") {
            if (b.text) assistantContent.push({ type: "text", text: b.text });
          } else {
            let input = {};
            try { input = b.jsonbuf ? JSON.parse(b.jsonbuf) : {}; } catch { input = {}; }
            assistantContent.push({ type: "tool_use", id: b.id, name: b.name, input });
            toolUses.push({ id: b.id, name: b.name, input });
          }
        }
        resolve({ assistantContent, toolUses, stopReason });
      });
      upstream.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("anthropic_timeout")); });
    req.write(payload);
    req.end();
  });
}

// ── OpenAI / xAI (Grok) — /v1/chat/completions function-calling ───────────────
function openaiCompatibleToolTurn({ host, path, apiKey, model, messages, tools, decode, onToken }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, stream: true, messages, tools, tool_choice: "auto", ...(decode || {}) });
    const reqPath = path || "/v1/chat/completions";
    const errTag = host.includes("x.ai") ? "xai" : host.includes("cohere") ? "cohere" : "openai";
    const req = https.request({
      agent: llmAgent, hostname: host, path: reqPath, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, "Content-Length": Buffer.byteLength(payload) },
    }, (upstream) => {
      if (upstream.statusCode !== 200) { upstream.resume(); reject(new Error(`${errTag}_status_${upstream.statusCode}`)); return; }
      let buf = "", text = "", finishReason = null;
      const calls = []; // index → { id, name, args }
      upstream.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let evt; try { evt = JSON.parse(raw); } catch { continue; }
          const ch = evt.choices?.[0]; if (!ch) continue;
          const d = ch.delta || {};
          if (d.content) { text += d.content; if (onToken) onToken(d.content); }
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              const idx = tc.index ?? 0;
              calls[idx] = calls[idx] || { id: "", name: "", args: "" };
              if (tc.id) calls[idx].id = tc.id;
              if (tc.function?.name) calls[idx].name = tc.function.name;
              if (tc.function?.arguments) calls[idx].args += tc.function.arguments;
            }
          }
          if (ch.finish_reason) finishReason = ch.finish_reason;
        }
      });
      upstream.on("end", () => {
        const present = calls.filter(Boolean);
        const toolCalls = present.map((c) => { let input = {}; try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = {}; } return { id: c.id, name: c.name, input }; });
        const assistantMessage = { role: "assistant", content: text || null };
        if (present.length) assistantMessage.tool_calls = present.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
        resolve({ assistantMessage, toolCalls, finishReason, text });
      });
      upstream.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("openai_timeout")); });
    req.write(payload);
    req.end();
  });
}

// ── Gemini — :streamGenerateContent with functionDeclarations ─────────────────
function geminiToolTurn({ transport, model, contents, tools, systemInstruction, generationConfig, onToken }) {
  return new Promise((resolve, reject) => {
    const body = { contents, tools, generationConfig };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    const payload = JSON.stringify(body);
    // transport = { hostname, path, headers } from lib/gemini-transport (AI Studio
    // key wire, or Vertex AI Bearer-token wire). Same SSE shape on both.
    const req = https.request({
      agent: llmAgent, hostname: transport.hostname,
      path: transport.path, method: "POST",
      headers: { ...transport.headers, "Content-Length": Buffer.byteLength(payload) },
    }, (upstream) => {
      if (upstream.statusCode !== 200) { upstream.resume(); reject(new Error(`gemini_status_${upstream.statusCode}`)); return; }
      let buf = "", text = "";
      const functionCalls = [], modelParts = [];
      upstream.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let evt; try { evt = JSON.parse(raw); } catch { continue; }
          const parts = evt.candidates?.[0]?.content?.parts || [];
          for (const p of parts) {
            if (p.text) { text += p.text; if (onToken) onToken(p.text); modelParts.push({ text: p.text }); }
            else if (p.functionCall) { functionCalls.push(p.functionCall); modelParts.push({ functionCall: p.functionCall }); }
          }
        }
      });
      upstream.on("end", () => resolve({ modelParts, functionCalls, text }));
      upstream.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("gemini_timeout")); });
    req.write(payload);
    req.end();
  });
}

module.exports = { anthropicToolTurn, openaiCompatibleToolTurn, geminiToolTurn };
