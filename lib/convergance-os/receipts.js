/**
 * Convergance OS — Receipt Engine
 *
 * Every routed model call produces a PCSF-style receipt.
 * Receipts are appended to data/pcsf/convergance-receipts.jsonl.
 */

const fs = require("fs");
const path = require("path");

const RECEIPT_PATH = path.resolve(__dirname, "../../data/pcsf/convergance-receipts.jsonl");

function createReceipt({ profile, provider, intent, ollamaUsed, latencyMs, success, error }) {
  return {
    generatedAt: new Date().toISOString(),
    profile: profile || "lantern-csf-dream",
    intent: intent || "dream_chat",
    capacityClass: ollamaUsed ? "local_model" : "provider_backed",
    provider: provider || "unknown",
    metered: !ollamaUsed,
    privacyBoundary: ollamaUsed ? "internal" : "external",
    localProof: ollamaUsed ? "ollama_response" : "not_used",
    providerProof: ollamaUsed ? "not_used" : `${provider}_api_response`,
    fallbackUsed: !ollamaUsed,
    claimBoundary: "live",
    latencyMs: latencyMs || 0,
    success: success !== false,
    error: error || null,
  };
}

function appendReceipt(receipt) {
  try {
    const dir = path.dirname(RECEIPT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(RECEIPT_PATH, JSON.stringify(receipt) + "\n");
  } catch (e) {
    console.error("[Convergance] Receipt write failed:", e.message);
  }
}

function logRouteDecision(opts) {
  const receipt = createReceipt(opts);
  appendReceipt(receipt);
  return receipt;
}

module.exports = { createReceipt, appendReceipt, logRouteDecision };
