// Vision (image understanding) — analyze an image with a provider-native vision model.
// Claude, GPT-4o-mini, and Gemini are all multimodal. Providers are tried in the order
// the live PCSF leaderboard ranks them (lib/provider-router.orderChainByPcsf), chaining
// to the next on any failure so one depleted/down provider never kills image analysis.
// Node fetch, key stays server-side, fail-safe by contract: { ok:false, error } on any failure.
//
// Gemini goes over the SAME transport as the chat (lib/gemini-transport): when Vertex is
// configured (GEMINI_USE_VERTEX=1 / VERTEX_PROJECT), it bills the funded Cloud project via
// ADC and NEVER touches the AI-Studio key — so vision spends only the Vertex credits (#1232).
//
// Pairs with the file-upload work tool: an image attachment routes here so the chat can SEE it.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";
const DEFAULT_PROMPT = "Describe this image in detail. If it contains text, transcribe it. If it's a chart, screenshot, diagram, or error, explain what it shows.";

// Accept a data: URL or raw base64 → { data, mediaType }.
function _split(image) {
  const m = String(image || "").match(/^data:([^;,]+);base64,(.*)$/s);
  if (m) return { data: m[2], mediaType: m[1] };
  return { data: String(image || ""), mediaType: null };
}

async function _claudeVision(prompt, data, mediaType, apiKey, signal) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 1200,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType || "image/png", data } },
          { type: "text", text: prompt || DEFAULT_PROMPT },
        ],
      }],
    }),
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
  const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!text) throw new Error("empty vision response");
  return text;
}

async function _openaiVision(prompt, data, mediaType, apiKey, signal) {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 1200,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt || DEFAULT_PROMPT },
          { type: "image_url", image_url: { url: `data:${mediaType || "image/png"};base64,${data}` } },
        ],
      }],
    }),
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
  const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!text) throw new Error("empty vision response");
  return String(text).trim();
}

async function _geminiVision(prompt, data, mediaType, signal) {
  // Resolve the wire (Vertex ADC when configured — the funded path — else AI-Studio key).
  const { geminiTransport } = require("./gemini-transport");
  const t = await geminiTransport({ model: GEMINI_MODEL, method: "generateContent", streaming: false });
  const url = `https://${t.hostname}${t.path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: t.headers,
    body: JSON.stringify({
      // Vertex requires an explicit role on each content (AI-Studio tolerated its absence).
      contents: [{
        role: "user",
        parts: [
          { text: prompt || DEFAULT_PROMPT },
          { inline_data: { mime_type: mediaType || "image/png", data } },
        ],
      }],
    }),
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
  const text = (json.candidates && json.candidates[0] && json.candidates[0].content
    && json.candidates[0].content.parts || []).map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("empty vision response");
  return text;
}

// analyzeImage(prompt, image) → { ok, text, model } | { ok:false, error }.
async function analyzeImage(prompt, image, opts = {}) {
  const { data, mediaType } = _split(image);
  if (!data) return { ok: false, error: "no image data" };
  const mt = opts.mimeType || mediaType || "image/png";

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  // Gemini counts as available when it has an AI-Studio key OR a Vertex wire (ADC).
  const { providerHasKey, orderChainByPcsf } = require("./provider-router");
  const geminiAvailable = providerHasKey("gemini");

  // Candidate providers, keyed by the same provider names the PCSF leaderboard ranks.
  const candidates = [
    { provider: "anthropic", model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5",
      available: !!anthropicKey, call: (s) => _claudeVision(prompt, data, mt, anthropicKey, s) },
    { provider: "openai", model: "gpt-4o-mini",
      available: !!openaiKey, call: (s) => _openaiVision(prompt, data, mt, openaiKey, s) },
    { provider: "gemini", model: GEMINI_MODEL,
      available: geminiAvailable, call: (s) => _geminiVision(prompt, data, mt, s) },
  ].filter((c) => c.available);

  if (!candidates.length) return { ok: false, error: "no vision provider configured (set ANTHROPIC_API_KEY, OPENAI_API_KEY, or a Vertex/GEMINI key)" };

  // Order by the live PCSF ranking (same source of truth as chat routing); providers the
  // leaderboard doesn't rank keep their listed order after ranked ones. So when one
  // provider is depleted/down, the chain falls back to whoever the leaderboard trusts next.
  const chain = orderChainByPcsf(
    candidates.map((c) => ({ provider: c.provider })), "default"
  ).chain;
  const byProvider = new Map(candidates.map((c) => [c.provider, c]));
  const ordered = chain.map((s) => byProvider.get(s.provider)).filter(Boolean);

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), opts.timeoutMs || 60000);
  const errors = [];
  try {
    for (const c of ordered) {
      try {
        const text = await c.call(ctrl.signal);
        return { ok: true, text, model: c.model, provider: c.provider };
      } catch (e) {
        if (e.name === "AbortError") throw e;
        errors.push(`${c.provider}: ${e.message}`);
        console.warn(`[vision] ${c.provider} failed (${e.message}); trying next provider`);
      }
    }
    return { ok: false, error: errors.length ? `all vision providers failed — ${errors.join("; ")}` : "vision provider failed" };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "vision timed out" : (e.message || String(e)) };
  } finally {
    clearTimeout(to);
  }
}

module.exports = { analyzeImage };
