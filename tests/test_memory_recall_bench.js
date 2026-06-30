// Test: the memory recall harness measures real retrieval signal (#1739).
// Runnable standalone (`node tests/test_memory_recall_bench.js`) or via `node --test`.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const HARNESS = path.resolve(__dirname, '..', 'experiments', 'memory_recall_bench.js');

test('harness --selftest passes (idf recall@5 == 1.0 and beats keyword on the adversarial fixture)', () => {
  // --selftest exits non-zero if idf doesn't reach recall 1.0, doesn't beat keyword, or mrr<=0.
  const out = execFileSync('node', [HARNESS, '--selftest'], { encoding: 'utf8' });
  assert.match(out, /SELFTEST PASS/);
});

test('harness emits keyword + idf metrics as JSON on the fixture', () => {
  const out = execFileSync('node', [HARNESS, '--no-write', '--json'], { encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.equal(j.dataset, 'synthetic-fixture');
  assert.ok(j.modes.keyword && j.modes.idf, 'both modes present');
  assert.ok(j.modes.idf.recall_at_k >= j.modes.keyword.recall_at_k, 'idf >= keyword recall');
  assert.equal(j.modes.idf.recall_at_k, 1, 'idf finds every gold on the fixture');
});
