// #2802 — product self-facts must be a deterministic floor in the desk prompt, so the
// assistant can't web-search its own identity and hedge stale sources against its own
// truth (it was observed self-contradicting about whether it runs locally). The fix is
// prompt content, so we assert the ASSEMBLED assistant system prompt carries the
// identity block + the anti-hedge rule. (Behavioral acceptance — a real chat turn —
// needs a served provider; this locks the deterministic half.)
//
// Run: node test/identity-floor.test.js
const assert = require("assert");
const { selectAgent, AGENT_PERSONAS } = require("../lib/dream-chat");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

const prompt = selectAgent("Does unisona.ai run locally on my machine?").systemPrompt;

check("assistant prompt carries the identity-floor block", () => {
  assert.match(prompt, /__unisona_identity__/);
  assert.match(prompt, /self-facts are primary-source truth/i);
});
check("states local-first / runs on the user's machine", () => {
  assert.match(prompt, /runs on the user's own machine/i);
  assert.match(prompt, /local-first/i);
});
check("explicitly forbids the observed self-contradiction", () => {
  // the exact phrasing the live bug emitted must be named as forbidden
  assert.match(prompt, /never say it is[^]{0,20}not designed to run on the user's machine/i);
});
check("forbids web-searching its own identity / hedging on 'available sources'", () => {
  assert.match(prompt, /do NOT web-search your own identity/i);
  assert.match(prompt, /according to available sources/i);  // named as the anti-pattern
});
check("covers the other self-facts (no-account, model-agnostic, local memory)", () => {
  assert.match(prompt, /No account required to try/i);
  assert.match(prompt, /Model-agnostic/i);
  assert.match(prompt, /memory is the user's/i);
});
check("identity floor is idempotent (marker appears exactly once)", () => {
  const count = (prompt.match(/__unisona_identity__/g) || []).length;
  assert.strictEqual(count, 1, `marker count ${count}`);
});
check("applies to the resolved assistant persona (not just a constant)", () => {
  // selectAgent always resolves the single keystone assistant — its prompt must carry it
  assert.ok(AGENT_PERSONAS.length >= 1);
  assert.match(AGENT_PERSONAS[0].systemPrompt, /__unisona_identity__/);
});

process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
