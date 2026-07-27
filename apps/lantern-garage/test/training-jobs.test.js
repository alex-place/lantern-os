"use strict";
// Training-job issue parsing — the ONLY path a job can enter the board (orchestration rework).
const test = require("node:test");
const assert = require("node:assert");
const { _parseJobBlock } = require("../routes/training-jobs");

test("valid block parses and passes the allowlist", () => {
  const body = [
    "Some prose.",
    "```training-job",
    "script: scripts/train_qlora_qwen_coder.py",
    "args: --seed 3 --epochs 1",
    "dataset: data/eval/spiral/self-train/spiral-self-train-v1.jsonl",
    "vram_gb: 8",
    "```",
  ].join("\n");
  const { fields, errors } = _parseJobBlock(body);
  assert.deepEqual(errors, []);
  assert.equal(fields.script, "scripts/train_qlora_qwen_coder.py");
  assert.equal(fields.args, "--seed 3 --epochs 1");
});

test("missing block, off-allowlist script, and shell metacharacters are all rejected", () => {
  assert.match(_parseJobBlock("no block here").errors[0], /no ```training-job block/);
  const off = _parseJobBlock("```training-job\nscript: scripts/evil.py\n```");
  assert.match(off.errors.join(" "), /not on allowlist/);
  const meta = _parseJobBlock("```training-job\nscript: scripts/train_qlora_qwen_coder.py\nargs: --x; rm -rf\n```");
  assert.match(meta.errors.join(" "), /disallowed characters/);
});

test("windows CRLF bodies parse identically", () => {
  const body = "```training-job\r\nscript: scripts/eval_coding.py\r\n```";
  const { errors } = _parseJobBlock(body);
  assert.deepEqual(errors, []);
});
