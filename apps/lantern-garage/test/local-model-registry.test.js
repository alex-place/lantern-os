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
  };
  try {
    delete process.env.VRAM_BUDGET_GB;
    delete process.env.LOCAL_CAPABILITY_FIRST;
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

test("_detectVramGB returns a number or null and is memoized", () => {
  freshEnv(() => {
    const d = reg._detectVramGB();
    assert.ok(d === null || (typeof d === "number" && d > 0), "VRAM probe is number|null");
    assert.equal(reg._detectVramGB(), d, "memoized within a cache window");
  });
});
