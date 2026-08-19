"use strict";
// CLI for the Robin-shaped design loop.
//
//   node research/robin_llm/run_robin_llm.js "<goal>" [--assay NAME] [--candidates N] [--top N]
//                                            [--seed N] [--dry] [--list]
//
//   --list        print the assay registry and exit (no LLM, no network)
//   --dry         run the whole pipeline with a scripted stub LLM instead of a provider. Proves
//                 the wiring end to end -- including really executing the assay -- without
//                 spending a token. Use it first.
//
// Writes results/<timestamp>.json and prints a summary.

const fs = require("fs");
const path = require("path");
const pipeline = require("./pipeline");

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
const { list, ASSAYS } = require("./assays");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);

// A deterministic stand-in for the provider chain: enough structure for every parse path to be
// exercised, and DELIBERATELY includes one malformed line and one unrunnable proposal so the
// dry run demonstrates that those are counted rather than silently dropped.
function stubLlm(assay) {
  const knobs = Object.keys(ASSAYS[assay].knobs).filter((k) => k !== "seeds");
  let judged = 0;
  return async (prompt) => {
    if (prompt.includes('"assay"') && prompt.includes("Available experiments")) return `{"assay":"${assay}","why":"stub"}`;
    if (prompt.includes('"winner"')) { judged++; return `{"winner":"${judged % 3 === 0 ? "TIE" : judged % 2 ? "A" : "B"}","why":"stub"}`; }
    if (prompt.includes("Output exactly")) {
      const lines = knobs.slice(0, 4).map((k, i) => {
        const s = ASSAYS[assay].knobs[k];
        const v = s.type === "int" ? Math.max(s.min, Math.round(s.default * (i % 2 ? 1.5 : 0.7)))
                                   : Number((s.default * (i % 2 ? 1.2 : 0.8)).toFixed(3));
        return JSON.stringify({ title: `stub: move ${k}`, rationale: `stub mechanism for ${k}`, assay, params: { [k]: v } });
      });
      lines.push('{"title":"stub: unrunnable","rationale":"needs a knob that does not exist","assay":"' + assay + '","params":{"nope":1}}');
      lines.push("{not json}");
      return lines.join("\n");
    }
    return "stub text";
  };
}

async function main() {
  if (flag("list")) {
    for (const a of list({ server: false, providers: false })) {
      console.log(`${a.name}${a.available ? "" : `  [needs ${a.requires.join("+")}]`}\n  ~${a.seconds}s  knobs: ${a.knobs.join(", ")}\n  ${ASSAYS[a.name].what}\n`);
    }
    return;
  }
  const goal = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2]
    : "raise validated discoveries per unit of experiment without raising false discoveries";
  const assay = arg("assay", flag("dry") ? "controller-two-explanations" : undefined);
  const opts = {
    assay,
    candidates: Number(arg("candidates", 8)),
    top: Number(arg("top", 2)),
    seed: Number(arg("seed", 1)),
    available: { server: false, providers: true },
    baselineParams: flag("dry") ? { seeds: 30 } : {},
    log: (stage, data) => console.log(`  [${stage}] ${JSON.stringify(data)}`),
  };
  if (flag("dry")) {
    opts.llm = stubLlm(assay);
    opts.candidates = 4;
    // keep the dry run short: small seed counts on every candidate
    opts.top = 1;
  }
  console.log(`GOAL: ${goal}`);
  const t0 = Date.now();
  const report = await pipeline.run(goal, opts);
  report.wall_s = Math.round((Date.now() - t0) / 1000);

  const dir = path.join(__dirname, "results");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${flag("dry") ? "dry-" : ""}latest.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  console.log("\n--- RESULT ---");
  for (const r of report.results || []) {
    console.log(`${r.verdict.padEnd(26)} ${r.metric} vs baseline ${r.baseline}  ${JSON.stringify(r.params)}  ${r.title}`);
  }
  if (report.controls) console.log(`\nCONTROLS ${JSON.stringify(report.controls)}`);
  if (report.interpretation) console.log(`\nNEXT: ${report.interpretation}`);
  console.log(`\nVERDICT: ${report.verdict}\n-> ${out}  (${report.wall_s}s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
