"use strict";

/**
 * test/spiral-env.test.js — the action-shaped tier + repo sandbox (#2973).
 *
 * Two halves:
 *   1. lib/spiral-env.js against a REAL temp git repo and REAL commands — the mutation
 *      bit is the load-bearing claim ("did the working tree change?") and stubbing it
 *      would test nothing.
 *   2. runSpiral driven by action-shaped tiers with a stub env — pins the behaviours the
 *      design promises: exploration is free and never escalates, only mutating actions
 *      face the verifier, and the answer-shaped contract still works untouched.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/spiral-env.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { makeRepoEnv, denyReason, clip } = require("../lib/spiral-env");
const { runSpiral } = require("../lib/spiral-harness");

const sink = () => {
  const rows = [];
  return { file: "(test)", rows, append: (r) => rows.push(r) };
};
const clock = () => 1_700_000_000_000;

/** A throwaway git repo with one tracked file. */
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spiral-env-"));
  fs.writeFileSync(path.join(dir, "hello.txt"), "one\n");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

// ── 1. the sandbox ────────────────────────────────────────────────────────────

test("read-only commands run and report mutated:false", async () => {
  const dir = tmpRepo();
  const env = makeRepoEnv({ repoDir: dir });
  const r = await env.run("cat hello.txt");
  assert.equal(r.exitCode, 0);
  assert.match(r.observation, /one/);
  assert.equal(r.mutated, false, "reading a file must not look like a step");
});

test("a write is detected as mutated — from the tree, not the command string", async () => {
  const dir = tmpRepo();
  const env = makeRepoEnv({ repoDir: dir });
  // Deliberately NOT a shell redirect: a naive command-string heuristic would miss this,
  // which is exactly why mutation is measured from git.
  const r = await env.run(`python -c "open('hello.txt','a').write('two\\n')"`);
  if (r.exitCode !== 0) return; // no python on this box — the git-based claim is covered below
  assert.equal(r.mutated, true);
});

test("an untracked new file counts as mutation", async () => {
  const dir = tmpRepo();
  const env = makeRepoEnv({ repoDir: dir });
  const r = await env.run("echo hi > brand-new.txt");
  assert.equal(r.mutated, true);
});

test("commands are jailed to repoDir", async () => {
  const dir = tmpRepo();
  const env = makeRepoEnv({ repoDir: dir });
  const r = await env.run("pwd");
  // Only the leaf is portable: Git Bash on Windows prints /tmp/... for a C:\...\Temp dir,
  // and macOS prints /private/var for /var. The claim under test is "cwd is the repo".
  assert.equal(path.basename(r.stdout.trim()), path.basename(dir));
});

test("a timeout is reported as an observation, not a thrown error", async () => {
  const dir = tmpRepo();
  const env = makeRepoEnv({ repoDir: dir, timeoutMs: 300 });
  const r = await env.run("sleep 5");
  assert.equal(r.timedOut, true);
  assert.match(r.observation, /timed out/);
});

test("denied commands come back as observations so the loop can react", async () => {
  const dir = tmpRepo();
  const env = makeRepoEnv({ repoDir: dir });
  const r = await env.run("sudo rm -rf /");
  assert.ok(r.denied, "must be refused");
  assert.equal(r.mutated, false);
  assert.match(r.observation, /sandbox/);
  assert.ok(denyReason("git push origin master"), "never push from inside a benchmark loop");
  assert.equal(denyReason("ls -la"), null);
});

test("output is middle-elided so a big cat cannot eat the cheap tier's context", () => {
  const long = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const out = clip(long, 500);
  assert.ok(out.length < 700);
  assert.match(out, /^line 0/, "keeps the head (first failure)");
  assert.match(out, /line 4999$/, "keeps the tail (the summary line)");
  assert.match(out, /elided/);
});

// ── 2. the loop, driven by actions ────────────────────────────────────────────

/** An env stub: `mutates` lists the exact commands that dirty the tree. */
const stubEnv = (mutates = []) => ({
  calls: [],
  async run(action) {
    this.calls.push(action);
    return { observation: `ran: ${action}`, mutated: mutates.includes(action), exitCode: 0, denied: null };
  },
});

test("exploration is free: non-mutating actions never verify and never escalate", async () => {
  const env = stubEnv([]);
  let verifies = 0;
  let escalations = 0;
  const corpus = sink();

  const res = await runSpiral({
    problem: { id: "p" },
    env,
    tiers: {
      cheap: async ({ turn }) => ({ action: `ls dir${turn}` }),
      escalate: async () => { escalations += 1; return { action: "frontier" }; },
    },
    verify: async () => { verifies += 1; return []; },
    observeLimit: 3,
    corpus, runId: "obs", now: clock,
  });

  assert.equal(verifies, 0, "an ls must not cost a verifier run");
  assert.equal(escalations, 0, "paying the frontier to redo an ls is the worst spend in the loop");
  assert.equal(res.haltReason, "observation-limit");
  assert.equal(res.observations, 3);
  assert.equal(res.memory.length, 3, "observations still grow what the next turn knows");
  assert.ok(corpus.rows.every((r) => r.observationOnly && r.action));
});

test("a mutating action faces the verifier and ratchets like any other step", async () => {
  const env = stubEnv(["patch"]);
  const seen = [];
  const res = await runSpiral({
    problem: { id: "p" },
    env,
    tiers: { cheap: async ({ turn }) => ({ action: turn === 0 ? "grep foo" : "patch" }) },
    verify: async (subject, ctx) => {
      seen.push({ subject, observation: ctx.observation });
      return [{ name: "t", passed: true }];
    },
    corpus: sink(), runId: "mut", now: clock,
  });

  assert.equal(seen.length, 1, "only the mutating turn is verified");
  assert.equal(seen[0].subject, "patch");
  assert.equal(seen[0].observation, "ran: patch", "the verifier sees what the command printed");
  assert.equal(res.solved, true);
  assert.equal(res.observations, 1);
  assert.equal(res.escalationRate, 0);
});

test("escalation rate counts only steps that could have escalated", async () => {
  // 2 explorations + 1 mutating step that stalls cheap then escalates = 1/1, not 1/3.
  const env = stubEnv(["edit", "edit-better"]);
  const res = await runSpiral({
    problem: { id: "p" },
    env,
    tiers: {
      cheap: async ({ turn }) => ({ action: turn < 2 ? `look${turn}` : "edit" }),
      escalate: async () => ({ action: "edit-better", text: "done" }),
    },
    verify: async (subject) => (subject === "done" ? [{ name: "t", passed: true }] : [{ name: "t", passed: false }]),
    corpus: sink(), runId: "rate", now: clock,
  });
  assert.equal(res.observations, 2);
  assert.equal(res.escalations, 1);
  assert.equal(res.escalationRate, 1, "2 greps must not dilute the one governing number");
});

test("a frontier call spent exploring is billed but never inflates the rate above 1", async () => {
  // The escalate tier is allowed to look around too. That call costs money (so it counts
  // as an escalation) but it is not a step, so the rate's denominator must not miss it.
  const env = stubEnv(["bad-edit", "fix"]);
  const res = await runSpiral({
    problem: { id: "p" },
    env,
    tiers: {
      cheap: async ({ turn }) => ({ action: turn === 0 ? "bad-edit" : "fix" }),
      escalate: async () => ({ action: "frontier-peek" }), // read-only: an observation
    },
    verify: async (subject) => [{ name: "t", passed: subject === "fix" }],
    corpus: sink(), runId: "peek", now: clock,
  });
  assert.equal(res.escalations, 1, "the frontier call is billed");
  assert.equal(res.stepEscalations, 0, "…but it was exploration, not a step");
  assert.ok(res.escalationRate <= 1);
});

test("a repeated action is caught by the loop detector", async () => {
  const env = stubEnv([]);
  const res = await runSpiral({
    problem: { id: "p" },
    env,
    tiers: { cheap: async () => ({ action: "ls" }) },
    observeLimit: 0, // disable the observation bound so the DUP path is what halts us
    corpus: sink(), runId: "dup", now: clock,
  verify: async () => [],
  });
  assert.ok(["loop", "stalled"].includes(res.haltReason), `expected a repetition halt, got ${res.haltReason}`);
  assert.ok(res.turns < 12, "must not grind to the turn cap re-running the same command");
});

test("an action with no env is a wiring error, surfaced loudly", async () => {
  await assert.rejects(
    () => runSpiral({
      problem: { id: "p" },
      tiers: { cheap: async () => ({ action: "ls" }) },
      verify: async () => [],
      corpus: sink(), runId: "noenv", now: clock,
    }),
    /no env was injected/,
  );
});

test("the answer-shaped contract is untouched", async () => {
  // The 204-row VTD corpus and every MBPP/TACO run depend on this path exactly as-is.
  const res = await runSpiral({
    problem: { id: "p" },
    tiers: { cheap: async () => ({ text: "solution" }) },
    verify: async () => [{ name: "t", passed: true }],
    corpus: sink(), runId: "answer", now: clock,
  });
  assert.equal(res.solved, true);
  assert.equal(res.y, "solution");
  assert.equal(res.observations, 0);
});
