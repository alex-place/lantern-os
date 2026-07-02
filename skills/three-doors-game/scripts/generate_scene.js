#!/usr/bin/env node
// generate_scene.js — one painted scene per Three Doors turn.
//
// Standalone (no repo deps): global fetch (Node 18+), OPENAI_API_KEY from env.
// Tries gpt-image-2, falls back to dall-e-3 for older keys. Saves a landscape
// PNG and prints a single JSON line: {"ok":true,"path":"...","model":"..."}.
//
// The prompt is almost always long and full of quotes/newlines, so pass it via
// a file to dodge shell-escaping:
//   node generate_scene.js --prompt-file scene.txt --out scenes/scene-fog.png
// Positional also works for short prompts:
//   node generate_scene.js "a cloaked figure at a door" out.png

const fs = require("fs");
const path = require("path");

const OPENAI_URL = "https://api.openai.com/v1/images/generations";

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

// dall-e-3 speaks a different size vocabulary than gpt-image; translate on fallback.
function sizeFor(model, size) {
  if (model !== "dall-e-3") return size;
  if (size === "1536x1024") return "1792x1024";
  if (size === "1024x1536") return "1024x1792";
  return "1024x1024";
}

// Each call gets its OWN timeout budget, so a slow gpt-image-2 that times out
// still leaves the dall-e-3 fallback a full budget to succeed.
async function withTimeout(ms, fn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(model, prompt, size, apiKey, ms) {
  return withTimeout(ms, async (signal) => {
    const body = { model, prompt: String(prompt).slice(0, 4000), n: 1, size: sizeFor(model, size) };
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
    if (!item.b64_json && !item.url) throw new Error("no image data in response");
    return { b64: item.b64_json || null, url: item.url || null };
  });
}

async function toBuffer(out, ms) {
  if (out.b64) return Buffer.from(out.b64, "base64");
  return withTimeout(ms, async (signal) => {
    const res = await fetch(out.url, { signal });
    if (!res.ok) throw new Error(`fetch generated image failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.log(JSON.stringify({ ok: false, error: "OPENAI_API_KEY not set" })); process.exit(1); }

  let prompt = a.prompt;
  if (a.promptFile) prompt = fs.readFileSync(a.promptFile, "utf8");
  prompt = String(prompt || "").trim();
  if (!prompt) { console.log(JSON.stringify({ ok: false, error: "prompt required" })); process.exit(1); }

  const out = a.out || path.join(process.cwd(), `scene-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

  try {
    let model = "gpt-image-2", result;
    try {
      result = await callOpenAI("gpt-image-2", prompt, a.size, apiKey, a.timeoutMs);
    } catch (e) {
      // Slow/timed-out or unavailable gpt-image-2 both fall through to dall-e-3,
      // which gets its own fresh budget.
      process.stderr.write(`[generate_scene] gpt-image-2 failed (${e.name === "AbortError" ? "timed out" : e.message}); trying dall-e-3\n`);
      model = "dall-e-3";
      result = await callOpenAI("dall-e-3", prompt, a.size, apiKey, a.timeoutMs);
    }
    const buf = await toBuffer(result, a.timeoutMs);
    fs.writeFileSync(out, buf);
    console.log(JSON.stringify({ ok: true, path: path.resolve(out), model, bytes: buf.length }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.name === "AbortError" ? "timed out" : (e.message || String(e)) }));
    process.exit(1);
  }
}

main();
