"use strict";

/**
 * test/spiral-tiers.test.js
 *
 * The bridge (ADR-0030): real exec verifier + injectable model tiers. These tests run
 * the WHOLE chain — makeTiers → runSpiral → fixRate → REAL bounded JS exec sandbox
 * (verifyExecAsync) — with a stubbed `complete` so no provider/GPU is needed, but the
 * verification is genuine (a real `node` subprocess decides pass/fail). JS-only so it's
 * portable in CI.
 *
 * Zero-dep — run with:  node --test test/spiral-tiers.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runSpiral } = require("../lib/spiral-harness");
const { makeTiers, makeVerifier, extractCode, resolveLocalModel } = require("../lib/spiral-tiers");

const TWO_SUM = {
  id: "two_sum",
  prompt: "function two_sum(nums, target) — return indices [i,j] (i<j) of the two entries summing to target.",
};
const TESTS = [
  { name: "basic", test: "const r=two_sum([2,7,11,15],9); if(!(r[0]===0&&r[1]===1)) throw new Error('basic '+r);" },
  { name: "mid", test: "const r=two_sum([3,2,4],6); if(!(r[0]===1&&r[1]===2)) throw new Error('mid '+r);" },
];
const GOOD = `function two_sum(nums,target){const seen={};for(let i=0;i<nums.length;i++){const n=target-nums[i];if(n in seen)return [seen[n],i];seen[nums[i]]=i;}return [];}`;
const BAD = `function two_sum(nums,target){return [9,9];}`;

test("makeVerifier runs the REAL sandbox → correct per-test pass/fail", async () => {
  const verify = makeVerifier({ language: "js", tests: TESTS });
  const good = await verify(GOOD);
  assert.deepEqual(good.map((r) => r.passed), [true, true], "correct code passes both real tests");
  const bad = await verify(BAD);
  assert.deepEqual(bad.map((r) => r.passed), [false, false], "wrong code fails both real tests");
  assert.ok(bad[0].output, "a failure carries the real error text for the next turn");
});

test("end-to-end: a cheap tier that returns correct code solves in one verified turn", async () => {
  const complete = async () => "```js\n" + GOOD + "\n```"; // model 'reply' with a fenced block
  const tiers = makeTiers({ language: "js", complete });
  const r = await runSpiral({
    problem: TWO_SUM, tiers, verify: makeVerifier({ language: "js", tests: TESTS }),
    corpus: { file: "(test)", append() {} },
  });
  assert.equal(r.solved, true, "the real tests pass → solved");
  assert.equal(r.escalations, 0, "cheap sufficed");
  assert.match(r.y, /seen/, "the verified solution is the cheap tier's code");
});

test("end-to-end: cheap fails the REAL tests → escalate rescues (inheriting progress)", async () => {
  // cheap ('ollama') returns wrong code; frontier ('anthropic') returns correct code.
  const complete = async (provider) => (provider === "anthropic" ? GOOD : BAD);
  const tiers = makeTiers({ language: "js", complete, cheapProvider: "ollama", frontierProvider: "anthropic" });
  const corpus = { rows: [], file: "(test)", append(r) { this.rows.push(r); } };
  const r = await runSpiral({ problem: TWO_SUM, tiers, verify: makeVerifier({ language: "js", tests: TESTS }), corpus });
  assert.equal(r.solved, true, "escalation solved it");
  assert.equal(r.escalations, 1, "exactly one escalation — cheap genuinely failed the sandbox");
  const committed = corpus.rows.find((x) => x.advanced);
  assert.equal(committed.tier, "escalated");
  assert.equal(committed.distillTarget, true, "the frontier rescue is a VTD distillation target");
});

test("honest failure: neither tier can pass the tests → not solved, nothing fabricated", async () => {
  const complete = async () => BAD; // both tiers wrong
  const tiers = makeTiers({ language: "js", complete });
  const r = await runSpiral({
    problem: TWO_SUM, tiers, verify: makeVerifier({ language: "js", tests: TESTS }),
    corpus: { file: "(test)", append() {} }, maxTurns: 3,
  });
  assert.equal(r.solved, false);
  // Both tiers propose the SAME wrong code every turn, so the loop detector calls
  // the cycle honestly (and stops paying the verifier for it) before the turn cap.
  assert.equal(r.haltReason, "loop");
  assert.equal(r.memory.length, 0, "no unverified code was ever committed");
});

test("name-tolerance: a camelCase-renamed function still passes a snake_case entry-point test", async () => {
  // Models often rename `word_break` → `wordBreak`; the exact-name test would ReferenceError
  // even on a correct algorithm. makeVerifier({entryPoint}) aliases the variant back.
  const verify = makeVerifier({
    language: "js", entryPoint: "add_two",
    tests: [{ name: "t", test: "if(add_two(2,3)!==5) throw new Error('x')" }],
  });
  const camel = await verify("function addTwo(a,b){return a+b}");
  assert.equal(camel[0].passed, true, "camelCase addTwo aliased to add_two → PASS");
  // and it does not mask a genuinely wrong algorithm
  const wrong = await verify("function addTwo(a,b){return a-b}");
  assert.equal(wrong[0].passed, false, "wrong logic still fails even after aliasing");
});

test("resolveLocalModel picks a real coder, NEVER the unserved ouro:latest pin", () => {
  // The "fix the local Ollama" contract: the local cheap tier resolves the registry coder,
  // not the OLLAMA_MODEL=ouro:latest env (ouro is served only by ouro_serve.py, not the daemon).
  const prev = process.env.SPIRAL_LOCAL_MODEL;
  delete process.env.SPIRAL_LOCAL_MODEL;
  try {
    const m = resolveLocalModel();
    assert.ok(m && !/^ouro/i.test(m), `resolved '${m}' must not be an ouro model`);
    assert.match(m, /coder/i, "resolves a coder model");
    // explicit override is honored
    process.env.SPIRAL_LOCAL_MODEL = "qwen2.5-coder:3b";
    assert.equal(resolveLocalModel(), "qwen2.5-coder:3b", "SPIRAL_LOCAL_MODEL override wins");
  } finally {
    if (prev === undefined) delete process.env.SPIRAL_LOCAL_MODEL;
    else process.env.SPIRAL_LOCAL_MODEL = prev;
  }
});

test("stdio verifier: TACO-style stdin/stdout tests pass correct programs, reject wrong ones", async (t) => {
  // Needs a python interpreter (the stdio wrapper is Python) — skip gracefully if absent.
  const { spawnSync } = require("child_process");
  if (spawnSync("python", ["--version"], { timeout: 5000 }).status !== 0) return t.skip("no python");
  const v = makeVerifier({ language: "python", tests: [{ name: "c0", stdin: "3\n1 2 3\n", expected: "6" }] });
  const good = await v("n = int(input())\nprint(sum(map(int, input().split())))");
  assert.equal(good[0].passed, true, "correct stdio program passes");
  const bad = await v("n = int(input())\nprint(max(map(int, input().split())))");
  assert.equal(bad[0].passed, false, "wrong output rejected");
});

test("extractCode prefers a fenced block, tolerates bare code", () => {
  assert.match(extractCode("here:\n```js\nconst x=1;\n```\ndone", "js"), /^const x=1;$/);
  assert.equal(extractCode("const y=2;", "js"), "const y=2;", "no fence → whole text");
  assert.match(extractCode("```\nplain\n```"), /plain/, "unlabeled fence still extracted");
});
