"use strict";

/**
 * routes/v1.js — OpenAI-compatible /v1/chat/completions shim.
 *
 * THE FUNNEL (product design, this conversation): any tool that speaks OpenAI —
 * Aider, Continue, Cline, or any client with a configurable base_url — points at
 * unisona.ai and transparently gets the convergence loop (memory + verify + local-first
 * routing). We do NOT reimplement chat: we translate the OpenAI request into the
 * NATIVE stream-chat request, call the existing engine (deps.handleStreamChat), and
 * transcode its internal SSE frames ({type:"token"|"done"|"error"}) into OpenAI
 * `chat.completion.chunk` frames. One adapter over the router we already run.
 *
 * Contract matched (per /research: OpenAI API docs + vLLM/LiteLLM reference servers):
 *   - streaming: `data: {chat.completion.chunk}\n\n` lines, terminal `data: [DONE]\n\n`
 *   - non-streaming: one `chat.completion` JSON object
 *   - choices[].delta / choices[].message, finish_reason stop|length|tool_calls
 * Byte-exact bits (clients depend on them): the `data: ` framing, the literal
 * `[DONE]` sentinel, and the delta shape. Tolerated: usage omitted in stream, extra
 * fields, free-form id/created.
 *
 * KNOWN LIMITATIONS (honest — MVP):
 *   1. SYSTEM PROMPT: the native engine injects its OWN unisona.ai persona system
 *      prompt; a client `system` message is folded into the first user turn as
 *      context, NOT substituted. Strict clients (Aider's SEARCH/REPLACE contract)
 *      may need a real systemOverride seam in handleStreamChat — follow-up.
 *   2. MODEL→PROVIDER is best-effort inference (see resolveModelParam). An unknown
 *      id falls through to the native brain's own routing (non-fatal).
 *   3. Native tool frames ({type:"tool"}) are not re-encoded as OpenAI tool_calls
 *      yet — they're surfaced as assistant content markers. Follow-up if a client
 *      needs real function-calling round-trips.
 *
 * AUTH: if KEYSTONE_V1_API_KEY is set, require `Authorization: Bearer <key>`.
 * Unset (default) → open on the localhost-bound server (local-first). Do NOT expose
 * this route publicly without setting the key.
 */

const { Readable } = require("stream");

const NATIVE_STREAM_PATH = "/api/dream/chat/stream"; // POST SSE native endpoint

// ── OpenAI ⇄ native translation ────────────────────────────────────────────────

/** Flatten OpenAI `messages` → native {message, history:[{role,text}]}.
 *  system messages are folded into the leading context (see limitation #1). */
function openaiToNative(messages) {
  const systems = [];
  const turns = [];
  for (const m of messages) {
    if (!m || typeof m.content === "undefined") continue;
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => (typeof p === "string" ? p : p && p.text) || "").join("")
        : String(m.content);
    if (m.role === "system") { systems.push(content); continue; }
    turns.push({ role: m.role === "assistant" ? "assistant" : "user", text: content });
  }
  // Last user turn is the "message"; everything before is history.
  let message = "";
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") { message = turns[i].text; turns.splice(i, 1); break; }
  }
  // Fold system context ahead of the message so the model at least sees it.
  if (systems.length) message = `${systems.join("\n\n")}\n\n${message}`;
  return { message: message.trim(), history: turns };
}

/** Best-effort map an OpenAI `model` string → native {provider, model}. Unknown →
 *  empty (native brain routes). Never throws; a wrong guess just isn't pinned. */
function resolveModelParam(model) {
  const m = String(model || "").toLowerCase().trim();
  if (!m || m === "auto" || m === "default") return { provider: "", model: "" };
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("chatgpt")) return { provider: "openai", model };
  if (m.startsWith("claude")) return { provider: "anthropic", model };
  if (m.startsWith("gemini")) return { provider: "gemini", model };
  if (m.startsWith("grok")) return { provider: "xai", model };
  // local ollama tags (qwen/ouro/llama/gpt-oss/keystone or any name:tag form)
  if (m.includes(":") || /(qwen|ouro|llama|gpt-oss|keystone|mistral|phi)/.test(m)) return { provider: "ollama", model };
  return { provider: "", model: "" };
}

function oaiError(message, type = "invalid_request_error", status = 400) {
  return { status, body: { error: { message, type, code: null } } };
}

/** Parse a single native SSE frame string (`data: {json}\n\n`) → object or null. */
function parseNativeFrame(data) {
  const s = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
  const out = [];
  for (const part of s.split("\n\n")) {
    const line = part.trim();
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    try { out.push(JSON.parse(json)); } catch { /* skip */ }
  }
  return out;
}

// ── res transcoders ──────────────────────────────────────────────────────────

/** Wrap res so native SSE frames stream out as OpenAI chat.completion.chunk. */
function wrapResForOpenAIStream(res, meta) {
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  let roleSent = false;
  let finished = false;

  const chunk = (delta, finish_reason = null) => {
    const payload = {
      id: meta.id, object: "chat.completion.chunk", created: meta.created,
      model: meta.model, choices: [{ index: 0, delta, finish_reason }],
    };
    origWrite(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const ensureRole = () => { if (!roleSent) { chunk({ role: "assistant", content: "" }); roleSent = true; } };

  res.write = (data) => {
    for (const frame of parseNativeFrame(data)) {
      if (frame.type === "token") { ensureRole(); chunk({ content: frame.text }); }
      else if (frame.type === "error") { ensureRole(); chunk({ content: `\n[error] ${frame.text || "stream error"}` }); }
      else if (frame.type === "tool") { ensureRole(); chunk({ content: `\n[tool:${frame.phase || ""} ${frame.name || ""}]` }); }
      // {type:"done"} / route / receipt frames: swallow; finalize on res.end
    }
    return true;
  };
  res.end = (data) => {
    if (finished) return origEnd();
    finished = true;
    if (data) for (const frame of parseNativeFrame(data)) if (frame.type === "token") { ensureRole(); chunk({ content: frame.text }); }
    ensureRole();
    chunk({}, "stop");
    origWrite("data: [DONE]\n\n");
    return origEnd();
  };
}

/** Wrap res so native SSE frames buffer into ONE OpenAI chat.completion JSON. */
function bufferResForOpenAIJson(res, meta) {
  const origWriteHead = res.writeHead.bind(res);
  const origEnd = res.end.bind(res);
  let content = "";
  let finished = false;

  res.writeHead = () => res;                 // swallow native text/event-stream header
  res.write = (data) => {
    for (const frame of parseNativeFrame(data)) {
      if (frame.type === "token") content += frame.text;
      else if (frame.type === "error") content += `\n[error] ${frame.text || "stream error"}`;
    }
    return true;
  };
  res.end = (data) => {
    if (finished) return origEnd();
    finished = true;
    if (data) for (const frame of parseNativeFrame(data)) if (frame.type === "token") content += frame.text;
    const completion = {
      id: meta.id, object: "chat.completion", created: meta.created, model: meta.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    const payload = JSON.stringify(completion);
    origWriteHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return origEnd(payload);
  };
}

// ── /v1/models (client capability probe) ────────────────────────────────────────
function sendModels(res, sendJson) {
  let ids = ["auto"];
  try {
    const reg = require("../lib/local-model-registry");
    ids = ids.concat(reg.loadRegistry().map((e) => e.id));
  } catch { /* registry optional */ }
  const now = Math.floor(Date.now() / 1000);
  sendJson(res, {
    object: "list",
    data: [...new Set(ids)].map((id) => ({ id, object: "model", created: now, owned_by: "keystone" })),
  }, 200);
}

// ── route ──────────────────────────────────────────────────────────────────────
module.exports = async function v1Routes(req, res, url, deps) {
  const { sendJson, collectRequestBody, handleStreamChat } = deps;
  const p = url.pathname;

  const isCompletions = p === "/v1/chat/completions" || p === "/openai/v1/chat/completions";
  const isModels = p === "/v1/models" || p === "/openai/v1/models";
  if (!isCompletions && !isModels) return false;

  // Optional API-key gate (see AUTH note). Unset → open (localhost local-first).
  const requiredKey = process.env.KEYSTONE_V1_API_KEY;
  if (requiredKey) {
    const auth = String(req.headers["authorization"] || "");
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (bearer !== requiredKey) {
      const e = oaiError("invalid api key", "invalid_request_error", 401);
      sendJson(res, e.body, 401);
      return true;
    }
  }

  if (isModels && req.method === "GET") { sendModels(res, sendJson); return true; }
  if (!isCompletions || req.method !== "POST") {
    const e = oaiError("method not allowed", "invalid_request_error", 405);
    sendJson(res, e.body, 405);
    return true;
  }

  // 1. Read the OpenAI request body.
  let body;
  try {
    let raw = await collectRequestBody(req);
    if (typeof raw === "string" && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    body = JSON.parse(raw);
  } catch {
    const e = oaiError("could not parse request body as JSON");
    sendJson(res, e.body, 400);
    return true;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const { message, history } = openaiToNative(messages);
  if (!message) {
    const e = oaiError("no user message found in `messages`");
    sendJson(res, e.body, 400);
    return true;
  }

  // 2. Translate → native body and forge a synthetic POST request the native
  //    parser (parseStreamChatRequest) can read via collectRequestBody.
  const { provider, model: modelPin } = resolveModelParam(body.model);
  const nativeBody = JSON.stringify({
    message,
    history,
    provider,
    model: modelPin,
    user: String(body.user || "openai-api"),
    surface: "openai-v1",
  });

  // Emit a Buffer (not a string): the native collectRequestBody does Buffer.concat()
  // over the chunks and throws ERR_INVALID_ARG_TYPE on a string chunk.
  const synthReq = Readable.from([Buffer.from(nativeBody, "utf8")]);
  synthReq.method = "POST";
  synthReq.headers = req.headers;
  synthReq.url = NATIVE_STREAM_PATH;
  // Preserve socket refs so downstream that inspects them still works.
  synthReq.socket = req.socket;
  synthReq.connection = req.connection;
  const nativeUrl = new URL(NATIVE_STREAM_PATH, "http://127.0.0.1");

  // 3. Transcode the native stream into the OpenAI shape (streaming by default;
  //    OpenAI's spec default is non-streaming, so honor explicit stream:false).
  const meta = {
    id: "chatcmpl-" + Math.random().toString(36).slice(2, 14),
    created: Math.floor(Date.now() / 1000),
    model: String(body.model || "auto"),
  };
  const wantStream = body.stream === true; // OpenAI default is non-streaming

  if (wantStream) wrapResForOpenAIStream(res, meta);
  else bufferResForOpenAIJson(res, meta);

  try {
    await handleStreamChat(synthReq, nativeUrl, res);
  } catch (err) {
    // handleStreamChat owns the socket; if it threw before finishing, best-effort close.
    try { res.end(); } catch { /* already closed */ }
  }
  return true;
};

// Exported pure helpers for tests.
module.exports.openaiToNative = openaiToNative;
module.exports.resolveModelParam = resolveModelParam;
module.exports.parseNativeFrame = parseNativeFrame;
