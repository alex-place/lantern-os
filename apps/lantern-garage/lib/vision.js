// Vision (image understanding) — analyze an image with a provider-native vision model.
// Both Claude and GPT-4o are multimodal; Claude is primary here because its key works in this
// environment (OpenAI is currently billing-limited), with gpt-4o-mini as the ready fallback.
// Node fetch, key stays server-side, fail-safe by contract: { ok:false, error } on any failure.
//
// Pairs with the file-upload work tool: an image attachment routes here so the chat can SEE it.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
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

// analyzeImage(prompt, image) → { ok, text, model } | { ok:false, error }.
async function analyzeImage(prompt, image, opts = {}) {
  const { data, mediaType } = _split(image);
  if (!data) return { ok: false, error: "no image data" };
  const mt = opts.mimeType || mediaType || "image/png";
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) return { ok: false, error: "no vision provider key configured" };

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), opts.timeoutMs || 60000);
  try {
    if (anthropicKey) {
      try {
        const text = await _claudeVision(prompt, data, mt, anthropicKey, ctrl.signal);
        return { ok: true, text, model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5" };
      } catch (e) {
        if (e.name === "AbortError") throw e;
        console.warn(`[vision] claude failed (${e.message}); falling back to gpt-4o-mini`);
      }
    }
    if (openaiKey) {
      const text = await _openaiVision(prompt, data, mt, openaiKey, ctrl.signal);
      return { ok: true, text, model: "gpt-4o-mini" };
    }
    return { ok: false, error: "vision provider failed" };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "vision timed out" : (e.message || String(e)) };
  } finally {
    clearTimeout(to);
  }
}

module.exports = { analyzeImage };
