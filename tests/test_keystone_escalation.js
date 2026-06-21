/**
 * Regression for the kernel escalation + landed-work attribution (#897, #898).
 * Run: node tests/test_keystone_escalation.js
 *
 * The orchestrator is injectable (runOne/onEscalate supplied), so we exercise the
 * escalation logic with stubs — no live kernel, no SSE — and the share reader with
 * fixture convergence records.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const LIB = path.resolve(__dirname, "../apps/lantern-garage/lib");
const {
  kernelEscalationChain, runKernelWithEscalation, readRolloverShare, KERNEL_REASONER,
} = require(`${LIB}/keystone-escalation`);

let passed = 0;
const ok = (n) => { passed++; console.log("  ✓ " + n); };

// ── chain ──────────────────────────────────────────────────────────────────
const chain = kernelEscalationChain([
  { provider: "ollama", models: ["keystone-ft", "ouro:latest"] },
  { provider: "anthropic", models: ["claude-opus-4-8"] },
]);
assert.deepStrictEqual(chain, [
  { provider: "ollama", model: "keystone-ft" },
  { provider: "ollama", model: "ouro:latest" },
  { provider: "anthropic", model: "claude-opus-4-8" },
]);
assert.strictEqual(chain[chain.length - 1].provider, "anthropic");
ok("kernelEscalationChain flattens to ordered list ending in Claude");

const PROVIDERS = [
  { provider: "ollama", model: "keystone-ft" },
  { provider: "ollama", model: "ouro:latest" },
  { provider: "anthropic", model: "claude-opus-4-8" },
];

(async () => {
  // ── success on first provider → no escalation ──────────────────────────────
  let escA = 0;
  let r = await runKernelWithEscalation({
    providers: PROVIDERS,
    runOne: async () => ({ status: "success", applied: [] }),
    onEscalate: async () => { escA++; },
  });
  assert.strictEqual(r.escalations.length, 0);
  assert.strictEqual(escA, 0);
  assert.deepStrictEqual(r.providerUsed, { provider: "ollama", model: "keystone-ft" });
  ok("success on first provider → 0 escalations, providerUsed = keystone");

  // ── fail, fail, succeed → 2 escalations, lands on Claude ───────────────────
  let escB = 0;
  const seq = ["verification_failed", "verification_failed", "success"];
  r = await runKernelWithEscalation({
    providers: PROVIDERS,
    runOne: async (_p, _m, i) => (seq[i] === "success" ? { status: "success", applied: [] } : { status: seq[i], error: "tests failed" }),
    onEscalate: async (rec) => { escB++; assert.ok(rec.failedProvider); },
  });
  assert.strictEqual(r.escalations.length, 2);
  assert.strictEqual(escB, 2);
  assert.deepStrictEqual(r.providerUsed, { provider: "anthropic", model: "claude-opus-4-8" });
  // first escalation points at the next provider, not exhausted
  assert.deepStrictEqual(r.escalations[0].escalatedTo, { provider: "ollama", model: "ouro:latest" });
  ok("fail→fail→success → 2 escalations, lands on Claude");

  // ── all fail → exhausted, providerUsed null, last escalation has no target ──
  let escC = 0;
  r = await runKernelWithEscalation({
    providers: PROVIDERS,
    runOne: async () => ({ status: "error", error: "boom" }),
    onEscalate: async () => { escC++; },
  });
  assert.strictEqual(r.providerUsed, null);
  assert.strictEqual(r.escalations.length, 3);
  assert.strictEqual(escC, 3);
  assert.strictEqual(r.escalations[2].escalatedTo, null); // exhausted
  ok("all providers fail → exhausted, providerUsed null, final escalation target null");

  // ── readRolloverShare over fixture records ─────────────────────────────────
  const recs = [
    { reasoner: KERNEL_REASONER, result: "landed-by-ollama/keystone-ft", timestamp: "2026-06-21T10:00:00Z" },
    { reasoner: KERNEL_REASONER, result: "landed-by-ollama/ouro:latest", timestamp: "2026-06-21T10:01:00Z" },
    { reasoner: KERNEL_REASONER, result: "landed-by-anthropic/claude-opus-4-8", timestamp: "2026-06-21T10:02:00Z" },
    { reasoner: KERNEL_REASONER, result: "escalated-to-anthropic/claude-opus-4-8", timestamp: "2026-06-21T10:03:00Z" },
    { reasoner: KERNEL_REASONER, result: "escalated-to-none(exhausted)", timestamp: "2026-06-21T10:04:00Z" },
    { reasoner: "other", result: "landed-by-ollama/x", timestamp: "2026-06-21T10:05:00Z" }, // ignored
  ];
  const s = readRolloverShare(recs);
  assert.strictEqual(s.keystoneLanded, 2);
  assert.strictEqual(s.claudeLanded, 1);
  assert.strictEqual(s.landed, 3);
  assert.strictEqual(s.escalations, 2);
  assert.strictEqual(s.exhausted, 1);
  assert.strictEqual(s.keystoneShare, 0.667); // 2/3
  // escalationRate = escalations / (keystoneLanded + escalations) = 2/(2+2) = 0.5
  assert.strictEqual(s.escalationRate, 0.5);
  ok("readRolloverShare computes landed share + escalation rate, ignores non-kernel records");

  // band filter excludes older records
  const sBand = readRolloverShare(recs, { sinceTs: Date.parse("2026-06-21T10:03:30Z") });
  assert.strictEqual(sBand.landed, 0);
  assert.strictEqual(sBand.escalations, 1); // only the exhausted one at 10:04
  ok("readRolloverShare honors the sinceTs band filter");

  console.log(`\n#897/#898 escalation+share: ${passed} checks passed.`);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
