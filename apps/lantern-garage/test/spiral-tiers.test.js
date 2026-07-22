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
 * Zero-dep — run with:  node --test apps/lantern-garage/test/spiral-tiers.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runSpiral } = require("../lib/spiral-harness");
const { makeTiers, makeVerifier, extractCode } = require("../lib/spiral-tiers");

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
  assert.equal(r.haltReason, "maxTurns");
  assert.equal(r.memory.length, 0, "no unverified code was ever committed");
});

test("extractCode prefers a fenced block, tolerates bare code", () => {
  assert.match(extractCode("here:\n```js\nconst x=1;\n```\ndone", "js"), /^const x=1;$/);
  assert.equal(extractCode("const y=2;", "js"), "const y=2;", "no fence → whole text");
  assert.match(extractCode("```\nplain\n```"), /plain/, "unlabeled fence still extracted");
});
