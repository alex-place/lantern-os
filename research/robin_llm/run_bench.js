"use strict";
// Mill a ranked bench list -- ideas for a human to run.
//
//   node research/robin_llm/run_bench.js "<goal>" [--n 10] [--seed 1] [--out FILE]
//
// Writes markdown to research/robin_llm/results/bench-<slug>.md and the raw record next to it as
// .json. Nothing in the output has been executed; the document says so at the top.

const fs = require("fs");
const path = require("path");

// Standalone script: the server loads .env at boot, we have to do it ourselves. Ambient
// environment wins, so this never overwrites a key the caller already exported.
(function loadEnv() {
  const f = path.join(__dirname, "..", "..", ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(String.fromCharCode(10))) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[2].trim() && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
})();

const bench = require("./bench");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "bench";
}

async function main() {
  const goal = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2]
    : "raise the capability per unit of compute of a small in-house language model";
  const n = Number(arg("n", 10));
  console.log(`GOAL: ${goal}`);
  const t0 = Date.now();
  const result = await bench.millIdeas(goal, {
    n, seed: Number(arg("seed", 1)),
    audit: !process.argv.includes("--no-audit"),
    log: (stage, data) => console.log(`  [${stage}] ${JSON.stringify(data).slice(0, 190)}`),
  });
  if (!result.ideas.length) {
    console.error("no parseable ideas were produced");
    process.exit(1);
  }
  const wall = Math.round((Date.now() - t0) / 1000);
  const dir = path.join(__dirname, "results");
  fs.mkdirSync(dir, { recursive: true });
  const base = arg("out", path.join(dir, `bench-${slug(goal)}`));
  const md = bench.renderMarkdown(result, { generated: new Date().toISOString().slice(0, 10) });
  fs.writeFileSync(`${base}.md`, md);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ ...result, wall_s: wall }, null, 2));

  console.log("\n--- BENCH LIST ---");
  for (const i of result.ideas) {
    console.log(`${String(i.rank).padStart(2)}. [${(i.cost || "?").padEnd(6)}] ${i.title}${i.grounded ? "" : "  (ungrounded)"}`);
  }
  console.log(`\nsham placed ${result.sham_rank} of ${result.of} — ${result.sham_control_held ? "control held" : "CONTROL FAILED, ignore the order"}`);
  if (result.audit) {
    console.log(`novelty audit ${result.audit.controls.trusted ? "trusted" : "UNTRUSTED (its controls failed)"}: ` +
      Object.entries(result.audit.counts).map(([k, v]) => `${v} ${k}`).join(", "));
  }
  console.log(`-> ${base}.md  (${wall}s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
