"use strict";
// Mill for ideas that are not already done.
//
//   node research/robin_llm/run_gapmill.js "<goal>" [--n 6] [--rounds 3] [--seed 1] [--out FILE]
//
// Unlike run_bench.js this rejects its own proposals as it goes: anything the audit places as
// RESTATES / PORT / ANSWERED-HERE is fed back to the generator with the collision named, and it
// tries again. What survives is what the audit could not place -- which is not the same as novel,
// and the report says so in the same words it always has.

const fs = require("fs");
const path = require("path");

(function loadEnv() {
  const f = path.join(__dirname, "..", "..", ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(String.fromCharCode(10))) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[2].trim() && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
})();

const gapmill = require("./gapmill");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 56) || "gaps";

async function main() {
  const goal = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2]
    : "raise reasoning capability per parameter in a small in-house language model";
  console.log(`GOAL: ${goal}`);
  const t0 = Date.now();
  const r = await gapmill.millGaps(goal, {
    n: Number(arg("n", 6)), rounds: Number(arg("rounds", 3)), seed: Number(arg("seed", 1)),
    log: (stage, data) => console.log(`  [${stage}] ${JSON.stringify(data).slice(0, 200)}`),
  });
  const wall = Math.round((Date.now() - t0) / 1000);
  if (!r.ideas.length) {
    console.log(`\nNOTHING SURVIVED: ${r.placed || 0} of ${r.proposed || 0} proposals were already done.`);
    console.log(`That is a result, not a failure -- it is what "the mill does not invent" looks like.`);
    process.exit(0);
  }
  const dir = path.join(__dirname, "results");
  fs.mkdirSync(dir, { recursive: true });
  const base = arg("out", path.join(dir, `gaps-${slug(goal)}`));
  fs.writeFileSync(`${base}.md`, gapmill.renderMarkdown(r, { generated: new Date().toISOString().slice(0, 10) }));
  fs.writeFileSync(`${base}.json`, JSON.stringify({ ...r, wall_s: wall }, null, 2));

  console.log("\n--- SURVIVED THE AUDIT ---");
  for (const i of r.ideas) {
    console.log(`${String(i.rank).padStart(2)}. [${(i.cost || "?").padEnd(6)}] ${i.title}`);
    console.log(`     vs ${i.closest_prior} -- ${i.difference}`);
  }
  console.log(`\nplaced during milling: ${r.placed}/${r.proposed}`
    + (r.placed_rate === null ? "" : ` (${Math.round(100 * r.placed_rate)}% already done; bench.js baseline was 14/16 = 88%)`));
  if (r.diversity && r.diversity.mean_overlap !== null) {
    console.log(`diversity: mean pairwise overlap ${r.diversity.mean_overlap}`
      + (r.diversity.repeated.length ? ` -- repeated across most survivors: ${r.diversity.repeated.join(", ")}` : "")
      + `\n           (a low placed rate with high overlap is one theme permuted, not a set of gaps)`);
  }
  console.log(`inert sham ${r.sham_rank}/${r.of} — ${r.sham_control_held ? "held" : "FAILED"};`
    + ` vague sham ${r.vague_sham_rank}/${r.of} — ${r.vague_control_held ? "held" : "FAILED: the ranking rewards unplaceable word salad"}`);
  console.log(`-> ${base}.md  (${wall}s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
