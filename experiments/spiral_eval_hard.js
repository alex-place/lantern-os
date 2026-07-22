"use strict";
/*
 * Transparent spiral eval on HARD problems (ADR-0030). Unlike spiral_phase0.js this prints
 * the RAW model generations and per-test verdicts for every turn — no summarizing. The task
 * set is genuinely hard (DP / parsing) so the 0.5B cheap tier actually fails and escalation
 * fires under load. Run:
 *   node experiments/spiral_eval_hard.js --live
 *   SPIRAL_FRONTIER_PROVIDER=openai node experiments/spiral_eval_hard.js --live
 */
const { runSpiral } = require("../apps/lantern-garage/lib/spiral-harness");
const { makeTiers, makeVerifier } = require("../apps/lantern-garage/lib/spiral-tiers");

const TASKS = [
  { id: "word_break",
    prompt: "function word_break(s, dict) — return true iff s can be segmented into a space-separated sequence of one or more words from the array dict (words reusable).",
    tests: [
      { name: "leetcode", test: "if(word_break('leetcode',['leet','code'])!==true)throw new Error('leetcode')" },
      { name: "catsandog", test: "if(word_break('catsandog',['cats','dog','sand','and','cat'])!==false)throw new Error('catsandog')" },
      { name: "reuse", test: "if(word_break('aaaaaaa',['aaaa','aaa'])!==true)throw new Error('reuse')" },
    ] },
  { id: "min_distance",
    prompt: "function min_distance(a, b) — the minimum edit distance (insert/delete/replace) to turn string a into string b.",
    tests: [
      { name: "horse", test: "if(min_distance('horse','ros')!==3)throw new Error('horse '+min_distance('horse','ros'))" },
      { name: "intention", test: "if(min_distance('intention','execution')!==5)throw new Error('intention')" },
      { name: "empty", test: "if(min_distance('','abc')!==3)throw new Error('empty')" },
    ] },
  { id: "coin_change",
    prompt: "function coin_change(coins, amount) — fewest number of coins summing to amount, or -1 if impossible. coins is an array of denominations.",
    tests: [
      { name: "11", test: "if(coin_change([1,2,5],11)!==3)throw new Error('11 '+coin_change([1,2,5],11))" },
      { name: "3", test: "if(coin_change([2],3)!==-1)throw new Error('3')" },
      { name: "0", test: "if(coin_change([1],0)!==0)throw new Error('0')" },
    ] },
  { id: "longest_valid_parentheses",
    prompt: "function longest_valid_parentheses(s) — length of the longest substring of well-formed '(' ')' parentheses.",
    tests: [
      { name: "a", test: "if(longest_valid_parentheses('(()')!==2)throw new Error('a')" },
      { name: "b", test: "if(longest_valid_parentheses(')()())')!==4)throw new Error('b')" },
      { name: "empty", test: "if(longest_valid_parentheses('')!==0)throw new Error('empty')" },
    ] },
  { id: "num_decodings",
    prompt: "function num_decodings(s) — number of ways to decode a digit string where '1'->'A' ... '26'->'Z'. Leading zeros are invalid.",
    tests: [
      { name: "12", test: "if(num_decodings('12')!==2)throw new Error('12')" },
      { name: "226", test: "if(num_decodings('226')!==3)throw new Error('226')" },
      { name: "06", test: "if(num_decodings('06')!==0)throw new Error('06')" },
    ] },
  { id: "length_of_lis",
    prompt: "function length_of_lis(nums) — length of the longest strictly increasing subsequence of the array nums.",
    tests: [
      { name: "a", test: "if(length_of_lis([10,9,2,5,3,7,101,18])!==4)throw new Error('a '+length_of_lis([10,9,2,5,3,7,101,18]))" },
      { name: "b", test: "if(length_of_lis([0,1,0,3,2,3])!==4)throw new Error('b')" },
      { name: "flat", test: "if(length_of_lis([7,7,7,7])!==1)throw new Error('flat')" },
    ] },
];

const indent = (s) => String(s).split("\n").map((l) => "      " + l).join("\n");

async function main() {
  if (!process.argv.includes("--live")) { console.error("this eval only makes sense --live (real models)"); process.exit(2); }
  const cheapModel = process.env.SPIRAL_CHEAP_MODEL || "qwen2.5-coder:0.5b";
  const frontierProvider = process.env.SPIRAL_FRONTIER_PROVIDER || "ollama";
  const frontierModel = frontierProvider === "ollama" ? (process.env.SPIRAL_FRONTIER_MODEL || "qwen2.5-coder:latest") : null;
  const base = makeTiers({ language: "js", cheapProvider: "ollama", cheapModel, frontierProvider, frontierModel });

  // Wrap tiers + verifier to PRINT the raw generation and per-test verdict for every turn.
  const tiers = {
    async cheap(ctx) { const r = await base.cheap(ctx); console.log(`\n  -- turn ${ctx.turn} [CHEAP ${r.model}] generated --`); console.log(indent(r.text || "(empty)")); return r; },
    async escalate(ctx) { const r = await base.escalate(ctx); console.log(`\n  -- turn ${ctx.turn} [ESCALATE ${r.model}] generated --`); console.log(indent(r.text || "(empty)")); return r; },
  };
  const mkVerify = (tests, entryPoint) => {
    const v = makeVerifier({ language: "js", tests, entryPoint });
    return async (code) => {
      const results = await v(code);
      console.log("    verdict: " + results.map((t) => `${t.name}=${t.passed ? "PASS" : "FAIL"}`).join("  "));
      const f = results.find((t) => !t.passed);
      if (f && f.output) console.log("    first failure: " + String(f.output).replace(/\s+/g, " ").slice(0, 140));
      return results;
    };
  };

  console.log(`Transparent spiral eval — cheap=${cheapModel} -> escalate=${frontierProvider}${frontierModel ? ":" + frontierModel : ""}`);
  console.log(`${TASKS.length} HARD tasks (DP/parsing). Raw generations + per-test verdicts shown for every turn.`);
  const summary = [];
  for (const t of TASKS) {
    console.log("\n" + "=".repeat(72) + `\n### ${t.id}\n${t.prompt}`);
    const r = await runSpiral({ problem: { id: t.id, prompt: t.prompt }, tiers, verify: mkVerify(t.tests, t.id), maxTurns: 3 });
    console.log(`  >>> RESULT: ${r.solved ? "SOLVED" : "UNSOLVED"} · ${r.turns} turn(s) · ${r.escalations} escalation(s) · haltReason=${r.haltReason}`);
    summary.push({ id: t.id, solved: r.solved, escalations: r.escalations, turns: r.turns });
  }
  const n = summary.length, solved = summary.filter((s) => s.solved).length, esc = summary.filter((s) => s.escalations > 0).length;
  console.log("\n" + "=".repeat(72));
  console.log(`SUMMARY: solved ${solved}/${n} · escalated ${esc}/${n} (${Math.round((esc / n) * 100)}%)`);
  summary.forEach((s) => console.log(`  ${s.id.padEnd(28)} ${s.solved ? "SOLVED" : "UNSOLVED"}  (${s.escalations ? "escalated" : "cheap"}, ${s.turns} turns)`));
}
main().catch((e) => { console.error("eval error:", e.message); process.exit(1); });
