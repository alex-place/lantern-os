/**
 * Provider management routes
 *
 * POST /api/providers/test/:provider   — test a provider key (from env or body)
 * POST /api/providers/set-key          — persist a key to .env.local
 * DELETE /api/providers/set-key        — remove a key from .env.local
 * GET  /api/providers/status           — quick summary of which providers have keys
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { sendJson } = require("../lib/http-utils");
const { refreshProviderCache, getProviderState } = require("../lib/provider-cache");
const { modelFor } = require("../lib/provider-models");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const ENV_LOCAL = path.join(REPO_ROOT, ".env.local");
// Centralized TLS gate — insecure only on Windows or explicit opt-in, not always. #869
const { llmAgent } = require("../lib/insecure-tls");

// Map UI provider ids → env var names + test strategies
const PROVIDER_META = {
  anthropic: {
    envKey: "ANTHROPIC_API_KEY",
    test: testAnthropic,
  },
  gemini: {
    envKey: "GEMINI_API_KEY",
    test: testGemini,
  },
  openai: {
    envKey: "OPENAI_API_KEY",
    test: testOpenAI,
  },
  xai: {
    envKey: "XAI_API_KEY",
    test: testXai,
  },
};

// ── Env.local helpers ─────────────────────────────────────────────────────

function readEnvLocal() {
  if (!fs.existsSync(ENV_LOCAL)) return {};
  const lines = fs.readFileSync(ENV_LOCAL, "utf8").split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) result[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function writeEnvLocal(obj) {
  const lines = Object.entries(obj).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_LOCAL, lines.join("\n") + "\n", "utf8");
}

function setEnvLocalKey(name, value) {
  const env = readEnvLocal();
  if (value === null || value === undefined) {
    delete env[name];
  } else {
    env[name] = value;
  }
  writeEnvLocal(env);
  // Hot-patch process.env so the running server picks it up immediately
  if (value === null || value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  refreshProviderCache();
}

// ── Provider test functions ───────────────────────────────────────────────

function httpsPost(opts, payload) {
  return new Promise((resolve, reject) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const req = https.request(
      { ...opts, agent: llmAgent, headers: { ...opts.headers, "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

async function testAnthropic(key) {
  const payload = JSON.stringify({
    model: modelFor("anthropic"),
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await httpsPost({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
  }, payload);
  if (r.status === 200) return { ok: true };
  const d = JSON.parse(r.body || "{}");
  throw new Error(d.error?.message || `HTTP ${r.status}`);
}

async function testGemini(key) {
  const model = modelFor("gemini");
  const payload = JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 4 } });
  const r = await httpsPost({
    hostname: "generativelanguage.googleapis.com",
    path: `/v1beta/models/${model}:generateContent?key=${key}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, payload);
  if (r.status === 200) return { ok: true };
  const d = JSON.parse(r.body || "{}");
  throw new Error(d.error?.message || `HTTP ${r.status}`);
}

async function testOpenAI(key) {
  const payload = JSON.stringify({ model: modelFor("openai"), messages: [{ role: "user", content: "hi" }], max_tokens: 4 });
  const r = await httpsPost({
    hostname: "api.openai.com",
    path: "/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
  }, payload);
  if (r.status === 200) return { ok: true };
  const d = JSON.parse(r.body || "{}");
  throw new Error(d.error?.message || `HTTP ${r.status}`);
}

async function testXai(key) {
  const payload = JSON.stringify({ model: modelFor("xai"), messages: [{ role: "user", content: "hi" }], max_tokens: 4 });
  const r = await httpsPost({
    hostname: "api.x.ai",
    path: "/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
  }, payload);
  if (r.status === 200) return { ok: true };
  const d = JSON.parse(r.body || "{}");
  throw new Error(d.error?.message || `HTTP ${r.status}`);
}

// ── Route handler ─────────────────────────────────────────────────────────

module.exports = async (req, res, url) => {
  const p = url.pathname;

  // GET /api/providers/status
  if (p === "/api/providers/status" && req.method === "GET") {
    const state = getProviderState();
    const summary = Object.entries(PROVIDER_META).map(([id, meta]) => ({
      id,
      hasKey: !!(process.env[meta.envKey] && process.env[meta.envKey].trim()),
    }));
    sendJson(res, { ok: true, providers: summary });
    return true;
  }

  // POST /api/providers/test/:provider
  const testMatch = p.match(/^\/api\/providers\/test\/([a-z]+)$/);
  if (testMatch && req.method === "POST") {
    const id = testMatch[1];
    const meta = PROVIDER_META[id];
    if (!meta) { sendJson(res, { error: "unknown provider" }, 400); return true; }

    // Read body for optional key override
    let body = "";
    await new Promise(r => { req.on("data", c => body += c); req.on("end", r); });
    let keyOverride = null;
    try { keyOverride = JSON.parse(body || "{}").key || null; } catch {}

    const key = keyOverride || process.env[meta.envKey] || "";
    if (!key) {
      sendJson(res, { error: "no_key", message: `${meta.envKey} is not set` }, 400);
      return true;
    }

    try {
      await meta.test(key);
      sendJson(res, { ok: true, provider: id });
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 502);
    }
    return true;
  }

  // POST /api/providers/set-key  { provider, key }
  if (p === "/api/providers/set-key" && req.method === "POST") {
    let body = "";
    await new Promise(r => { req.on("data", c => body += c); req.on("end", r); });
    let parsed;
    try { parsed = JSON.parse(body); } catch { sendJson(res, { error: "invalid json" }, 400); return true; }

    const { provider, key } = parsed;
    const meta = PROVIDER_META[provider];
    if (!meta) { sendJson(res, { error: "unknown provider" }, 400); return true; }
    if (!key || typeof key !== "string" || key.trim().length < 8) {
      sendJson(res, { error: "key too short" }, 400); return true;
    }

    try {
      setEnvLocalKey(meta.envKey, key.trim());
      sendJson(res, { ok: true, provider, envKey: meta.envKey, message: `${meta.envKey} written to .env.local` });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return true;
  }

  // DELETE /api/providers/set-key  { provider }
  if (p === "/api/providers/set-key" && req.method === "DELETE") {
    let body = "";
    await new Promise(r => { req.on("data", c => body += c); req.on("end", r); });
    let parsed;
    try { parsed = JSON.parse(body); } catch { sendJson(res, { error: "invalid json" }, 400); return true; }

    const { provider } = parsed;
    const meta = PROVIDER_META[provider];
    if (!meta) { sendJson(res, { error: "unknown provider" }, 400); return true; }

    try {
      setEnvLocalKey(meta.envKey, null);
      sendJson(res, { ok: true, provider, message: `${meta.envKey} removed from .env.local` });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return true;
  }

  return false;
};
