"use strict";
/**
 * ollama-error.js
 *
 * Ollama reports failures as an error ENVELOPE — `{"error":"model 'X' not found"}` —
 * not as `message.content`. The chat paths read `json.message?.content`, get undefined,
 * resolve `""`, and silently fall through to a generic `no_provider_configured` — which
 * hides the real, operator-fixable reason: the configured `OLLAMA_MODEL` isn't installed
 * (e.g. `.env` pins `lantern-sigma0-coder-loop` but only `llama3.1:8b` is pulled). The
 * user is told "no provider" when the fix is one `ollama pull` away.
 *
 * classifyOllamaError() turns that envelope into the same `lastProviderError` shape the
 * cloud paths already use, so callers surface an honest, actionable error instead.
 * (Honest-error family: #2725 trader_positions, #2760 mcp-client.)
 */

// → null when the response is normal content; otherwise a lastProviderError-shaped object.
function classifyOllamaError(json, model) {
  const raw = json && typeof json.error === "string" ? json.error.trim() : "";
  if (!raw) return null;
  const missing = /not\s*found|no such model|try pulling|pull the model|not installed/i.test(raw);
  return {
    provider: "ollama",
    status: 0,
    code: missing ? "ollama_model_not_installed" : "ollama_error",
    type: missing ? "model_not_installed" : "error",
    message: missing
      ? `Local model '${model}' is not installed in Ollama (${raw}). Run \`ollama pull ${model}\`, or set OLLAMA_MODEL to an installed model.`
      : `Ollama error: ${raw}`,
  };
}

module.exports = { classifyOllamaError };
