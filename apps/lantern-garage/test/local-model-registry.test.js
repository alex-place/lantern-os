"use strict";

/**
 * test/local-model-registry.test.js
 *
 * The Σ₀ local-model adapter: capability-GATED, VRAM-detected selection, the
 * kernel-stays-strict rule, and the self-converges contract that drives whether
 * the Core wraps a model in loopedReason().
 * See docs/research/2026-06-28-keystone-chat-frontier-stack.md (#1387).
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/local-model-registry.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const reg = require("../lib/local-model-registry");

function freshEnv(fn) {
  // Snapshot/restore the env knobs the registry reads, and clear its caches.
  // Detection is disabled (VRAM_AUTODETECT=0) so the "default box" is the
  // deterministic 8GB fallback regardless of the host machine's actual GPU.
  const snap = {
    VRAM_BUDGET_GB: process.env.VRAM_BUDGET_GB,
    LOCAL_CAPABILITY_FIRST: process.env.LOCAL_CAPABILITY_FIRST,
    VRAM_AUTODETECT: process.env.VRAM_AUTODETECT,
    LOCAL_ALLOW_UNVERIFIED: process.env.LOCAL_ALLOW_UNVERIFIED,
  };
  try {
    delete process.env.VRAM_BUDGET_GB;
    delete process.env.LOCAL_CAPABILITY_FIRST;
    delete process.env.LOCAL_ALLOW_UNVERIFIED;
    process.env.VRAM_AUTODETECT = "0";
    reg._resetCache();
    fn();
  } finally {
    for (const [k, v] of Object.entries(snap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    reg._resetCache();
  }
}

test("capability-gated default: best-fitting coder leads coding (8GB box → Qwen2.5)", () => {
  freshEnv(() => {
    const chain = reg.selectChain("coding");
    assert.equal(chain[0], "qwen2.5-coder", "highest-capability coder that fits 8GB leads");
    assert.ok(chain.includes("ouro:latest"), "Ouro stays in the chain (research front, behind)");
    assert.ok(
      chain.indexOf("qwen2.5-coder") < chain.indexOf("ouro:latest"),
      "Ouro is no longer the universal coding default",
    );
    assert.ok(!chain.includes("qwen3.6-27b"), "the 27B frontier is gated out of the 8GB box");
  });
});

test("≥24GB box → the frontier Qwen 3.6-27B leads coding (local-frontier-when-available)", () => {
  freshEnv(() => {
    const chain = reg.selectChain("coding", { vramBudgetGB: 24 });
    assert.equal(chain[0], "qwen3.6-27b", "frontier coder leads once the box can run it");
    assert.ok(chain.includes("qwen2.5-coder"), "the 8GB coder stays available behind it");
    assert.ok(
      chain.indexOf("qwen3.6-27b") < chain.indexOf("qwen2.5-coder"),
      "frontier outranks the 8GB coder by capability",
    );
  });
});

test("LOCAL_CAPABILITY_FIRST=0 forces rank-order → Ouro leads coding (research/escape)", () => {
  freshEnv(() => {
    process.env.LOCAL_CAPABILITY_FIRST = "0";
    reg._resetCache();
    const chain = reg.selectChain("coding");
    assert.equal(chain[0], "ouro:latest", "rank-order restores Ouro-first");
  });
});

test("LOCAL_CAPABILITY_FIRST=1 keeps capability-first (Qwen leads the 8GB box)", () => {
  freshEnv(() => {
    process.env.LOCAL_CAPABILITY_FIRST = "1";
    reg._resetCache();
    assert.equal(reg.selectBest("coding"), "qwen2.5-coder");
  });
});

test("VRAM budget gates out models that don't fit the box", () => {
  freshEnv(() => {
    // A 4GB box: Qwen (5GB) and the 27B (18GB) are excluded; Ouro (3GB) survives.
    const chain = reg.selectChain("coding", { vramBudgetGB: 4 });
    assert.ok(chain.includes("ouro:latest"), "Ouro fits 4GB");
    assert.ok(!chain.includes("qwen2.5-coder"), "Qwen (5GB) must be gated out of a 4GB box");
    assert.ok(!chain.includes("qwen3.6-27b"), "the 27B frontier is gated out of a 4GB box");
    assert.equal(chain[0], "ouro:latest", "only Ouro fits → it leads (graceful degrade)");
  });
});

test("capability-first STILL respects the VRAM gate (no oversized lead)", () => {
  freshEnv(() => {
    const chain = reg.selectChain("coding", { capabilityFirst: true, vramBudgetGB: 4 });
    assert.equal(chain[0], "ouro:latest", "a model can't lead a box it doesn't fit");
  });
});

test("selfConverges contract: Ouro internal, Qwen wrapped, 27B wrapped, unknown wrapped", () => {
  freshEnv(() => {
    assert.equal(reg.selfConverges("ouro:latest"), true, "Ouro Q-exits internally");
    assert.equal(reg.selfConverges("keystone-ft"), true, "Keystone-ft is an Ouro fine-tune");
    assert.equal(reg.selfConverges("qwen2.5-coder"), false, "Qwen is single-pass → must be wrapped");
    assert.equal(reg.selfConverges("qwen3.6-27b"), false, "the 27B coder is single-pass → wrapped");
    assert.equal(reg.selfConverges("some-unknown-model"), false, "unknown → wrapped (grounding by default)");
  });
});

test("the frontier 27B is a tool-calling coder", () => {
  freshEnv(() => {
    assert.equal(reg.toolCalling("qwen3.6-27b"), true, "native qwen3_coder tool format");
    const e = reg.getEntry("qwen3.6-27b");
    assert.ok(e && e.vramGB >= 16, "registered as a 24GB-tier model");
    assert.ok(e.taskTypes.includes("coding") && !e.taskTypes.includes("kernel"), "coder, not a kernel model");
  });
});

test("getEntry matches served version suffixes both ways", () => {
  freshEnv(() => {
    // Registry id "qwen2.5-coder" should resolve a served "qwen2.5-coder:7b".
    assert.ok(reg.getEntry("qwen2.5-coder:7b"), "prefix match on served tag");
    assert.equal(reg.toolCalling("qwen2.5-coder:7b"), true);
    assert.equal(reg.getEntry("totally-different"), null);
  });
});

test("kernel task keeps the Σ₀ kernel models, not the coder levers", () => {
  freshEnv(() => {
    const chain = reg.selectChain("kernel");
    assert.ok(chain.includes("keystone-ft") || chain.includes("ouro:latest"), "kernel models present");
    assert.ok(!chain.includes("qwen2.5-coder"), "Qwen is not a kernel model");
    assert.ok(!chain.includes("qwen3.6-27b"), "the 27B frontier is not a kernel model");
  });
});

test("VRAM budget: env override wins; detection-off falls back to the 8GB box", () => {
  freshEnv(() => {
    // freshEnv sets VRAM_AUTODETECT=0 → deterministic fallback.
    assert.equal(reg._vramBudgetGB(), 8, "no override + detection off → 8GB fallback");
    process.env.VRAM_BUDGET_GB = "24";
    assert.equal(reg._vramBudgetGB(), 24, "explicit env override always wins");
  });
});

test("grounding gate: an unverified candidate (LoopCoder-v2) never auto-leads", () => {
  freshEnv(() => {
    // 8GB box, capability-first: LoopCoder-v2 (predicted 0.84) would out-score
    // Qwen2.5-Coder (0.80) by raw capability, but it's verified:false → it must
    // sort BEHIND every reproduced peer, so Qwen still leads.
    const chain = reg.selectChain("coding");
    assert.equal(chain[0], "qwen2.5-coder", "verified coder leads despite lower predicted score");
    assert.ok(chain.includes("loopcoder-v2"), "the candidate is registered and eligible (fits 8GB)");
    assert.ok(
      chain.indexOf("qwen2.5-coder") < chain.indexOf("loopcoder-v2"),
      "unverified candidate is demoted below the reproduced lead",
    );
    assert.equal(reg.isVerified("loopcoder-v2"), false, "LoopCoder-v2 is vendor-claimed, not reproduced");
    assert.equal(reg.isVerified("qwen2.5-coder"), true, "absent `verified` → treated as verified");
  });
});

test("LOCAL_ALLOW_UNVERIFIED=1 lifts the gate (the probe/eval run can lead it)", () => {
  freshEnv(() => {
    process.env.LOCAL_ALLOW_UNVERIFIED = "1";
    reg._resetCache();
    // Gate lifted → pure capability order; LoopCoder's predicted 0.84 now leads the 8GB box.
    assert.equal(reg.selectBest("coding"), "loopcoder-v2", "unverified candidate leads only when explicitly allowed");
  });
});

test("LoopCoder-v2 contract: looped-but-wrapped, no tools, fits the 8GB box", () => {
  freshEnv(() => {
    assert.equal(reg.selfConverges("loopcoder-v2"), false, "fixed 2-loop PLT is not a Q-exit certificate → Core wraps it");
    assert.equal(reg.toolCalling("loopcoder-v2"), false, "tool-calling undocumented → false");
    const e = reg.getEntry("loopcoder-v2");
    assert.ok(e && e.vramGB <= 8, "7B @ 4-bit targets the 8GB box");
    assert.ok(e.taskTypes.includes("coding") && !e.taskTypes.includes("kernel"), "coder, not a kernel model");
  });
});

test("_detectVramGB returns a number or null and is memoized", () => {
  freshEnv(() => {
    const d = reg._detectVramGB();
    assert.ok(d === null || (typeof d === "number" && d > 0), "VRAM probe is number|null");
    assert.equal(reg._detectVramGB(), d, "memoized within a cache window");
  });
});

// ── resolveLocalLead: the authoritative lead + pin precedence (the swap) ───────
// This is the function keystone chat calls. The bug it fixes: a stale
// OLLAMA_MODEL=ouro:latest pin front-jumped the chain and defeated the capability
// swap. The lead must be the registry's pick, not the stale pin. Tests pass `pin`
// explicitly so they're deterministic regardless of the host's real OLLAMA_MODEL.

test("resolveLocalLead: a stale registry-managed pin (ouro) does NOT defeat the swap", () => {
  freshEnv(() => {
    // The exact production bug: OLLAMA_MODEL=ouro:latest on an 8GB box.
    const r = reg.resolveLocalLead("coding", { pin: "ouro:latest" });
    assert.equal(r.lead, "qwen2.5-coder", "the capability pick leads, not the stale pin");
    assert.equal(r.chain[0], "qwen2.5-coder", "and it's the chain head");
    assert.ok(r.chain.includes("ouro:latest"), "the pinned model stays a candidate (fallback)");
    assert.equal(r.pinHonored, false, "a registry-managed pin is not honored as the lead");
  });
});

test("resolveLocalLead: a custom (non-registry) pin LEADS — operator's deliberate choice wins", () => {
  freshEnv(() => {
    const r = reg.resolveLocalLead("coding", { pin: "deepseek-coder:33b" });
    assert.equal(r.lead, "deepseek-coder:33b", "the registry has no opinion on it → honor the pin");
    assert.equal(r.chain[0], "deepseek-coder:33b", "and it leads the chain");
    assert.equal(r.pinHonored, true, "flagged as an honored operator pin");
    assert.ok(r.chain.includes("qwen2.5-coder"), "registry models still trail as fallbacks");
  });
});

test("resolveLocalLead: LOCAL_CAPABILITY_FIRST=0 restores Ouro-first (rank-order escape)", () => {
  freshEnv(() => {
    process.env.LOCAL_CAPABILITY_FIRST = "0";
    reg._resetCache();
    const r = reg.resolveLocalLead("coding", { pin: "ouro:latest" });
    assert.equal(r.lead, "ouro:latest", "rank-order puts the Σ₀ kernel model first");
    assert.equal(r.capabilityFirst, false, "decision reports rank-order mode");
  });
});

test("resolveLocalLead: caller fallbacks are appended as a deduped tail", () => {
  freshEnv(() => {
    const r = reg.resolveLocalLead("coding", { pin: "", fallback: ["mistral", "qwen2.5-coder", "satyr"] });
    assert.equal(r.lead, "qwen2.5-coder", "registry lead still wins over fallbacks");
    assert.equal(r.chain.filter((m) => m === "qwen2.5-coder").length, 1, "no duplicate of a model in both registry + fallback");
    assert.ok(r.chain.includes("mistral") && r.chain.includes("satyr"), "novel fallbacks survive as candidates");
  });
});

test("resolveLocalLead: ≥24GB box → the frontier 27B leads (no pin)", () => {
  freshEnv(() => {
    const r = reg.resolveLocalLead("coding", { pin: "", vramBudgetGB: 24 });
    assert.equal(r.lead, "qwen3.6-27b", "the box can run the frontier coder, so it leads");
    assert.match(r.reason, /24GB/, "reason explains the box budget");
  });
});

test("resolveLocalLead: defaults the pin to OLLAMA_MODEL from the env", () => {
  freshEnv(() => {
    // freshEnv does not manage OLLAMA_MODEL, so snapshot/restore it here.
    const prev = process.env.OLLAMA_MODEL;
    try {
      process.env.OLLAMA_MODEL = "ouro:latest";
      reg._resetCache();
      const r = reg.resolveLocalLead("coding"); // no explicit pin → reads env
      assert.equal(r.lead, "qwen2.5-coder", "env pin is treated identically (registry-managed → no front-jump)");
      assert.ok(r.chain.includes("ouro:latest"), "env-pinned model is still a candidate");
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_MODEL;
      else process.env.OLLAMA_MODEL = prev;
    }
  });
});
