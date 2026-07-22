"use strict";
/*
 * VTD corpus generator (ADR-0030, Phase 1). Runs the verified cascade over a problem set and
 * emits ONLY exec-verified {prompt → solution} traces — the Verified-Trace-Distillation data.
 * The frontier RESCUES (cheap tier failed, escalate solved) are the distill targets: the exact
 * hard-tail the tiny model can't yet do. Cheap successes are kept too (retention).
 *
 *   cheap  = qwen2.5-coder:0.5b (local)      the tiny model we will train
 *   escalate = SPIRAL_FRONTIER_PROVIDER (default openai; cloud — spend authorized)
 *
 * Run:  node experiments/spiral_gen_traces.js --limit 120 --offset 0 --out data/eval/spiral/vtd-corpus.jsonl
 */
const fs = require("fs");
const path = require("path");
const { runSpiral } = require("../apps/lantern-garage/lib/spiral-harness");
const { makeTiers, makeVerifier } = require("../apps/lantern-garage/lib/spiral-tiers");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const src = arg("--src", "data/eval/mbpp-full.jsonl");
  const limit = Number(arg("--limit", "120"));
  const offset = Number(arg("--offset", "0"));
  const out = arg("--out", "data/eval/spiral/vtd-corpus.jsonl");
  const cheapModel = process.env.SPIRAL_CHEAP_MODEL || "qwen2.5-coder:0.5b";
  const frontierProvider = process.env.SPIRAL_FRONTIER_PROVIDER || "openai";
  const frontierModel = frontierProvider === "ollama" ? "qwen2.5-coder:latest" : null;

  const all = fs.readFileSync(path.join(__dirname, "..", src), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const problems = all.slice(offset, offset + limit);
  const tiers = makeTiers({ language: "python", cheapProvider: "ollama", cheapModel, frontierProvider, frontierModel });

  console.log(`VTD corpus generation — cheap=${cheapModel} → escalate=${frontierProvider}${frontierModel ? ":" + frontierModel : ""}`);
  console.log(`problems ${offset}..${offset + problems.length} of ${all.length} from ${src}\n`);

  const outPath = path.join(__dirname, "..", out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const sink = fs.createWriteStream(outPath, { flags: "w" });

  let cheap = 0, rescued = 0, unsolved = 0, kept = 0;
  for (let k = 0; k < problems.length; k++) {
    const p = problems[k];
    const problem = { id: p.id, prompt: `${p.prompt}\n(The function must be named EXACTLY \`${p.entry_point}\`.)` };
    let r;
    try {
      r = await runSpiral({ problem, tiers, verify: makeVerifier({ language: "python", tests: p.tests, entryPoint: p.entry_point }), maxTurns: 3 });
    } catch (e) { console.log(`  ${p.id} ERROR ${e.message}`); unsolved++; continue; }

    if (r.solved && r.y) {
      const tier = r.escalations > 0 ? "escalated" : "cheap";
      if (tier === "cheap") cheap++; else rescued++;
      kept++;
      sink.write(JSON.stringify({ id: p.id, entry_point: p.entry_point, prompt: problem.prompt, solution: r.y, tier, cheap_ok: tier === "cheap", distillTarget: tier === "escalated", tests: p.tests }) + "\n");
      if (k % 10 === 0 || tier === "escalated") console.log(`  [${k + 1}/${problems.length}] ${p.id.padEnd(10)} SOLVED (${tier})`);
    } else { unsolved++; if (k % 10 === 0) console.log(`  [${k + 1}/${problems.length}] ${p.id.padEnd(10)} unsolved`); }
  }
  sink.end();
  const n = problems.length;
  console.log(`\nDONE — kept ${kept}/${n} verified traces → ${out}`);
  console.log(`  cheap-solved (0.5B alone): ${cheap}   frontier-RESCUES (distill targets): ${rescued}   unsolved: ${unsolved}`);
  console.log(`  escalation rate: ${((rescued + unsolved) / n * 100).toFixed(0)}% (rescued+unsolved) · cheap sufficiency ${(cheap / n * 100).toFixed(0)}%`);
}
main().catch((e) => { console.error("gen error:", e.message); process.exit(1); });
