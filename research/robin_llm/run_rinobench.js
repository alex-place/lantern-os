"use strict";
// Our novelty auditor, measured on the field's own benchmark instead of controls I wrote myself.
//
// WHY. Everything in this directory was built by inventing mechanisms -- sham arms, planted
// restatements, an evasion check -- when automated novelty assessment is a studied problem with
// published methods and, more importantly, a published BENCHMARK. Auditing every idea for prior
// art except the auditor is the same error the auditor exists to catch.
//
// RINoBench (arXiv:2603.10303, github.com/TimSchopf/RINoBench): 1,381 research ideas whose novelty
// labels come from ICLR 2022-23 peer reviews on OpenReview, filtered for inter-reviewer agreement
// and mapped to a 1-5 scale. 277 held-out test examples, each with ~25 related works supplied.
//
// THE PUBLISHED BASELINES, and the reason this changes the argument:
//     gpt-5      macro F1 0.172        o3        0.162        gpt-oss-120b  0.148
//     Llama-3.1-8B      0.146          Llama-4-Scout 0.130     DeepSeek-R1   0.123
//     Llama-3.3-70B     0.095
// The best score in the field is 0.172 macro F1 on five classes. Automated novelty judgment does
// not work yet -- the benchmark's own finding is a "judgment-justification gap": model reasoning
// mirrors human rationales while the scores diverge. So refusing to output "novel", making
// UNVERIFIED the floor and routing to a human is not timidity; it is the only defensible position
// given the measured state of the art, and this run is the check on whether we are any different.
//
// PRE-REGISTERED MAPPING, fixed before the first run. Our verdicts are categorical and this task
// is a 1-5 score, so the mapping is a choice and it is made here rather than after seeing results:
//     ANSWERED-HERE | REFUTED-HERE | RESTATES  -> 1   "all aspects already exist in prior work"
//     PORT                                     -> 3   "apply known approaches to new contexts"
//     INCREMENTAL                              -> 3   "combines known approaches in new ways"
//     UNVERIFIED                               -> 4   "introduces new aspects not present"
// UNVERIFIED maps to 4 and not 5 deliberately: it means we could not place the idea, which is the
// closest this system comes to a novelty claim and is still weaker than "highly innovative".
//
// WHAT IS AND IS NOT BEING MEASURED. The repo and corpus legs are noise here -- the benchmark
// supplies the related works, and they are ICLR-era papers, not our lab. So this measures the
// JUDGE: the ordered checklist and its verdict vocabulary, on ideas it did not generate, against
// labels from real peer review. That is the transferable part and the part worth knowing about.
//
// Run:  node research/robin_llm/run_rinobench.js [--n 60] [--data DIR]

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

const agents = require("./agents");
const { VERDICTS } = require("./novelty");

const VERDICT_TO_SCORE = {
  "ANSWERED-HERE": 1, "REFUTED-HERE": 1, "RESTATES": 1,
  "PORT": 3, "INCREMENTAL": 3, "UNVERIFIED": 4,
};

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}

function ideaText(ri) {
  if (typeof ri === "string") return ri;
  return Object.entries(ri || {}).map(([k, v]) => `${k.toUpperCase()}: ${v}`).join("\n").slice(0, 2200);
}

function relatedBlock(works, k = 14) {
  return (works || []).slice(0, k)
    .map((w, i) => `[${i + 1}] ${w.title || "(untitled)"}\n${String(w.abstract || "").slice(0, 300)}`)
    .join("\n\n");
}

// The audit's own prompt, with the benchmark's related works standing in for our retrieval. The
// checklist is unchanged -- changing it for the benchmark would measure a different system.
async function judge(idea, works, llm) {
  const prompt = `You are checking whether a proposed research idea is already done.\n\n`
    + `IDEA:\n${ideaText(idea)}\n\nRELATED WORK:\n${relatedBlock(works)}\n\n`
    + `Work through these IN ORDER and stop at the first that applies:\n\n`
    + `1. Is the idea one of the papers above -- its title, or the contribution its abstract `
    + `describes? That is RESTATES.\n`
    + `2. Is it a method from a paper above, applied to a new setting? PORT.\n`
    + `3. Is something above adjacent, with the idea adding to it? INCREMENTAL.\n`
    + `4. Otherwise UNVERIFIED: nothing above matches. This does NOT mean novel; it means nothing `
    + `here placed it.\n\n`
    + `Match on MECHANISM rather than shared vocabulary.\n\n`
    + `Reply with ONE line of JSON: {"verdict":"RESTATES|PORT|INCREMENTAL|UNVERIFIED","why":"<15 words>"}`;
  const text = (await llm(prompt, 200)) || "";
  const m = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = String(JSON.parse(m[0]).verdict || "").toUpperCase();
    return VERDICTS.includes(v) ? v : null;
  } catch { return null; }
}

function macroF1(pairs, classes) {
  const f1s = [];
  for (const c of classes) {
    let tp = 0, fp = 0, fn = 0;
    for (const [y, p] of pairs) {
      if (p === c && y === c) tp++;
      else if (p === c && y !== c) fp++;
      else if (p !== c && y === c) fn++;
    }
    const prec = tp + fp ? tp / (tp + fp) : 0;
    const rec = tp + fn ? tp / (tp + fn) : 0;
    f1s.push(prec + rec ? (2 * prec * rec) / (prec + rec) : 0);
  }
  return f1s.reduce((a, b) => a + b, 0) / f1s.length;
}

const PUBLISHED = { "gpt-5": 0.172, "o3": 0.162, "gpt-oss-120b": 0.148, "Llama-3.1-8B": 0.146,
                    "Llama-4-Scout": 0.130, "DeepSeek-R1": 0.123, "Llama-3.3-70B": 0.095 };

async function main() {
  const dir = arg("data", path.join("D:", "tmp", "claude", "RINoBench", "data", "final_benchmark_dataset"));
  const test = JSON.parse(fs.readFileSync(path.join(dir, "test.json"), "utf8"));
  const n = Math.min(Number(arg("n", 60)), test.length);
  const llm = agents.defaultLlm();
  console.log(`RINoBench: ${n} of ${test.length} test examples; published best is gpt-5 at macro F1 0.172`);

  const pairs = [];
  const verdictCounts = {};
  let unparsed = 0;
  for (let i = 0; i < n; i++) {
    const ex = test[i];
    const v = await judge(ex.research_idea, ex.related_works, llm);
    if (!v) { unparsed++; continue; }
    verdictCounts[v] = (verdictCounts[v] || 0) + 1;
    pairs.push([Number(ex.novelty_score), VERDICT_TO_SCORE[v]]);
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${n}  macro F1 so far ${macroF1(pairs, [1, 2, 3, 4, 5]).toFixed(3)}`);
  }

  const f1 = macroF1(pairs, [1, 2, 3, 4, 5]);
  const acc = pairs.filter(([y, p]) => y === p).length / Math.max(1, pairs.length);
  // The labels are ordinal, so "how far off" matters as much as exact agreement.
  const mae = pairs.reduce((s, [y, p]) => s + Math.abs(y - p), 0) / Math.max(1, pairs.length);
  const labelDist = {};
  for (const [y] of pairs) labelDist[y] = (labelDist[y] || 0) + 1;

  console.log(`\nscored ${pairs.length}, unparsed ${unparsed}`);
  console.log(`verdicts:   ${JSON.stringify(verdictCounts)}`);
  console.log(`gold spread:${JSON.stringify(labelDist)}`);
  console.log(`macro F1 ${f1.toFixed(3)}   exact-match ${(100 * acc).toFixed(0)}%   mean abs error ${mae.toFixed(2)}`);
  console.log(`\npublished: ${Object.entries(PUBLISHED).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const beats = Object.entries(PUBLISHED).filter(([, v]) => f1 > v).map(([k]) => k);
  console.log(f1 > 0.172
    ? `ABOVE the published best (${f1.toFixed(3)} > 0.172) -- on ${pairs.length} examples, which is not the full test set`
    : `below the published best; above: ${beats.length ? beats.join(", ") : "none"}`);
  console.log(`\nThe honest reading either way: the field's best is 0.172 macro F1 on five classes. `
    + `Automated novelty judgment is not solved, and a system that outputs a novelty verdict `
    + `without saying so is overselling.`);

  const out = path.join(__dirname, "results", "rinobench.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ n: pairs.length, unparsed, macro_f1: f1, exact_match: acc,
    mae, verdicts: verdictCounts, gold: labelDist, mapping: VERDICT_TO_SCORE, published: PUBLISHED }, null, 2));
  console.log(`-> ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
