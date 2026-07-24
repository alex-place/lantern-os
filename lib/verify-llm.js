// ── Σ₀ Verify-pass LLM caller (provider-agnostic) ───────────────────────────
// The Verify stage of the loop (Observe → Remember → Reason → Act → Verify →
// Converge) must never depend on one vendor. dream-chat.verifyResponse used to
// extract + revise claims by calling api.anthropic.com directly and no-op'd the
// moment ANTHROPIC_API_KEY was absent — so with a credit-depleted Anthropic key
// the honesty net silently went offline (2026-07-03 eval: replies fabricated a
// nonexistent file summary and invented five nonexistent exports, all reported
// as sigma0={claims:0}). This routes the verify-pass model calls through the same
// PROVIDER SET the chat itself uses, with real fallback, so verification survives
// any single provider being down — the "models are replaceable, never hardcode a
// provider" first principle applied to the Verify stage.
//
// Why not reuse dreamChatReply's chain or provider-router.callProvider directly?
// dreamChatReply's provider legs are inline and entangled with persona prompts,
// suggestions, SSE and token-audit — not callable as a plain prompt→text function.
// provider-router.callProvider delegates to _callProviderImpl, which is a stub
// that throws for sync calls ("Use stream-chat.js for streaming"). So this mirrors
// the SAME implemented legs (same env keys, same endpoints, same response shapes)
// as a small, self-contained, testable fallback caller. It is an extension of the
// Verify stage, not a new subsystem.
"use strict";

const https = require("https");
const http = require("http");

// Single HTTP POST seam. Every provider leg goes through this one function so a
// unit test can swap the transport (via _setVerifyTransport) and exercise the real
// fallback ordering without a network. Resolves { status, body }; rejects on a
// transport error or timeout (the caller treats either as "this provider is down,
// try the next one").
function _realPost({ hostname, port, path, headers, protocol = "https", timeoutMs = 10000 }, payload) {
  return new Promise((resolve, reject) => {
    const lib = protocol === "http" ? http : https;
    const req = lib.request(
      { hostname, port, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(payload);
    req.end();
  });
}

// Module-local, reassignable so tests can inject a fake transport. Legs reference
// the binding (not the value) so a reassignment is visible to them at call time.
let _post = _realPost;
function _setVerifyTransport(fn) { _post = fn; }
function _resetVerifyTransport() { _post = _realPost; }

// A non-2xx status means the provider rejected the call (auth/quota/rate-limit —
// exactly the credit-depleted case). Treat it as "this provider is down" so the
// loop falls through to the next one instead of parsing an error body as content.
function _assertOk(status, provider) {
  if (typeof status === "number" && status >= 400) {
    throw new Error(`${provider}_status_${status}`);
  }
}

// ── Provider legs — mirror dreamChatReply's implemented providers ────────────
async function anthropicExtract(prompt, maxTokens) {
  const payload = JSON.stringify({
    model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const { status, body } = await _post({
    hostname: "api.anthropic.com", path: "/v1/messages",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
  }, payload);
  _assertOk(status, "anthropic");
  return String(JSON.parse(body).content?.[0]?.text || "");
}

async function openaiExtract(prompt, maxTokens) {
  const payload = JSON.stringify({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const { status, body } = await _post({
    hostname: "api.openai.com", path: "/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
  }, payload);
  _assertOk(status, "openai");
  return String(JSON.parse(body).choices?.[0]?.message?.content || "");
}

async function geminiExtract(prompt, maxTokens) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const model = process.env.GEMINI_GROUND_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    // gemini-2.5 spends part of the output budget on internal "thinking" tokens,
    // so give the short JSON extraction room to finish after thinking.
    generationConfig: { temperature: 0, maxOutputTokens: Math.max(maxTokens, 1024) },
  });
  const { status, body } = await _post({
    hostname: "generativelanguage.googleapis.com",
    path: `/v1beta/models/${model}:generateContent?key=${key}`,
    headers: { "Content-Type": "application/json" },
  }, payload);
  _assertOk(status, "gemini");
  return String(JSON.parse(body).candidates?.[0]?.content?.parts?.[0]?.text || "");
}

async function xaiExtract(prompt, maxTokens) {
  const payload = JSON.stringify({
    model: process.env.XAI_MODEL || "grok-3-mini",
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const { status, body } = await _post({
    hostname: "api.x.ai", path: "/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.XAI_API_KEY}`,
    },
  }, payload);
  _assertOk(status, "xai");
  return String(JSON.parse(body).choices?.[0]?.message?.content || "");
}

async function ollamaExtract(prompt, maxTokens) {
  const base = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const u = new URL(base);
  const payload = JSON.stringify({
    model: process.env.OLLAMA_MODEL || "ouro:latest",
    stream: false,
    options: { temperature: 0, num_predict: maxTokens },
    messages: [{ role: "user", content: prompt }],
  });
  const { status, body } = await _post({
    protocol: u.protocol === "https:" ? "https" : "http",
    hostname: u.hostname, port: u.port || 11434, path: "/api/chat",
    headers: { "Content-Type": "application/json" },
    timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 8000,
  }, payload);
  _assertOk(status, "ollama");
  return String(JSON.parse(body).message?.content || "");
}

// Ordered candidate legs. Cloud instruction-followers lead because claim
// extraction/revision must emit reliable JSON; the local Ouro is the OFFLINE
// backstop (same cloud-first-for-quality reasoning provider-router.js documents
// for its default/creative chains, #1167). A leg is included only when its
// credentials are present; ollama is always a candidate (kill-switch:
// VERIFY_USE_OLLAMA=0) and self-fails fast when nothing is serving locally.
function buildLegs(env = process.env) {
  const legs = [];
  if (env.ANTHROPIC_API_KEY) legs.push({ provider: "anthropic", call: anthropicExtract });
  if (env.OPENAI_API_KEY) legs.push({ provider: "openai", call: openaiExtract });
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) legs.push({ provider: "gemini", call: geminiExtract });
  if (env.XAI_API_KEY) legs.push({ provider: "xai", call: xaiExtract });
  if (!/^(0|false|no|off)$/i.test(env.VERIFY_USE_OLLAMA || "")) legs.push({ provider: "ollama", call: ollamaExtract });
  return legs;
}

/**
 * Call the first reachable provider with a plain text prompt.
 * @param {string} prompt
 * @param {{maxTokens?: number}} [opts]
 * @returns {Promise<{text: string, provider: string} | null>} the model's text +
 *   which provider produced it, or null when NO provider was reachable (every
 *   candidate errored or none is configured). null is the signal the caller turns
 *   into sigma0.skipped="no_provider" — distinct from a provider answering with
 *   zero extractable claims ("verified: nothing to correct").
 */
async function callVerifyModel(prompt, opts = {}) {
  const maxTokens = opts.maxTokens || 512;
  for (const leg of buildLegs()) {
    try {
      const text = await leg.call(prompt, maxTokens);
      if (text && text.trim()) return { text: text.trim(), provider: leg.provider };
    } catch { /* provider down — fall through to the next candidate */ }
  }
  return null;
}

module.exports = {
  callVerifyModel,
  buildLegs,
  // Test seam: swap the single HTTP transport to exercise fallback without a network.
  _setVerifyTransport,
  _resetVerifyTransport,
};
