"use strict";
/*
 * Does a TINY model gain coding capability from its OWN verified corpus? (ADR-0030, the moat thesis)
 *
 * The claim: "recursive self-improvement through convergence packs a tiny model with coding
 * capability." The honest, no-GPU, no-weight-change form (CLAUDE.md: persistent learning, not
 * retraining) is RETRIEVAL: when the tiny model hits a problem, inject its own accumulated
 * VERIFIED solutions to SIMILAR problems as few-shot context. If that lifts its pass rate on
 * HELD-OUT problems it couldn't solve alone, the owned verified corpus has real transferable
 * value — the flywheel works before we ever spend a dollar on weight-VTD.
 *
 * Protocol (leakage-controlled):
 *   1. SEEN problems → build a verified corpus via the cascade (only solutions that PASS are kept).
 *   2. Embed each seen problem on-box (Ollama nomic-embed-text).
 *   3. HELD-OUT problems (DIFFERENT from seen) measured with the TINY model two ways:
 *        baseline   : tiny model alone
 *        augmented  : tiny model + top-k retrieved verified (problem→solution) few-shot
 *      Retrieval is from SEEN only (no held-out leakage); neighbours are SIMILAR but different.
 *   4. Report baseline vs augmented pass rate. augmented > baseline ⇒ capability transfer.
 *
 * Run:  node experiments/tiny_model_selfimprove.js
 *       SPIRAL_FRONTIER_PROVIDER=openai node experiments/tiny_model_selfimprove.js   (stronger corpus)
 */
const http = require("http");
const { runSpiral } = require("../apps/lantern-garage/lib/spiral-harness");
const { makeTiers, makeVerifier, ollamaComplete, extractCode } = require("../apps/lantern-garage/lib/spiral-tiers");

const TINY = process.env.TINY_MODEL || "qwen2.5-coder:0.5b";
const EMB_MODEL = process.env.EMB_MODEL || "nomic-embed-text";
const K = Number(process.env.RETRIEVE_K || 2);

const jsTests = (pairs) => pairs.map(([name, test]) => ({ name, test }));

// SEEN — build the verified corpus (patterns: dp2 = 2D DP, dp1 = 1D DP, hash, kadane, count)
const SEEN = [
  { id: "coin_change", pattern: "dp1", prompt: "function coin_change(coins, amount) — fewest coins summing to amount, else -1.",
    tests: jsTests([["a", "if(coin_change([1,2,5],11)!==3)throw 1"], ["b", "if(coin_change([2],3)!==-1)throw 1"], ["c", "if(coin_change([1],0)!==0)throw 1"]]) },
  { id: "house_robber", pattern: "dp1", prompt: "function house_robber(nums) — max sum of non-adjacent elements of the array nums.",
    tests: jsTests([["a", "if(house_robber([1,2,3,1])!==4)throw 1"], ["b", "if(house_robber([2,7,9,3,1])!==12)throw 1"], ["c", "if(house_robber([5])!==5)throw 1"]]) },
  { id: "min_distance", pattern: "dp2", prompt: "function min_distance(a, b) — edit distance (insert/delete/replace) from string a to b.",
    tests: jsTests([["a", "if(min_distance('horse','ros')!==3)throw 1"], ["b", "if(min_distance('','abc')!==3)throw 1"]]) },
  { id: "is_anagram", pattern: "count", prompt: "function is_anagram(s, t) — true iff strings s and t are anagrams.",
    tests: jsTests([["a", "if(is_anagram('anagram','nagaram')!==true)throw 1"], ["b", "if(is_anagram('rat','car')!==false)throw 1"]]) },
  { id: "two_sum", pattern: "hash", prompt: "function two_sum(nums, target) — indices [i,j] (i<j) summing to target.",
    tests: jsTests([["a", "let r=two_sum([2,7,11,15],9);if(!(r[0]===0&&r[1]===1))throw 1"], ["b", "let r=two_sum([3,2,4],6);if(!(r[0]===1&&r[1]===2))throw 1"]]) },
  { id: "max_subarray", pattern: "kadane", prompt: "function max_subarray(nums) — maximum contiguous subarray sum.",
    tests: jsTests([["a", "if(max_subarray([-2,1,-3,4,-1,2,1,-5,4])!==6)throw 1"], ["b", "if(max_subarray([-1])!==-1)throw 1"]]) },
];

// HELD-OUT — DIFFERENT problems, same patterns; measure the tiny model with/without retrieval.
const HELDOUT = [
  { id: "climb_stairs", pattern: "dp1", prompt: "function climb_stairs(n) — number of distinct ways to climb n stairs taking 1 or 2 steps.",
    tests: jsTests([["a", "if(climb_stairs(2)!==2)throw 1"], ["b", "if(climb_stairs(3)!==3)throw 1"], ["c", "if(climb_stairs(5)!==8)throw 1"]]) },
  { id: "num_decodings", pattern: "dp1", prompt: "function num_decodings(s) — ways to decode a digit string ('1'->'A'..'26'->'Z'); leading zeros invalid.",
    tests: jsTests([["a", "if(num_decodings('12')!==2)throw 1"], ["b", "if(num_decodings('226')!==3)throw 1"], ["c", "if(num_decodings('06')!==0)throw 1"]]) },
  { id: "longest_common_subsequence", pattern: "dp2", prompt: "function longest_common_subsequence(a, b) — length of the LCS of strings a and b.",
    tests: jsTests([["a", "if(longest_common_subsequence('abcde','ace')!==3)throw 1"], ["b", "if(longest_common_subsequence('abc','def')!==0)throw 1"]]) },
  { id: "unique_paths", pattern: "dp2", prompt: "function unique_paths(m, n) — number of paths from top-left to bottom-right of an m x n grid moving only right/down.",
    tests: jsTests([["a", "if(unique_paths(3,7)!==28)throw 1"], ["b", "if(unique_paths(3,2)!==3)throw 1"]]) },
  { id: "contains_duplicate", pattern: "hash", prompt: "function contains_duplicate(nums) — true iff any value appears at least twice in the array nums.",
    tests: jsTests([["a", "if(contains_duplicate([1,2,3,1])!==true)throw 1"], ["b", "if(contains_duplicate([1,2,3,4])!==false)throw 1"]]) },
  { id: "max_product_subarray", pattern: "kadane", prompt: "function max_product_subarray(nums) — maximum product of a contiguous subarray.",
    tests: jsTests([["a", "if(max_product_subarray([2,3,-2,4])!==6)throw 1"], ["b", "if(max_product_subarray([-2,0,-1])!==0)throw 1"]]) },
];

function embed(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: EMB_MODEL, prompt: text });
    const req = http.request({ host: "127.0.0.1", port: 11434, path: "/api/embeddings", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 30000 },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { const j = JSON.parse(d); j.embedding ? resolve(j.embedding) : reject(new Error("no embedding: " + d.slice(0, 80))); } catch (e) { reject(e); } }); });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("embed timeout")));
    req.write(body); req.end();
  });
}
const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9); };
const allPass = (results) => results.length > 0 && results.every((r) => r.passed);

async function tinySolve(prompt, model = TINY, maxTokens = 700) {
  return extractCode(await ollamaComplete(model)(prompt, maxTokens), "js");
}

async function main() {
  console.log(`Tiny-model self-improvement — tiny=${TINY}, embeddings=${EMB_MODEL}, k=${K}`);
  const frontierProvider = process.env.SPIRAL_FRONTIER_PROVIDER || "ollama";
  const frontierModel = frontierProvider === "ollama" ? "qwen2.5-coder:latest" : null;

  // 1+2. Build the verified corpus from SEEN (keep only PASS solutions) + embed.
  console.log(`\n[1/3] Building verified corpus from ${SEEN.length} SEEN problems (cascade: ${TINY} → ${frontierProvider}${frontierModel ? ":" + frontierModel : ""}) ...`);
  const tiers = makeTiers({ language: "js", cheapProvider: "ollama", cheapModel: TINY, frontierProvider, frontierModel });
  let embOk = true;
  try { await embed("probe"); } catch { embOk = false; }
  console.log(`   retrieval: ${embOk ? EMB_MODEL + " embeddings (cosine)" : "pattern-category match (embedder unavailable — oracle-category ceiling; `ollama pull " + EMB_MODEL + "` for real embedding retrieval)"}`);
  const corpus = [];
  for (const p of SEEN) {
    const r = await runSpiral({ problem: { id: p.id, prompt: p.prompt }, tiers, verify: makeVerifier({ language: "js", tests: p.tests, entryPoint: p.id }), maxTurns: 4 });
    if (r.solved && r.y) { corpus.push({ id: p.id, pattern: p.pattern, prompt: p.prompt, solution: r.y, emb: embOk ? await embed(p.prompt) : null }); console.log(`   ✓ ${p.id} (verified, ${r.escalations ? "escalated" : "cheap"})`); }
    else console.log(`   ✗ ${p.id} — no verified solution, EXCLUDED from corpus (honesty: only verified traces)`);
  }

  // 3. Measure the TINY model on HELD-OUT: baseline vs retrieval-augmented.
  console.log(`\n[2/3] Measuring TINY (${TINY}) on ${HELDOUT.length} HELD-OUT problems: baseline vs +retrieval(k=${K})\n`);
  const rows = [];
  for (const p of HELDOUT) {
    const base = `Solve this. Reply with ONLY a JS code block. Define the function with EXACTLY the name given (snake_case; do NOT camelCase it).\n${p.prompt}`;
    const baseCode = await tinySolve(base);
    const baseOk = allPass(await makeVerifier({ language: "js", tests: p.tests, entryPoint: p.id })(baseCode));

    let neigh;
    if (embOk) { const emb = await embed(p.prompt); neigh = corpus.map((c) => ({ c, sim: cosine(emb, c.emb) })).sort((a, b) => b.sim - a.sim).slice(0, K); }
    else {
      const same = corpus.filter((c) => c.pattern === p.pattern).map((c) => ({ c, sim: 1 }));
      const other = corpus.filter((c) => c.pattern !== p.pattern).map((c) => ({ c, sim: 0 }));
      neigh = same.concat(other).slice(0, K);
    }
    const shots = neigh.map((n) => `// Similar solved problem (${n.c.pattern}): ${n.c.prompt}\n${n.c.solution}`).join("\n\n");
    const aug = `Here are similar problems you have ALREADY solved correctly — reuse the technique:\n\n${shots}\n\nNow solve this NEW problem the same way. Reply with ONLY a JS code block. Define the function with EXACTLY the name given (snake_case).\n${p.prompt}`;
    const augCode = await tinySolve(aug);
    const augOk = allPass(await makeVerifier({ language: "js", tests: p.tests, entryPoint: p.id })(augCode));

    const flag = !baseOk && augOk ? "  <-- RETRIEVAL RESCUED" : baseOk && !augOk ? "  <-- regressed" : "";
    console.log(`   ${p.id.padEnd(28)} baseline=${baseOk ? "PASS" : "FAIL"}  +retrieval=${augOk ? "PASS" : "FAIL"}   [retrieved: ${neigh.map((n) => `${n.c.id}(${n.sim.toFixed(2)})`).join(", ")}]${flag}`);
    if (baseOk && !augOk) {
      const ind = (s) => String(s).split("\n").map((l) => "          " + l).join("\n");
      console.log(`      why it regressed — baseline solved it:\n${ind(baseCode)}\n      but +retrieval produced (FAIL):\n${ind(augCode)}`);
    }
    rows.push({ id: p.id, baseOk, augOk });
  }

  const n = rows.length, base = rows.filter((r) => r.baseOk).length, aug = rows.filter((r) => r.augOk).length;
  const rescued = rows.filter((r) => !r.baseOk && r.augOk).length, regressed = rows.filter((r) => r.baseOk && !r.augOk).length;
  console.log(`\n[3/3] RESULT — tiny model on held-out problems it was NOT trained/shown:`);
  console.log(`   baseline (${TINY} alone)         : ${base}/${n}`);
  console.log(`   + retrieval (own verified corpus): ${aug}/${n}   (rescued ${rescued}, regressed ${regressed})`);
  console.log(`   corpus size: ${corpus.length} verified traces`);
  console.log(aug > base
    ? `   => the owned verified corpus LIFTED the tiny model by +${aug - base} on held-out problems (the flywheel transfers).`
    : `   => no net lift this run (aug ${aug} vs base ${base}); honest null/negative result — report it, don't bury it.`);
}
main().catch((e) => { console.error("selfimprove error:", e.message); process.exit(1); });
