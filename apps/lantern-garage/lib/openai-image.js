// OpenAI image generation (Node, no python). Calls the OpenAI Images API directly with the
// server-side key and saves the result locally, so it serves from /images/{file} — the key
// never reaches the browser, and a local image dodges local TLS interception. Tries the newest
// model (gpt-image-1) and falls back to dall-e-3 when the org lacks gpt-image-1 access.
//
// Wired into dream-chat's "draw me X" flow (lib stays provider-agnostic — this is the OpenAI tool).
const { saveImage } = require("./image-handler");

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

async function _callOpenAI(model, prompt, size, apiKey, signal) {
  // No response_format: the current Images API rejects it. gpt-image-1 returns b64_json;
  // dall-e-3 returns a temporary url by default. We handle both downstream.
  const body = { model, prompt: String(prompt).slice(0, 4000), n: 1, size };
  const res = await fetch(OPENAI_IMAGES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = json && json.error && json.error.code;
    throw err;
  }
  const item = (json && json.data && json.data[0]) || {};
  if (!item.b64_json && !item.url) throw new Error("no image data in OpenAI response");
  return { b64: item.b64_json || null, url: item.url || null };
}

// Turn an OpenAI image result (b64 or a temporary url) into raw bytes.
async function _toBuffer(out, signal) {
  if (out.b64) return Buffer.from(out.b64, "base64");
  const res = await fetch(out.url, { signal });
  if (!res.ok) throw new Error(`fetch generated image failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// generateImage(prompt) → { ok, url, model } on success, { ok:false, error } on failure.
// Fail-safe by contract: the caller (chat) falls back to a keyless source when ok is false.
async function generateImage(prompt, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "OPENAI_API_KEY not configured" };
  const p = String(prompt || "").trim();
  if (!p) return { ok: false, error: "prompt required" };
  const size = opts.size || "1024x1024";

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), opts.timeoutMs || 60000);
  try {
    let out, model = "gpt-image-1";
    try {
      out = await _callOpenAI("gpt-image-1", p, size, apiKey, ctrl.signal);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      // gpt-image-1 needs a verified org on many keys → fall back to the widely-available dall-e-3.
      console.warn(`[openai-image] gpt-image-1 unavailable (${e.message}); falling back to dall-e-3`);
      model = "dall-e-3";
      out = await _callOpenAI("dall-e-3", p, size, apiKey, ctrl.signal);
    }
    const saved = saveImage(await _toBuffer(out, ctrl.signal), `openai-${Date.now()}.png`);
    return { ok: true, url: saved.url, filename: saved.filename, model, prompt: p };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "image generation timed out" : (e.message || String(e)) };
  } finally {
    clearTimeout(to);
  }
}

module.exports = { generateImage };
