"use strict";
/*
 * Spiral Phase-0 runner (ADR-0030) — run the verified cascade over a set of REAL
 * executable coding tasks and emit the escalation corpus (the VTD fuel for Phase 1).
 *
 * Two modes:
 *   default  deterministic STUB tiers — free, reproducible; proves the harness mechanics
 *            end-to-end on real executable tasks (real exec verifier, real Fix-Rate ratchet,
 *            real corpus emission). This is a MECHANICS milestone, NOT a model result.
 *   --live   real model tiers via lib/spiral-tiers — fully LOCAL + zero spend by default
 *            (cheap=qwen2.5-coder:0.5b → escalate=qwen2.5-coder:7b on the Ollama daemon).
 *            SPIRAL_FRONTIER_PROVIDER=openai|gemini escalates to a cloud frontier tier.
 *            Produces the real model escalation corpus (the Phase-1 VTD fuel).
 *
 * The task set is hand-authored self-contained JS (no third-party license) with per-test
 * assertions so Fix Rate has granularity. To run Phase 0 on a BORROWED open set (SWE-Gym
 * Lite / KodCode / TACO — see docs/SIGMA0-OURO-CODER.md), normalize it to {id, prompt,
 * tests:[{name,test}]} and pass it here; the harness is dataset-agnostic.
 *
 * Run:  node experiments/spiral_phase0.js                       (built-in JS tasks, stub, free)
 *       node experiments/spiral_phase0.js --live                (built-in JS tasks, real local cascade)
 *       node experiments/spiral_phase0.js --dataset mbpp --live (BORROWED open MBPP-basic, Python)
 *       SPIRAL_FRONTIER_PROVIDER=openai node ... --dataset mbpp --live   (cloud escalate tier)
 */

const fs = require("fs");
const path = require("path");
const { runSpiral } = require("../apps/lantern-garage/lib/spiral-harness");
const { makeVerifier, makeTiers } = require("../apps/lantern-garage/lib/spiral-tiers");
const { emitConvergenceRecord } = require("../apps/lantern-garage/lib/convergence-records");

// ── real, self-contained executable tasks (each test throws on failure) ──────────
const TASKS = [
  { id: "is_even", prompt: "function is_even(n) — return true iff n is even.",
    tests: [{ name: "t0", test: "if(is_even(4)!==true)throw 1" }, { name: "t1", test: "if(is_even(7)!==false)throw 1" }] },
  { id: "factorial", prompt: "function factorial(n) — n! for n>=0 (factorial(0)===1).",
    tests: [{ name: "t0", test: "if(factorial(0)!==1)throw 1" }, { name: "t1", test: "if(factorial(5)!==120)throw 1" }] },
  { id: "two_sum", prompt: "function two_sum(nums,target) — indices [i,j] (i<j) summing to target.",
    tests: [{ name: "t0", test: "const r=two_sum([2,7,11,15],9);if(!(r[0]===0&&r[1]===1))throw 1" }, { name: "t1", test: "const r=two_sum([3,2,4],6);if(!(r[0]===1&&r[1]===2))throw 1" }] },
  { id: "rle", prompt: "function rle(s) — run-length encode, e.g. rle('aaab')==='a3b1'.",
    tests: [{ name: "t0", test: "if(rle('aaab')!=='a3b1')throw 1" }, { name: "t1", test: "if(rle('abc')!=='a1b1c1')throw 1" }, { name: "t2", test: "if(rle('')!=='')throw 1" }] },
  { id: "is_palindrome", prompt: "function is_palindrome(s) — ignoring case and non-alphanumerics.",
    tests: [{ name: "t0", test: "if(is_palindrome('A man, a plan, a canal: Panama')!==true)throw 1" }, { name: "t1", test: "if(is_palindrome('race a car')!==false)throw 1" }] },
  { id: "max_subarray", prompt: "function max_subarray(nums) — maximum contiguous subarray sum (Kadane).",
    tests: [{ name: "t0", test: "if(max_subarray([-2,1,-3,4,-1,2,1,-5,4])!==6)throw 1" }, { name: "t1", test: "if(max_subarray([-3,-1,-2])!==-1)throw 1" }] },
];

// Deterministic STUB solutions. cheap solves the first four; on the last two it returns a
// plausible-but-buggy patch (the exact failure modes a small model hits), so the exec
// verifier stalls it and the cascade escalates — a realistic sufficiency+escalation shape.
const GOOD = {
  is_even: "function is_even(n){return n%2===0}",
  factorial: "function factorial(n){let r=1;for(let i=2;i<=n;i++)r*=i;return r}",
  two_sum: "function two_sum(nums,t){const s={};for(let i=0;i<nums.length;i++){const n=t-nums[i];if(n in s)return[s[n],i];s[nums[i]]=i}return[]}",
  rle: "function rle(s){let o='';for(let i=0;i<s.length;){let j=i;while(s[j]===s[i])j++;o+=s[i]+(j-i);i=j}return o}",
  is_palindrome: "function is_palindrome(s){const t=s.toLowerCase().replace(/[^a-z0-9]/g,'');return t===[...t].reverse().join('')}",
  max_subarray: "function max_subarray(a){let b=a[0],c=a[0];for(let i=1;i<a.length;i++){c=Math.max(a[i],c+a[i]);b=Math.max(b,c)}return b}",
};
const CHEAP = {
  ...GOOD,
  // buggy: doesn't strip non-alphanumerics (fails the 'A man, a plan...' case)
  is_palindrome: "function is_palindrome(s){const t=s.toLowerCase();return t===[...t].reverse().join('')}",
  // buggy: Kadane seeded at 0, so all-negative inputs return 0 (fails the [-3,-1,-2] case)
  max_subarray: "function max_subarray(a){let b=0,c=0;for(let i=0;i<a.length;i++){c=Math.max(a[i],c+a[i]);b=Math.max(b,c)}return b}",
};

function stubTiers() {
  return {
    async cheap(ctx) { return { text: CHEAP[ctx.problem.id] || "", model: "stub-cheap", cost: 0.001 }; },
    async escalate(ctx) { return { text: GOOD[ctx.problem.id] || "", model: "stub-frontier", cost: 0.02 }; },
  };
}

// ── BORROWED open benchmark: MBPP-basic (data/eval/mbpp-basic.jsonl) ──────────────
// A JS value → a Python literal, so a `[expr, expected]` check becomes a real assert.
function toPyLiteral(v) {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number" || typeof v === "string") return JSON.stringify(v); // valid Python too
  if (Array.isArray(v)) return "[" + v.map(toPyLiteral).join(", ") + "]";
  return JSON.stringify(v);
}
function loadMbpp(limit) {
  const file = path.join(__dirname, "..", "data", "eval", "mbpp-basic.jsonl");
  const tasks = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const j = JSON.parse(l);
    return {
      id: "mbpp-" + j.id,
      prompt: `${j.prompt}\nDefine the function \`${j.fn}\`. Reply with ONLY a Python code block.`,
      tests: (j.checks || []).map((c, i) => ({ name: "c" + i, test: `assert (${c[0]}) == (${toPyLiteral(c[1])}), ${JSON.stringify(String(c[0]))}` })),
    };
  });
  return limit > 0 ? tasks.slice(0, limit) : tasks;
}

async function main() {
  const live = process.argv.includes("--live");
  const dataset = process.argv.includes("--dataset") ? process.argv[process.argv.indexOf("--dataset") + 1] : null;
  const limit = Number(process.env.SPIRAL_LIMIT || 0) || 0;
  if (dataset && dataset !== "mbpp") { console.error(`unknown --dataset '${dataset}' (only 'mbpp' is wired)`); process.exit(2); }
  if (dataset && !live) { console.error("--dataset requires --live — a real model must solve real open problems (stub only knows the built-in JS tasks)."); process.exit(2); }
  const language = dataset === "mbpp" ? "python" : "js";
  const tasks = dataset === "mbpp" ? loadMbpp(limit) : TASKS;

  // Fully-LOCAL real cascade by default (zero spend): a weak cheap tier (0.5B) that stalls on
  // hard tasks, escalating to a strong local tier (7B). SPIRAL_FRONTIER_PROVIDER=openai|gemini
  // (keys present) escalates to a cloud frontier tier instead.
  const cheapModel = process.env.SPIRAL_CHEAP_MODEL || "qwen2.5-coder:0.5b";
  const frontierProvider = process.env.SPIRAL_FRONTIER_PROVIDER || "ollama";
  // A model pin only applies to the local (ollama) tier; a cloud provider's leg picks its own
  // model, so we must NOT label a cloud escalate with a qwen model name (that would be a lie).
  const frontierModel = frontierProvider === "ollama"
    ? (process.env.SPIRAL_FRONTIER_MODEL || "qwen2.5-coder:latest")
    : (process.env.SPIRAL_FRONTIER_MODEL || null);
  // Honest-labeling preflight (#2835): with no configured leg for a requested CLOUD
  // frontier, _defaultComplete would silently answer from the first reachable leg (the
  // LOCAL model) while every corpus row is labeled frontier:<provider> — a mislabeled
  // distillation corpus. Refuse up front instead of poisoning the VTD fuel.
  if (live && frontierProvider !== "ollama") {
    const { _legFor } = require("../apps/lantern-garage/lib/spiral-tiers");
    if (!_legFor(frontierProvider)) {
      console.error(
        `SPIRAL_FRONTIER_PROVIDER=${frontierProvider} requested but no ${frontierProvider} leg is configured on this box (no key). ` +
        `Refusing to run: the escalate leg would silently fall back to a local model while the corpus labels it frontier:${frontierProvider}. ` +
        `Set the provider key, or unset SPIRAL_FRONTIER_PROVIDER for the local escalate tier.`,
      );
      process.exit(2);
    }
  }
  const tiers = live
    ? makeTiers({ language, cheapProvider: "ollama", cheapModel, frontierProvider, frontierModel })
    : stubTiers();
  const escLabel = `${frontierProvider}${frontierModel ? ":" + frontierModel : ""}`;
  console.log(`Spiral Phase-0 — ${dataset ? `dataset=${dataset} · ` : ""}${live ? `LIVE cascade: cheap=${cheapModel} → escalate=${escLabel}` : "deterministic STUB tiers (free mechanics run)"}`);
  console.log(`${tasks.length} real executable ${language} tasks · exec-verified Fix-Rate ratchet · emitting escalation corpus\n`);
  console.log(`${"task".padEnd(18)} ${"result".padEnd(10)} tier`);

  const rows = [];
  let corpusFile = null;
  for (const t of tasks) {
    const r = await runSpiral({
      problem: { id: t.id, prompt: t.prompt },
      tiers,
      verify: makeVerifier({ language, tests: t.tests }),
      maxTurns: dataset ? 3 : 4,
    });
    corpusFile = r.corpusFile || corpusFile;
    const finalTier = r.escalations > 0 ? "escalated" : "cheap";
    rows.push({ id: t.id, solved: r.solved, escalations: r.escalations, turns: r.turns, tier: finalTier });
    console.log(`${String(t.id).padEnd(18)} ${(r.solved ? "SOLVED" : "unsolved").padEnd(10)} ${finalTier}${r.escalations ? "  (cheap stalled → frontier)" : ""}`);
  }

  const n = rows.length;
  const solved = rows.filter((r) => r.solved).length;
  const escalated = rows.filter((r) => r.escalations > 0).length;
  console.log("\n" + "=".repeat(60));
  console.log(`Phase-0 result: solved ${solved}/${n} · escalated ${escalated}/${n} (${Math.round((escalated / n) * 100)}%)`);
  console.log(`Cheap-tier sufficiency: ${n - escalated}/${n} solved WITHOUT escalation (the affordable-long-horizon regime).`);
  console.log(`Escalation corpus (the Phase-1 VTD fuel) → ${corpusFile || "data/eval/spiral/"}`);
  if (!live) console.log("NOTE: stub tiers — this verifies HARNESS MECHANICS on real tasks, not model capability. Use --live for a model corpus.");

  // Every run emits a ConvergenceRecord (the CLAUDE.md Verify→Converge principle). The STUB
  // run is honestly verified at the MECHANICS level only (real exec, real ratchet, real
  // corpus) — NOT a model-capability claim; the --live run is what would ground that.
  const distillTargets = escalated; // escalated + advancing steps = VTD targets this run produced
  // The VERIFIED claim is "the harness runs the cascade end-to-end on real tasks and emits a
  // corpus" — reality (this exec-verified run) confirms it in BOTH modes, so both are
  // verified:true. The model-capability numbers (solved N/M) are a MEASUREMENT carried in
  // `result`, honestly NOT the same as an eval-leaderboard benchmark.
  await emitConvergenceRecord({
    hypothesis: `Spiral Phase-0 harness (ADR-0030) runs the verified cascade end-to-end on ${n} real executable tasks and emits a valid escalation corpus (${distillTargets} distillation targets).`,
    result: { mode: live ? "live" : "stub", solved: `${solved}/${n}`, escalationRate: Math.round((escalated / n) * 100) / 100, cheapSufficiency: `${n - escalated}/${n}`, corpusFile },
    confidence: live ? 0.8 : 0.75,
    reasoner: "spiral_phase0.js (ADR-0030)",
    verified: true,
    verified_by: [`exec:experiments/spiral_phase0.js${live ? " --live" : ""}`, "test:apps/lantern-garage/test/spiral-harness.test.js"],
    source: "experiments/spiral_phase0.js ; docs/SIGMA0-OURO-CODER.md",
    verification_notes: live
      ? `LIVE local cascade, real exec-verified. solved ${solved}/${n} is a MEASUREMENT (not an eval-leaderboard benchmark).`
      : "MECHANICS verified (exec + ratchet + corpus) on real tasks; use --live for a model-capability measurement.",
  });
}

main().catch((e) => { console.error("spiral_phase0 error:", e.message); process.exit(1); });
