"use strict";

/**
 * test/local-model-registry.test.js
 *
 * The Σ₀ local-model adapter: VRAM-gated selection, Ouro-default vs
 * capability-first ordering, and the self-converges contract that drives whether
 * the Core wraps a model in loopedReason(). See docs/SIGMA0-MODEL-ADAPTER.md.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/local-model-registry.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const reg = require("../lib/local-model-registry");

function freshEnv(fn) {
  // Snapshot/restore the env knobs the registry reads, and clear its TTL cache.
  const snap = {
    VRAM_BUDGET_GB: process.env.VRAM_BUDGET_GB,
    LOCAL_CAPABILITY_FIRST: process.env.LOCAL_CAPABILITY_FIRST,
  };
  try {
    delete process.env.VRAM_BUDGET_GB;
    delete process.env.LOCAL_CAPABILITY_FIRST;
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

test("Ouro is the Σ₀-native default lead for coding", () => {
  freshEnv(() => {
    const chain = reg.selectChain("coding");
    assert.equal(chain[0], "ouro:latest", "Ouro must lead coding by default");
    assert.ok(chain.includes("qwen2.5-coder"), "Qwen is in the coding chain as a candidate");
    assert.ok(
      chain.indexOf("ouro:latest") < chain.indexOf("qwen2.5-coder"),
      "Ouro ranks ahead of Qwen by default",
    );
  });
});

test("capability-first lets Qwen lead coding (the opt-in lever)", () => {
  freshEnv(() => {
    const chain = reg.selectChain("coding", { capabilityFirst: true });
    assert.equal(chain[0], "qwen2.5-coder", "highest capabilityScore that fits leads");
    assert.ok(chain.includes("ouro:latest"), "Ouro stays available behind it");
  });
});

test("LOCAL_CAPABILITY_FIRST=1 env flag flips the default", () => {
  freshEnv(() => {
    process.env.LOCAL_CAPABILITY_FIRST = "1";
    reg._resetCache();
    assert.equal(reg.selectBest("coding"), "qwen2.5-coder");
  });
});

test("VRAM budget gates out models that don't fit the box", () => {
  freshEnv(() => {
    // A 4GB box: Qwen (5GB) is excluded; Ouro (3GB) survives.
    const chain = reg.selectChain("coding", { vramBudgetGB: 4 });
    assert.ok(chain.includes("ouro:latest"), "Ouro fits 4GB");
    assert.ok(!chain.includes("qwen2.5-coder"), "Qwen (5GB) must be gated out of a 4GB box");
  });
});

test("capability-first STILL respects the VRAM gate (no oversized lead)", () => {
  freshEnv(() => {
    const chain = reg.selectChain("coding", { capabilityFirst: true, vramBudgetGB: 4 });
    assert.equal(chain[0], "ouro:latest", "Qwen can't lead a box it doesn't fit");
  });
});

test("selfConverges contract: Ouro internal, Qwen wrapped, unknown wrapped", () => {
  freshEnv(() => {
    assert.equal(reg.selfConverges("ouro:latest"), true, "Ouro Q-exits internally");
    assert.equal(reg.selfConverges("keystone-ft"), true, "Keystone-ft is an Ouro fine-tune");
    assert.equal(reg.selfConverges("qwen2.5-coder"), false, "Qwen is single-pass → must be wrapped");
    assert.equal(reg.selfConverges("some-unknown-model"), false, "unknown → wrapped (grounding by default)");
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

test("kernel task keeps the Σ₀ kernel models, not the coder lever", () => {
  freshEnv(() => {
    const chain = reg.selectChain("kernel");
    assert.ok(chain.includes("keystone-ft") || chain.includes("ouro:latest"), "kernel models present");
    assert.ok(!chain.includes("qwen2.5-coder"), "Qwen is not a kernel model");
  });
});

test("default VRAM budget is the 8GB box", () => {
  freshEnv(() => {
    assert.equal(reg._vramBudgetGB(), 8);
  });
});
