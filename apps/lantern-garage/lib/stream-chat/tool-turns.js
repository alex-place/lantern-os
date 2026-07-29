// Native tool-use turn helpers — one per provider wire-protocol. Each streams a
// SINGLE assistant turn with `tools`, forwards text deltas via onToken, and returns
// the accumulated tool calls so the caller can run them (lib/tool-runner) and append
// a result turn for the next iteration. Same registry + executor across providers;
// reliable native protocols instead of free-text parsing.
const https = require("https");
const { llmAgent } = require("../insecure-tls");

// ── Anthropic (Claude) — /v1/messages with tool_use blocks ────────────────────
// `mcpServers` (optional): remote MCP connectors (e.g. Indeed) that Anthropic connects
// to and executes server-side — passed as the `mcp_servers` param under the MCP-connector
// beta. When present, the model calls those tools autonomously (streamed as mcp_tool_use/
// mcp_tool_result blocks we surface but don't execute). `onMcpTool(name)` fires per call.
function anthropicToolTurn({ anthropicKey, model, system, messages, tools, maxTokens, onToken, mcpServers, onMcpTool }) {
  return new Promise((resolve, reject) => {
    const useMcp = Array.isArray(mcpServers) && mcpServers.length > 0;
    const payload = JSON.stringify({
      model, max_tokens: maxTokens, stream: true, system, messages, tools,
      ...(useMcp ? { mcp_servers: mcpServers } : {}),
    });
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (useMcp) headers["anthropic-beta"] = "mcp-client-2025-11-20";
    const req = https.request({
      agent: llmAgent,
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers,
    }, (upstream) => {
      if (upstream.statusCode !== 200) {
        // Keep the provider's own reason (#2531 pattern) — a bare status hides
        // actionable errors like unsupported params or a bad model name.
        let ebody = "";
        upstream.on("data", (c) => { if (ebody.length < 300) ebody += c.toString(); });
        upstream.on("end", () => reject(new Error(`anthropic_status_${upstream.statusCode} [tool-turn]: ${ebody.slice(0, 200)}`)));
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
            if (cb.type === "tool_use") {
              blocks[evt.index] = { type: "tool_use", id: cb.id, name: cb.name, jsonbuf: "" };
            } else if (cb.type === "mcp_tool_use") {
              // Anthropic executes this server-side (e.g. Indeed). We don't run it; just
              // note it and surface progress. Skipped from assistantContent below.
              blocks[evt.index] = { type: "mcp_tool_use", name: cb.name, server: cb.server_name };
              if (onMcpTool && cb.name) onMcpTool(cb.name, cb.server_name);
            } else if (cb.type === "mcp_tool_result") {
              blocks[evt.index] = { type: "mcp_tool_result" };
            } else {
              blocks[evt.index] = { type: "text", text: "" };
            }
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
          } else if (b.type === "tool_use") {
            let input = {};
            try { input = b.jsonbuf ? JSON.parse(b.jsonbuf) : {}; } catch { input = {}; }
            assistantContent.push({ type: "tool_use", id: b.id, name: b.name, input });
            toolUses.push({ id: b.id, name: b.name, input });
          }
          // mcp_tool_use / mcp_tool_result: executed server-side by Anthropic — not our
          // job to run or echo back. Skip (these turns end with stop_reason=end_turn).
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
      if (upstream.statusCode !== 200) {
        // Keep the provider's own reason (#2531): a bare status hid grok's
        // "does not support parameter frequencyPenalty" for weeks.
        let ebody = "";
        upstream.on("data", (c) => { if (ebody.length < 300) ebody += c.toString(); });
        upstream.on("end", () => reject(new Error(`${errTag}_status_${upstream.statusCode} [tool-turn]: ${ebody.slice(0, 200)}`)));
        return;
      }
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

// ── Unified agentic tool loop (#2756) ─────────────────────────────────────────
// One driver for every provider. The five copy-pasted per-provider loops in
// stream-chat.js are replaced by this + a thin adapter each. The loop mechanics
// (iterate up to maxIters, run the turn's tool calls in PARALLEL (#2752), stream the
// two-phase call/result SSE events, feed the results back) are shared; the wire
// differences (turn helper, "wants more" test, assistant-turn shape, tool-result
// shape) live in the adapter's four hooks.
//
// adapter = {
//   maxIters,
//   turn(): Promise<turnResult>,             // calls the provider turn helper (streams via its own onToken)
//   toolCalls(turnResult): [{name, input, id?}],  // [] ⇒ the model gave its final answer
//   pushAssistant(turnResult),               // append the model's turn to the provider convo
//   pushToolResults(outcomes),               // outcomes: [{call, out, ok}] → append the provider tool-result turn
// }
// runTool(name, input): Promise<outcome>     // provided by the caller (closes over operator/userId)
// Stable signature for a call, used to detect a model repeating itself (#3066).
function _callKey(c) {
  let input = "";
  try { input = JSON.stringify(c.input || {}); } catch { input = String(c.input || ""); }
  return `${c.name}:${input}`;
}

async function runToolLoop(adapter, { sse, res, runTool, onBeforeTurn }) {
  let toolCalls = 0;
  // Hardening for a default-on loop (#3066): report WHY the loop ended instead of returning
  // an indistinguishable "done". "final" = the model answered; "max_steps" = we cut it off.
  let stopReason = "final";
  const seenCalls = new Map();   // callKey → times issued, for repeat detection
  for (let iter = 0; iter < adapter.maxIters; iter++) {
    const turn = await adapter.turn();
    const calls = adapter.toolCalls(turn) || [];
    if (!calls.length) { stopReason = "final"; break; }   // final answer already streamed
    adapter.pushAssistant(turn);
    toolCalls += calls.length;
    // #2752 — run this turn's tool calls concurrently. Promise.all preserves call
    // order, so the tool-result messages stay aligned with the model's calls.
    const outcomes = await Promise.all(calls.map(async (c) => {
      sse.writeData(res, { type: "tool", phase: "call", name: c.name, input: c.input });
      // #3066 repeat guard: re-running an IDENTICAL call cannot produce new information —
      // it just burns an iteration (and real latency/quota) while the model loops. Feed the
      // repeat back as a corrective note so it either varies the call or answers.
      const key = _callKey(c);
      const priorCount = seenCalls.get(key) || 0;
      seenCalls.set(key, priorCount + 1);
      if (priorCount > 0) {
        const out = `NOTE: you already called \`${c.name}\` with these exact arguments earlier in this turn `
          + `and have the result above. Do NOT repeat it — either call it with DIFFERENT arguments, `
          + `use a different tool, or answer the user with what you already have.`;
        sse.writeData(res, { type: "tool", phase: "result", name: c.name, ok: false,
          reason_code: "duplicate_call", preview: "(duplicate call — skipped)" });
        return { call: c, out, ok: false, duplicate: true };
      }
      // #3066: a tool that THROWS must not kill the turn. Before this, one rejecting tool
      // rejected Promise.all and the user lost the whole reply; now the error becomes a
      // normal tool result the model can react to (retry differently / answer without it).
      let r;
      try {
        r = await runTool(c.name, c.input);
      } catch (err) {
        r = { ok: false, reason: "tool_threw", error: (err && err.message) || String(err) };
      }
      r = r || { ok: false, reason: "tool_no_result", error: "tool returned nothing" };
      const out = String(r.ok ? r.result : `ERROR(${r.reason || "error"}): ${r.error}`).slice(0, 6000);
      sse.writeData(res, { type: "tool", phase: "result", name: c.name,
        ok: !!r.ok, status: r.status, reason_code: r.reason_code, receipt: r.receipt,
        preview: out.slice(0, 240) });
      return { call: c, out, ok: !!r.ok };
    }));
    adapter.pushToolResults(outcomes);
    // #3065 per-step context seam: after each tool round, let the caller refresh per-step
    // context (e.g. re-query CSF memory against the calls just made) BEFORE the next model
    // turn — so later steps get context relevant to what the turn actually became. Passes the
    // just-completed calls/outcomes. Best-effort: a refresh error must never break the loop.
    if (onBeforeTurn) { try { await onBeforeTurn({ iter, calls, outcomes }); } catch { /* refresh best-effort */ } }
    // Exhausted the cap with the model still wanting tools — it never got to answer.
    if (iter === adapter.maxIters - 1) stopReason = "max_steps";
  }
  return { toolCalls, stopReason };
}

// Adapters — `convo`/`messages`/`contents` are mutated in place (the turn helper reads
// them by reference each iteration). `turn` is a thunk that calls the provider helper.
function anthropicAdapter(convo, maxIters, turn) {
  return {
    maxIters, turn,
    toolCalls: (t) => (t.stopReason === "tool_use" ? t.toolUses : []),   // preserves the original break condition
    pushAssistant: (t) => convo.push({ role: "assistant", content: t.assistantContent }),
    pushToolResults: (outs) => convo.push({ role: "user", content: outs.map((o) => ({ type: "tool_result", tool_use_id: o.call.id, content: o.out, is_error: !o.ok })) }),
  };
}
function geminiAdapter(contents, maxIters, turn) {
  return {
    maxIters, turn,
    toolCalls: (t) => t.functionCalls.map((fc) => ({ name: fc.name, input: fc.args || {} })),
    pushAssistant: (t) => contents.push({ role: "model", parts: t.modelParts }),
    pushToolResults: (outs) => contents.push({ role: "user", parts: outs.map((o) => ({ functionResponse: { name: o.call.name, response: { result: o.out } } })) }),
  };
}
function openaiAdapter(messages, maxIters, turn) {
  return {
    maxIters, turn,
    toolCalls: (t) => t.toolCalls,
    pushAssistant: (t) => messages.push(t.assistantMessage),
    pushToolResults: (outs) => outs.forEach((o) => messages.push({ role: "tool", tool_call_id: o.call.id, content: o.out })),
  };
}

module.exports = {
  anthropicToolTurn, openaiCompatibleToolTurn, geminiToolTurn,
  runToolLoop, anthropicAdapter, geminiAdapter, openaiAdapter,
};
