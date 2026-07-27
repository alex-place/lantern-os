"use strict";

/**
 * test/spiral-edit.test.js — search/replace edits (#2975) + SWE focus rotation (#2974).
 *
 * The edit half runs against REAL files in a temp repo: the claim under test is "the
 * SEARCH text must match the file exactly or nothing is written", and a stub filesystem
 * would let a bug that writes the wrong bytes pass.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/spiral-edit.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseEdits, applyEdits, locate, EDIT_FORMAT_HELP } = require("../lib/spiral-edit");
const { makeSweRotation, SWE_FOCI, focusGuidance } = require("../lib/spiral-swe-focus");
const { runSpiral } = require("../lib/spiral-harness");

const sink = () => { const rows = []; return { file: "(test)", rows, append: (r) => rows.push(r) }; };
const clock = () => 1_700_000_000_000;

function tmpDir(files = { "a.py": "def f():\n    return 1\n" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spiral-edit-"));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}
const block = (file, search, replace) =>
  `<<<<<<< SEARCH ${file}\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

// ── parsing ───────────────────────────────────────────────────────────────────

test("blocks are parsed out of surrounding prose", () => {
  // A small model narrates no matter what the prompt says; failing the turn over a stray
  // sentence is a format tax we already know we cannot afford.
  const reply = `Sure! I'll fix that.\n\n${block("a.py", "return 1", "return 2")}\n\nHope that helps.`;
  const eds = parseEdits(reply);
  assert.equal(eds.length, 1);
  assert.equal(eds[0].file, "a.py");
  assert.equal(eds[0].search, "return 1");
  assert.equal(eds[0].replace, "return 2");
});

test("multiple blocks parse in order", () => {
  const eds = parseEdits(`${block("a.py", "x", "y")}\n${block("b.py", "p", "q")}`);
  assert.deepEqual(eds.map((e) => e.file), ["a.py", "b.py"]);
});

// ── the exact-match rule ──────────────────────────────────────────────────────

test("a unique exact match applies", () => {
  const dir = tmpDir();
  const r = applyEdits(dir, block("a.py", "    return 1", "    return 2"));
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "def f():\n    return 2\n");
});

test("an ambiguous match applies NOTHING", () => {
  // A patch that lands in the wrong function is worse than one that doesn't land: it burns
  // the turn AND poisons the verifier's signal for it.
  const dir = tmpDir({ "a.py": "def f():\n    return 1\n\ndef g():\n    return 1\n" });
  const before = fs.readFileSync(path.join(dir, "a.py"), "utf8");
  const r = applyEdits(dir, block("a.py", "    return 1", "    return 2"));
  assert.equal(r.ok, false);
  assert.match(r.failures[0].reason, /ambiguous/);
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), before, "file must be untouched");
});

test("a miss reports why, and says so in the observation the next turn reads", () => {
  const dir = tmpDir();
  const r = applyEdits(dir, block("a.py", "return 42", "return 2"));
  assert.equal(r.ok, false);
  assert.match(r.failures[0].reason, /not found/);
  assert.match(r.observation, /applied nothing/);
  assert.match(r.observation, /verbatim/, "must tell the model how to recover");
});

test("indentation drift is forgiven, but only when the match is still unique", () => {
  // The file indents 4; the model reproduced the right code with 2. It is right about the
  // hard thing and wrong about the mechanical one.
  const dir = tmpDir();
  const r = applyEdits(dir, block("a.py", "def f():\n  return 1", "def f():\n    return 2"));
  assert.equal(r.ok, true);
  assert.equal(r.applied[0].mode, "whitespace-normalized");
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "def f():\n    return 2\n");
});

test("an exact substring match is preferred and reported as exact", () => {
  const dir = tmpDir();
  const r = applyEdits(dir, block("a.py", "    return 1", "    return 2"));
  assert.equal(r.applied[0].mode, "exact");
});

test("a multi-block set is all-or-nothing", () => {
  // Half-applied edits leave a tree neither the model nor the verifier can reason about.
  const dir = tmpDir({ "a.py": "AAA\n", "b.py": "BBB\n" });
  const r = applyEdits(dir, `${block("a.py", "AAA", "ZZZ")}\n${block("b.py", "NOPE", "QQQ")}`);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "AAA\n", "the good block must not land either");
});

test("two edits to one file compose", () => {
  const dir = tmpDir({ "a.py": "one\ntwo\n" });
  const r = applyEdits(dir, `${block("a.py", "one", "1")}\n${block("a.py", "two", "2")}`);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "1\n2\n");
});

test("paths cannot escape the repo", () => {
  const dir = tmpDir();
  const r = applyEdits(dir, block("../../../etc/passwd", "root", "x"));
  assert.equal(r.ok, false);
  assert.match(r.failures[0].reason, /escapes the repo/);
});

test("a missing file fails cleanly rather than creating one", () => {
  const dir = tmpDir();
  const r = applyEdits(dir, block("nope.py", "x", "y"));
  assert.equal(r.ok, false);
  assert.match(r.failures[0].reason, /does not exist/);
  assert.equal(fs.existsSync(path.join(dir, "nope.py")), false);
});

test("no blocks at all returns the format help, not a crash", () => {
  const dir = tmpDir();
  const r = applyEdits(dir, "I think you should change line 42.");
  assert.equal(r.ok, false);
  assert.match(r.observation, /SEARCH\/REPLACE/);
  assert.match(EDIT_FORMAT_HELP, /never invent line numbers/i);
});

test("locate refuses an empty or whitespace-only SEARCH", () => {
  assert.ok(locate("abc", "").error);
  assert.ok(locate("abc", "   \n  ").error);
});

// ── wired into the loop ───────────────────────────────────────────────────────

test("an edit that applies is a step; one that misses is a stall, not a crash", async () => {
  const dir = tmpDir();
  const { makeRepoEnv } = require("../lib/spiral-env");
  const env = makeRepoEnv({ repoDir: dir });

  const res = await runSpiral({
    problem: { id: "p" },
    env,
    tiers: {
      cheap: async ({ turn }) => ({
        edit: turn === 0
          ? block("a.py", "return 999", "return 2")   // miss → stall
          : block("a.py", "    return 1", "    return 2"), // hit → step
      }),
    },
    verify: async (_s, ctx) => [{ name: "t", passed: /applied 1/.test(String(ctx.observation)) }],
    corpus: sink(), runId: "edit", now: clock,
  });

  assert.equal(res.solved, true);
  assert.equal(res.turns, 2, "the missed edit cost a turn but not the run");
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "def f():\n    return 2\n");
});

test("an edit that changes nothing is not a step", async () => {
  // replace == search: 'applied' is true but the tree is identical. The ratchet must see
  // the tree, not the return value.
  const dir = tmpDir();
  const { makeRepoEnv } = require("../lib/spiral-env");
  const env = makeRepoEnv({ repoDir: dir });
  const r = await env.applyEdits(block("a.py", "    return 1", "    return 1"));
  assert.equal(r.mutated, false);
});

test("an edit with no applyEdits on env is a wiring error", async () => {
  await assert.rejects(
    () => runSpiral({
      problem: { id: "p" },
      env: { run: async () => ({ observation: "", mutated: false }) },
      tiers: { cheap: async () => ({ edit: block("a.py", "x", "y") }) },
      verify: async () => [],
      corpus: sink(), runId: "noapply", now: clock,
    }),
    /no applyEdits/,
  );
});

// ── SWE focus rotation (#2974) ────────────────────────────────────────────────

test("rotation starts at localize and does not patch before looking", () => {
  const rotate = makeSweRotation({ reflectAfterStalls: 0 });
  assert.equal(rotate(0, []), "localize");
  assert.equal(rotate(1, []), "localize", "nothing has been read yet — do not move on");
  assert.equal(rotate(2, [{ action: "grep -rn foo", observationOnly: true }]), "reproduce");
});

test("rotation is state-aware, not a clock", () => {
  const rotate = makeSweRotation({ reflectAfterStalls: 0 });
  const mem = [];
  assert.equal(rotate(0, mem), "localize");
  mem.push({ action: "grep -rn foo", observationOnly: true });   // explored
  assert.equal(rotate(1, mem), "reproduce");
  mem.push({ action: "pytest tests/test_x.py", observationOnly: true }); // reproduced
  assert.equal(rotate(2, mem), "patch");
  mem.push({ files: ["src/x.py"] });                              // patched
  assert.equal(rotate(3, mem), "regress");
});

test("a phase cannot wedge the run forever", () => {
  const rotate = makeSweRotation({ maxPhaseTurns: 2, reflectAfterStalls: 0 });
  const mem = [];
  const seen = [];
  for (let t = 0; t < 8; t++) { seen.push(rotate(t, mem)); mem.push({ text: "x" }); }
  assert.ok(seen.includes("patch"), `expected to reach patch despite no evidence: ${seen.join(",")}`);
});

test("repeated unproductive turns force a reflect", () => {
  const rotate = makeSweRotation({ reflectAfterStalls: 2 });
  const mem = [];
  rotate(0, mem);
  rotate(1, mem); // memory never grew → 1 unproductive
  assert.equal(rotate(2, mem), "reflect");
});

test("guidance carries the interleaved-reflection ask on every working phase", () => {
  for (const f of SWE_FOCI.filter((x) => x !== "reflect")) {
    assert.match(focusGuidance(f), /what the last observation told you/i, `${f} must open with reflection`);
  }
  assert.match(focusGuidance("reflect"), /DIFFERENT action/);
  assert.match(focusGuidance("patch"), /Edit the source, not the test/);
});
