// local-engine-qwen.test.js — #2171: the supported Qwen2.5-Coder is the DEFAULT local
// coding engine on the 8GB box; Ouro stays kernel/research-only. See docs/OSS-BASELINE.md.
// Run: node apps/lantern-garage/test/local-engine-qwen.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Deterministic box: force the 8GB fallback (no nvidia-smi dependence), no operator pin.
process.env.VRAM_AUTODETECT = "0";
delete process.env.VRAM_BUDGET_GB;
delete process.env.OLLAMA_MODEL;
delete process.env.LOCAL_CAPABILITY_FIRST;

const reg = require("../lib/local-model-registry");
const cb = require("../lib/coding-backend");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("  ok  -", name);
  } catch (e) {
    failures++;
    console.error("  FAIL-", name, "\n      ", e.message);
  }
}
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kb-eng-"));
}

(async () => {
  reg._resetCache();

  await check("Qwen2.5-Coder is the coding lead on the 8GB box (#2171)", () => {
    const best = reg.selectBest("coding");
    assert.strictEqual(best, "qwen2.5-coder:latest", `expected qwen lead, got ${best}`);
  });

  await check("Qwen leads reasoning + default too", () => {
    assert.strictEqual(reg.selectBest("reasoning"), "qwen2.5-coder:latest");
    assert.strictEqual(reg.selectBest("default"), "qwen2.5-coder:latest");
  });

  await check("Ouro is KERNEL-only — not a coding/reasoning/default candidate", () => {
    assert(!reg.selectChain("coding").includes("ouro:latest"), "ouro must not be in coding chain");
    assert(!reg.selectChain("default").includes("ouro:latest"), "ouro must not be in default chain");
    assert(reg.selectChain("kernel").includes("ouro:latest"), "ouro must remain in the kernel chain");
  });

  await check("Qwen sits AHEAD of the unverified PLT research coder", () => {
    const chain = reg.selectChain("coding");
    const iq = chain.indexOf("qwen2.5-coder:latest");
    const ip = chain.indexOf("keystone-sigma0-plt");
    assert(iq === 0, "qwen must lead coding");
    if (ip !== -1) assert(iq < ip, "qwen must sort ahead of the PLT coder");
  });

  await check("Qwen is VERIFIED on-box (#2173: coding-golden exec pass@1 0.96) + non-self-converging", () => {
    assert.strictEqual(reg.isVerified("qwen2.5-coder:latest"), true); // reproduced by us, not vendor-claimed
    assert.strictEqual(reg.toolCalling("qwen2.5-coder:latest"), true);
    assert.strictEqual(reg.selfConverges("qwen2.5-coder:latest"), false); // Core wraps it in loopedReason()
  });

  await check("coding-backend defaultLocalEngine() resolves to Qwen", () => {
    const e = cb.defaultLocalEngine("coding");
    assert.strictEqual(e.lead, "qwen2.5-coder:latest", `got ${e.lead}`);
    assert(/11434/.test(e.endpoint || ""), "should serve on the standard :11434");
  });

  await check("a proposal's receipt records the resolved local engine", async () => {
    const r = await cb.runCodingTask({ task: "add a note", repoPath: tmp(), backend: "mock" }, { dataDir: tmp() });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.localEngine, "qwen2.5-coder:latest");
    assert.strictEqual(r.receipt.localEngine, "qwen2.5-coder:latest");
    assert.strictEqual(r.receipt.model, "qwen2.5-coder:latest"); // mock echoes the resolved engine
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall local-engine (#2171) tests passed");
  process.exit(failures ? 1 : 0);
})();
