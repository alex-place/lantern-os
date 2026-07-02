#!/usr/bin/env node
// generate_scene.js — one painted scene per Three Doors turn.
//
// Standalone (no repo deps): global fetch (Node 18+). Tries a chain of image
// backends in order and returns the first that paints, so the game keeps
// working when any single provider is capped/down:
//
//   1. vertex      — Vertex AI Imagen (imagen-4.0-generate-001) via gcloud ADC
//                    refresh token + project credits. Best canon fidelity.
//   2. hf-flux     — Hugging Face router, black-forest-labs/FLUX.1-schnell
//                    (OSS model, free tier). Needs HF_TOKEN.
//   3. pollinations — https://image.pollinations.ai, keyless/free (Flux).
//   4. openai      — gpt-image-2 (falls back to dall-e-3). Needs OPENAI_API_KEY.
//
// Override the order/set with THREE_DOORS_IMAGE_BACKENDS="pollinations,hf-flux".
// Saves a landscape PNG and prints one JSON line:
//   {"ok":true,"path":"...","model":"..."}
//
// The prompt is almost always long and full of quotes/newlines, so pass it via
// a file to dodge shell-escaping:
//   node generate_scene.js --prompt-file scene.txt --out scenes/scene-fog.png

const fs = require("fs");
const os = require("os");
const path = require("path");

const OPENAI_URL = "https://api.openai.com/v1/images/generations";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "us-central1";
const VERTEX_IMAGEN_MODEL = process.env.VERTEX_IMAGEN_MODEL || "imagen-4.0-generate-001";
const HF_FLUX_URL = "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell";
const POLLINATIONS_URL = "https://image.pollinations.ai/prompt/";

function parseArgs(argv) {
  const a = { size: "1536x1024", timeoutMs: 240000 };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--prompt") a.prompt = argv[++i];
    else if (t === "--prompt-file") a.promptFile = argv[++i];
    else if (t === "--out") a.out = argv[++i];
    else if (t === "--size") a.size = argv[++i];
    else if (t === "--timeout-ms") a.timeoutMs = parseInt(argv[++i], 10) || a.timeoutMs;
    else pos.push(t);
  }
  if (!a.prompt && !a.promptFile && pos[0]) a.prompt = pos[0];
  if (!a.out && pos[1]) a.out = pos[1];
  return a;
}

// Each call gets its OWN timeout budget, so a slow/failed provider still leaves
// the next one in the chain a full budget to succeed.
async function withTimeout(ms, fn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

// dall-e-3 speaks a different size vocabulary than gpt-image; translate on fallback.
function openaiSize(model, size) {
  if (model !== "dall-e-3") return size;
  if (size === "1536x1024") return "1792x1024";
  if (size === "1024x1536") return "1024x1792";
  return "1024x1024";
}

// landscape WxH for the Flux backends (kept modest so 8GB-class serving is happy).
function landscapeWH(size) {
  const [w, h] = String(size).split("x").map((n) => parseInt(n, 10));
  if (w && h && w >= h) return { width: 1024, height: 704 };
  return { width: 704, height: 1024 };
}

// Vertex AI Imagen via Application Default Credentials (authorized_user refresh
// token). Uses the project's funded credits — best canon fidelity of the chain.
function loadAdc() {
  const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const candidates = [
    explicit,
    path.join(os.homedir(), "AppData/Roaming/gcloud/application_default_credentials.json"),
    path.join(os.homedir(), ".config/gcloud/application_default_credentials.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) {}
  }
  return null;
}

async function vertexToken(adc, ms) {
  return withTimeout(ms, async (signal) => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: adc.client_id, client_secret: adc.client_secret, refresh_token: adc.refresh_token, grant_type: "refresh_token" }),
      signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!j.access_token) throw new Error(`token exchange failed: ${(j.error_description || j.error || `HTTP ${res.status}`)}`);
    return j.access_token;
  });
}

async function backendVertexImagen(prompt, size, ms) {
  const adc = loadAdc();
  if (!adc || !adc.refresh_token) throw new Error("no Vertex ADC");
  const project = process.env.VERTEX_PROJECT || adc.quota_project_id;
  if (!project) throw new Error("no VERTEX_PROJECT");
  const [w, h] = String(size).split("x").map((n) => parseInt(n, 10));
  const aspectRatio = w && h && w >= h ? "16:9" : "9:16";
  const tok = await vertexToken(adc, ms);
  return withTimeout(ms, async (signal) => {
    const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_IMAGEN_MODEL}:predict`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt: String(prompt).slice(0, 4000) }], parameters: { sampleCount: 1, aspectRatio } }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    const j = await res.json().catch(() => ({}));
    const b64 = j && j.predictions && j.predictions[0] && j.predictions[0].bytesBase64Encoded;
    if (!b64) throw new Error("no image in response");
    return { buf: Buffer.from(b64, "base64"), model: `${VERTEX_IMAGEN_MODEL} (vertex)` };
  });
}

async function backendHfFlux(prompt, size, ms) {
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || process.env.HUGGINGFACEHUB_API_TOKEN;
  if (!token) throw new Error("no HF_TOKEN");
  const { width, height } = landscapeWH(size);
  return withTimeout(ms, async (signal) => {
    const res = await fetch(HF_FLUX_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "image/png" },
      body: JSON.stringify({ inputs: String(prompt).slice(0, 4000), parameters: { width, height }, sync_mode: true }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) throw new Error(`unexpected content-type ${ct}`);
    return { buf: Buffer.from(await res.arrayBuffer()), model: "flux.1-schnell (hf)" };
  });
}

async function backendPollinations(prompt, size, ms) {
  const { width, height } = landscapeWH(size);
  const url = `${POLLINATIONS_URL}${encodeURIComponent(String(prompt).slice(0, 2000))}?width=${width}&height=${height}&nologo=true&model=flux`;
  return withTimeout(ms, async (signal) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error("suspiciously small image");
    return { buf, model: "flux (pollinations)" };
  });
}

async function callOpenAI(model, prompt, size, apiKey, ms) {
  return withTimeout(ms, async (signal) => {
    const body = { model, prompt: String(prompt).slice(0, 4000), n: 1, size: openaiSize(model, size) };
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    const item = (json && json.data && json.data[0]) || {};
    if (item.b64_json) return { buf: Buffer.from(item.b64_json, "base64"), model };
    if (item.url) {
      const r2 = await fetch(item.url, { signal });
      if (!r2.ok) throw new Error(`fetch generated image failed: HTTP ${r2.status}`);
      return { buf: Buffer.from(await r2.arrayBuffer()), model };
    }
    throw new Error("no image data in response");
  });
}

async function backendOpenAI(prompt, size, ms) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("no OPENAI_API_KEY");
  try {
    return await callOpenAI("gpt-image-2", prompt, size, apiKey, ms);
  } catch (e) {
    process.stderr.write(`[generate_scene] gpt-image-2 failed (${e.name === "AbortError" ? "timed out" : e.message}); trying dall-e-3\n`);
    return callOpenAI("dall-e-3", prompt, size, apiKey, ms);
  }
}

const BACKENDS = {
  vertex: backendVertexImagen,
  "hf-flux": backendHfFlux,
  pollinations: backendPollinations,
  openai: backendOpenAI,
};

async function main() {
  const a = parseArgs(process.argv.slice(2));

  let prompt = a.prompt;
  if (a.promptFile) prompt = fs.readFileSync(a.promptFile, "utf8");
  prompt = String(prompt || "").trim();
  if (!prompt) { console.log(JSON.stringify({ ok: false, error: "prompt required" })); process.exit(1); }

  const out = a.out || path.join(process.cwd(), `scene-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

  const order = (process.env.THREE_DOORS_IMAGE_BACKENDS || "vertex,hf-flux,pollinations,openai")
    .split(",").map((s) => s.trim()).filter((s) => BACKENDS[s]);

  const errors = [];
  for (const name of order) {
    try {
      const { buf, model } = await BACKENDS[name](prompt, a.size, a.timeoutMs);
      if (!buf || buf.length < 1000) throw new Error("empty image");
      fs.writeFileSync(out, buf);
      console.log(JSON.stringify({ ok: true, path: path.resolve(out), backend: name, model, bytes: buf.length }));
      return;
    } catch (e) {
      const msg = e.name === "AbortError" ? "timed out" : (e.message || String(e));
      errors.push(`${name}: ${msg}`);
      process.stderr.write(`[generate_scene] ${name} failed (${msg})\n`);
    }
  }
  console.log(JSON.stringify({ ok: false, error: `all backends failed — ${errors.join(" | ")}` }));
  process.exit(1);
}

main();
