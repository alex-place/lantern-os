"use strict";

// Entailment verifier — is the PROPOSED change actually grounded in what the
// backend claims it did? Two local layers:
//
//   1. patch-consistency (always on, no model, no network): every added ('+')
//      line in the backend's stated `patchPreview` must actually appear in the
//      proposed file content. Catches a backend that narrates a diff its real
//      output doesn't contain — a hallucinated edit, the code analogue of a
//      claim not entailed by its source. A FAILURE here is decisive (block it);
//      a pass alone is a guard, not proof the change works.
//
//   2. MiniCheck (optional, ~770M, runs local): if MINICHECK_ENDPOINT is set,
//      score the task/claim's entailment against the proposed diff. Absent →
//      this layer is skipped (interface real, model optional — mirrors the
//      openhands adapter's graceful degradation). A real score IS decisive.
//
// Neither layer ever throws into the caller: infra errors degrade to `skipped`
// with a reason, so a flaky endpoint can't turn a good change into a failure.

const http = require("http");
const https = require("https");

function addedLines(patchPreview) {
  return String(patchPreview || "")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1).trim())
    .filter((l) => l.length > 0);
}

// Layer 1 — deterministic patch↔content consistency. Dependency-free, always runs.
function patchConsistency({ files, patchPreview }) {
  const added = addedLines(patchPreview);
  if (added.length === 0) {
    return { name: "patch-consistency", skipped: true, reason: "no added lines in patchPreview to check" };
  }
  const haystack = (files || []).map((f) => String(f.content || "")).join("\n");
  const missing = added.filter((line) => !haystack.includes(line));
  const passed = missing.length === 0;
  return {
    name: "patch-consistency",
    decisive: !passed, // only a FAILURE is decisive; a pass is a guard, not proof
    skipped: false,
    passed,
    evidence: passed
      ? { addedLines: added.length, allPresentInProposedContent: true }
      : { addedLines: added.length, missingCount: missing.length, missingSample: missing.slice(0, 5) },
  };
}

function minicheckAvailable(opts = {}) {
  return !!(opts.minicheckEndpoint || process.env.MINICHECK_ENDPOINT);
}

function postJson(endpoint, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(endpoint);
    } catch (e) {
      return reject(new Error("bad MINICHECK_ENDPOINT: " + e.message));
    }
    const lib = u.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const req = lib.request(
      u,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": payload.length },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data || "{}") });
          } catch (e) {
            reject(new Error("non-JSON response: " + e.message));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("minicheck timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

// Layer 2 — MiniCheck entailment (optional). POSTs { doc, claim } and expects a
// { prob } (or { score }/{ label }) back; threshold configurable (default 0.5).
async function minicheck({ files, task, patchPreview }, opts = {}) {
  const endpoint = opts.minicheckEndpoint || process.env.MINICHECK_ENDPOINT;
  if (!endpoint) {
    return {
      name: "minicheck",
      skipped: true,
      reason: "MINICHECK_ENDPOINT not set",
      installHint: "serve a MiniCheck model (e.g. bespokelabs/bespoke-minicheck / MiniCheck-Flan-T5) and set MINICHECK_ENDPOINT",
    };
  }
  const doc = (files || []).map((f) => `# ${f.path}\n${f.content}`).join("\n\n").slice(0, 20000);
  const claim = (String(task || "").trim() || addedLines(patchPreview).join(" ")).slice(0, 2000);
  const threshold = opts.minicheckThreshold != null ? opts.minicheckThreshold : 0.5;
  try {
    const { status, json } = await postJson(endpoint, { doc, claim }, opts.minicheckTimeoutMs || 20000);
    if (status && status >= 400) {
      return { name: "minicheck", skipped: true, reason: `endpoint HTTP ${status}` };
    }
    const prob = typeof json.prob === "number" ? json.prob : typeof json.score === "number" ? json.score : json.label === 1 || json.label === "1" || json.entailed === true ? 1 : json.label === 0 || json.entailed === false ? 0 : null;
    if (prob == null) {
      return { name: "minicheck", skipped: true, reason: "response had no prob/score/label field" };
    }
    const passed = prob >= threshold;
    return { name: "minicheck", decisive: true, skipped: false, passed, evidence: { prob, threshold } };
  } catch (e) {
    return { name: "minicheck", skipped: true, reason: `minicheck call failed: ${e.message}` };
  }
}

module.exports = { patchConsistency, minicheck, minicheckAvailable, addedLines };
