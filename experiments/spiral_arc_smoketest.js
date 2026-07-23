"use strict";
/*
 * spiral_arc_smoketest.js — test the spiral harness on a REAL execution-verified
 * inductive-program-synthesis task (ARC-AGI style), end to end, no GPU.
 *
 * What is REAL here: the spiral harness (lib/spiral-harness.runSpiral), the exec
 * sandbox (lib/exec-verify.verifyExecAsync, real python3), the Fix-Rate ratchet, the
 * cheap→stall→escalate cascade. What is STUBBED: the "model" leg only emits candidate
 * programs (a real Ouro run needs the serving env). That is the honest boundary — this
 * validates the SYSTEM (the moat), which ARC Prize showed is worth ±20% by itself.
 *
 * The task: horizontal mirror (reverse each row). 3 train pairs + 1 HELD-OUT test pair.
 *
 * Two demonstrations:
 *   A) the cascade: a wrong cheap proposal (flip rows) is REJECTED by execution, the
 *      loop stalls, escalation proposes the inductive program, execution VERIFIES it,
 *      and it GENERALIZES to the held-out pair.
 *   B) the transduction trap: a program that MEMORIZES the train I/O passes every
 *      training test (Fix-Rate 1.0 → harness "solved") yet FAILS the held-out pair —
 *      exactly HRM/TRM's non-generalizing failure mode, caught by a held-out gate.
 *
 * Run:  node experiments/spiral_arc_smoketest.js
 */
const path = require("path");
const { runSpiral } = require(path.resolve(__dirname, "..", "apps", "lantern-garage", "lib", "spiral-harness"));
const { verifyExecAsync } = require(path.resolve(__dirname, "..", "apps", "lantern-garage", "lib", "exec-verify"));

// ── a real ARC-style task: horizontal mirror ─────────────────────────────────
const TRAIN = [
  { in: [[1, 0, 0], [0, 2, 0]], out: [[0, 0, 1], [0, 2, 0]] },
  { in: [[3, 3, 0], [0, 0, 4]], out: [[0, 3, 3], [4, 0, 0]] },
  { in: [[5, 0, 6], [7, 0, 0]], out: [[6, 0, 5], [0, 0, 7]] },
];
const TEST = { in: [[8, 0, 0], [0, 9, 0]], out: [[0, 0, 8], [0, 9, 0]] }; // held out

const py = (g) => JSON.stringify(g);
// run a candidate program against one pair via the REAL sandbox; exit 0 == passed
async function runPair(program, pair) {
  const test = `INPUT=${py(pair.in)}\nEXPECTED=${py(pair.out)}\nassert transform(INPUT)==EXPECTED, "mismatch"`;
  const r = await verifyExecAsync({ language: "python", code: program, test, timeoutMs: 8000 });
  return r.passed;
}
// verify(programText) → per-train-pair results (what the spiral ratchets on)
async function verifyOnTrain(program) {
  const out = [];
  for (let i = 0; i < TRAIN.length; i++) out.push({ name: `pair${i}`, passed: await runPair(program, TRAIN[i]) });
  return out;
}
const fixRate = (rs) => rs.filter((r) => r.passed).length / rs.length;

// ── candidate programs (the stubbed "model" proposals) ───────────────────────
const PROG_FLIP_ROWS = `def transform(g):\n    return g[::-1]`;                       // wrong: reverses row ORDER
const PROG_INDUCTIVE = `def transform(g):\n    return [row[::-1] for row in g]`;      // right: reverses each row (mirror)
const PROG_MEMORIZE = `TRAIN=${py(TRAIN.map((p) => [p.in, p.out]))}\n` +
  `def transform(g):\n    for inp,out in TRAIN:\n        if g==inp: return out\n    return g`; // overfits train, no rule

async function main() {
  console.log("Spiral harness — REAL execution-verified inductive program synthesis (ARC-style: horizontal mirror)\n");

  // ── Demonstration A: the verified cascade ──────────────────────────────────
  const corpus = { file: "(smoketest)", rows: [], append: (r) => corpus.rows.push(r) };
  let cheapCalls = 0, escCalls = 0;
  const r = await runSpiral({
    problem: { id: "arc-mirror", prompt: "Synthesize transform(grid) matching the demo pairs." },
    tiers: {
      cheap: async () => { cheapCalls++; return { text: PROG_FLIP_ROWS, cost: 0.0002, model: "ouro-cheap(stub)" }; },
      escalate: async () => { escCalls++; return { text: PROG_INDUCTIVE, cost: 0.02, model: "frontier(stub)" }; },
    },
    verify: verifyOnTrain,
    corpus,
    now: () => 1_700_000_000_000,
    maxTurns: 4,
  });
  const totalCost = corpus.rows.reduce((s, row) => s + (row.cost || 0), 0);
  console.log("── A) verified cascade ──");
  console.log(`  cheap proposal (flip rows)  → train Fix-Rate ${fixRate(await verifyOnTrain(PROG_FLIP_ROWS)).toFixed(2)}  → REJECTED, stall`);
  console.log(`  escalate (inductive mirror) → train Fix-Rate ${fixRate(await verifyOnTrain(PROG_INDUCTIVE)).toFixed(2)}  → VERIFIED`);
  console.log(`  harness: solved=${r.solved} halt=${r.haltReason} turns=${corpus.rows.length} escalations=${escCalls} cost=$${totalCost.toFixed(4)}`);
  const genA = await runPair(PROG_INDUCTIVE, TEST);
  console.log(`  HELD-OUT generalization: ${genA ? "PASS ✓ (the verified program generalizes)" : "FAIL"}`);

  // ── Demonstration B: the transduction trap ─────────────────────────────────
  console.log("\n── B) transduction trap (why train Fix-Rate alone is not convergence) ──");
  const memTrain = fixRate(await verifyOnTrain(PROG_MEMORIZE));
  const memGen = await runPair(PROG_MEMORIZE, TEST);
  console.log(`  memorizing program → train Fix-Rate ${memTrain.toFixed(2)} (harness would call this "solved")`);
  console.log(`  memorizing program → HELD-OUT: ${memGen ? "PASS" : "FAIL ✗ (passed every training test, does NOT generalize)"}`);
  console.log(`  inductive program  → HELD-OUT: ${genA ? "PASS ✓" : "FAIL"}`);

  console.log("\nFINDING: an exact train verifier is necessary but not sufficient — a held-out generalization gate");
  console.log("is required to separate an inductive (generalizing) solution from a memorizing (transductive) one.");
  console.log("This is the HRM/TRM non-generalization failure mode, reproduced on a real execution-verified run,");
  console.log("and it is the concrete design requirement the ARC-AGI-2 spiral must add: verify on HELD-OUT pairs.");
}
main().catch((e) => { console.error("smoketest error:", e); process.exit(1); });
