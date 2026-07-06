"use strict";

// Ollama adapter — direct local-model code generation (the local-first backend).
// Generates a solution from the registry-resolved local engine (Qwen2.5-Coder via
// Ollama :11434) and PROPOSES it as a file; the control plane holds it for approval.
// Unlike the Aider/OpenHands agents this has no multi-step overhead, so it makes the
// wrapped-vs-raw benchmark measurable on the same model (#2173).

const http = require("http");

function _base() {
  return process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
}

function _chat(base, model, prompt, maxTokens, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: prompt }],
      options: { num_predict: maxTokens, top_p: 0.95, repeat_penalty: 1.1 },
    });
    const u = new URL(base.replace(/\/$/, "") + "/api/chat");
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            resolve(((j.message || {}).content || j.response || "").trim());
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("ollama timeout")));
    req.write(body);
    req.end();
  });
}

// Strip the first fenced code block so the applied file is valid source (not markdown).
function _extractCode(text) {
  const m = /```(?:python|py)?\s*\n([\s\S]*?)```/i.exec(text || "");
  return (m ? m[1] : text || "").trim();
}

module.exports = {
  name: "ollama",
  installHint: "ollama pull qwen2.5-coder  (serves on :11434)",
  async available() {
    const base = _base();
    return new Promise((resolve) => {
      try {
        const u = new URL(base.replace(/\/$/, "") + "/api/tags");
        const req = http.get(
          { hostname: u.hostname, port: u.port, path: u.pathname, timeout: 2000 },
          (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          }
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
      } catch {
        resolve(false);
      }
    });
  },
  async propose({ task, model }) {
    const base = _base();
    const mdl = model || "qwen2.5-coder:latest";
    const reply = await _chat(
      base,
      mdl,
      `${task}\n\nRespond with ONLY a single Python code block — the function(s), no prose.`,
      512,
      120000
    );
    const code = _extractCode(reply);
    if (!code) return { ok: false, error: "ollama produced no code" };
    return {
      ok: true,
      backend: "ollama",
      model: mdl,
      costUsd: 0,
      filesChanged: [{ path: "solution.py", content: code + "\n" }],
      patchPreview: `+++ b/solution.py`,
    };
  },
};
