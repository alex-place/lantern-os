"use strict";
// Constraint-aware cheap stand-in selection (#local-model-picker): the local model is
// picked by the user's hardware constraints × our capability shaping, and must run on a
// local CPU or a cheap GCP CPU instance. Run: node test/local-model-constraints.test.js
const assert = require("assert");
const reg = require("../lib/local-model-registry");

process.env.VRAM_AUTODETECT = "0"; // deterministic: never shell out to nvidia-smi in the test
reg._resetCache();
const pick = (o) => reg.selectCheapStandin(o);

// 1) GPU 8GB box → GPU/VRAM path; a 7B-class coder leads, not a tiny CPU tier.
{
  const r = pick({ hasGpu: true, vramBudgetGB: 8, taskType: "coding" });
  assert(r && r.mode === "gpu", "GPU box should select in gpu mode");
  assert(!/(:1\.5b|:3b)$/.test(r.id), `GPU box should not pick a tiny CPU tier, got ${r.id}`);
}

// 2) Cheap GCP CPU instance, 4GB RAM, no GPU → 3B (fits), never the 7B/Ouro.
{
  const r = pick({ cpuOnly: true, ramBudgetGB: 4, taskType: "coding" });
  assert(r && r.mode === "cpu", "CPU box should select in cpu mode");
  assert.strictEqual(r.id, "qwen2.5-coder:3b", `4GB CPU should pick 3B, got ${r && r.id}`);
}

// 3) Low-RAM CPU box, 2GB → only the 1.5B fits (3B needs ~4GB).
{
  const r = pick({ cpuOnly: true, ramBudgetGB: 2, taskType: "coding" });
  assert.strictEqual(r && r.id, "qwen2.5-coder:1.5b", `2GB CPU should pick 1.5B, got ${r && r.id}`);
}

// 4) CPU box with plenty of RAM (16GB) still avoids the 7B (cpuOk:false) → best cpuOk (3B).
{
  const r = pick({ cpuOnly: true, ramBudgetGB: 16, taskType: "coding" });
  assert.strictEqual(r && r.id, "qwen2.5-coder:3b", `16GB CPU should pick 3B (7B not cpuOk), got ${r && r.id}`);
}

// 5) Impossibly tiny box → null → caller escalates to cloud (verify gate still backs it).
{
  const r = pick({ cpuOnly: true, ramBudgetGB: 1, taskType: "coding" });
  assert.strictEqual(r, null, `1GB should fit nothing (→ cloud), got ${r && r.id}`);
}

// 6) The GPU path for a real box is unchanged (regression guard on selectChain).
{
  const chain = reg.selectChain("coding", { hasGpu: true, vramBudgetGB: 8 });
  assert(chain.length > 0 && chain.includes("qwen2.5-coder:latest"),
    `GPU coding chain should still include the 7B lead, got ${JSON.stringify(chain)}`);
}

console.log("local-model-constraints: all 6 assertions passed");
