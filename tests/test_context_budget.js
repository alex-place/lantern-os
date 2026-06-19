/**
 * Unit tests for the token-budgeted REMEMBER-stage context assembly (issue #772).
 *   - apps/lantern-garage/lib/stream-chat/context-budget.js (pure core)
 *   - apps/lantern-garage/lib/session-summary-store.js (no-session fallback path)
 *
 * Pure unit tests — no server, no network. Run: node tests/test_context_budget.js
 */

const assert = require("assert");
const path = require("path");

const cb = require(path.resolve(__dirname, "..", "apps", "lantern-garage", "lib", "stream-chat", "context-budget.js"));
const store = require(path.resolve(__dirname, "..", "apps", "lantern-garage", "lib", "session-summary-store.js"));

const {
  estimateTokens,
  contextWindowFor,
  condenseTurn,
  buildRollingSummary,
  coalesceRoles,
  normalizeProviderSequence,
  assembleBudgetedContext,
  SUMMARY_HEADER,
  SUMMARY_ACK,
} = cb;

// Build the exact message sequence a provider receives: the assembled context
// followed by the real (always-user) current message. Used to assert the
// Anthropic-style invariants (start user, strict alternation, never end user).
const providerSeq = (compacted) => [...compacted.map((h) => ({ role: h.role })), { role: "user" }];
function assertValidProviderSeq(seq, label) {
  if (seq.length === 0) return;
  assert.strictEqual(seq[0].role, "user", `${label}: must start on user`);
  for (let i = 1; i < seq.length; i++) {
    assert.notStrictEqual(seq[i].role, seq[i - 1].role, `${label}: roles repeat at ${i}`);
  }
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  ✗ ${name}\n    ${err.message}\n`);
    failed++;
  }
}

// helpers
const turn = (role, text) => ({ role, text });
const big = (n) => "x".repeat(n);
const sumTokens = (arr) => arr.reduce((a, m) => a + estimateTokens(m.text), 0);

// ── estimateTokens ───────────────────────────────────────────────────────────
process.stdout.write("\nestimateTokens()\n\n");

test("null/undefined → 0", () => {
  assert.strictEqual(estimateTokens(null), 0);
  assert.strictEqual(estimateTokens(undefined), 0);
  assert.strictEqual(estimateTokens(""), 0);
});

test("~len/4 and monotonic", () => {
  assert.strictEqual(estimateTokens("abcd"), 1);
  assert.strictEqual(estimateTokens("a".repeat(400)), 100);
  assert.ok(estimateTokens("a".repeat(800)) > estimateTokens("a".repeat(400)));
});

// ── contextWindowFor ─────────────────────────────────────────────────────────
process.stdout.write("\ncontextWindowFor()\n\n");

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("Auto (no provider) → local default 8192", () => {
  withEnv({ CHAT_CONTEXT_BUDGET_TOKENS: undefined, CHAT_LOCAL_CONTEXT_TOKENS: undefined }, () => {
    assert.strictEqual(contextWindowFor({}), 8192);
    assert.strictEqual(contextWindowFor({ requestedProvider: "" }), 8192);
  });
});

test("explicit cloud providers map to their windows", () => {
  withEnv({ CHAT_CONTEXT_BUDGET_TOKENS: undefined, CHAT_LOCAL_CONTEXT_TOKENS: undefined }, () => {
    assert.strictEqual(contextWindowFor({ requestedProvider: "anthropic" }), 200000);
    assert.strictEqual(contextWindowFor({ requestedProvider: "claude-sonnet" }), 200000);
    assert.strictEqual(contextWindowFor({ requestedProvider: "openai" }), 128000);
    assert.strictEqual(contextWindowFor({ requestedProvider: "gpt" }), 128000);
    assert.strictEqual(contextWindowFor({ requestedProvider: "gemini" }), 1000000);
    assert.strictEqual(contextWindowFor({ requestedProvider: "grok" }), 131072);
    assert.strictEqual(contextWindowFor({ requestedProvider: "ollama" }), 8192);
  });
});

test("CHAT_CONTEXT_BUDGET_TOKENS hard-overrides everything", () => {
  withEnv({ CHAT_CONTEXT_BUDGET_TOKENS: "4096" }, () => {
    assert.strictEqual(contextWindowFor({ requestedProvider: "anthropic" }), 4096);
    assert.strictEqual(contextWindowFor({}), 4096);
  });
});

test("CHAT_LOCAL_CONTEXT_TOKENS overrides the auto default", () => {
  withEnv({ CHAT_CONTEXT_BUDGET_TOKENS: undefined, CHAT_LOCAL_CONTEXT_TOKENS: "16384" }, () => {
    assert.strictEqual(contextWindowFor({}), 16384);
    assert.strictEqual(contextWindowFor({ requestedProvider: "ollama" }), 16384);
    // explicit cloud still uses its own window
    assert.strictEqual(contextWindowFor({ requestedProvider: "anthropic" }), 200000);
  });
});

// ── condenseTurn ─────────────────────────────────────────────────────────────
process.stdout.write("\ncondenseTurn()\n\n");

test("labels by role", () => {
  assert.ok(condenseTurn(turn("user", "hello there")).startsWith("- You:"));
  assert.ok(condenseTurn(turn("assistant", "hi back")).startsWith("- Keystone:"));
});

test("clips to maxWords with ellipsis + collapses whitespace", () => {
  const t = turn("user", "one two three\n\n four   five six");
  const out = condenseTurn(t, 3);
  assert.strictEqual(out, "- You: one two three…");
});

test("no ellipsis when under the word cap", () => {
  assert.strictEqual(condenseTurn(turn("user", "short"), 10), "- You: short");
});

test("empty text → (no text)", () => {
  assert.strictEqual(condenseTurn(turn("assistant", "")), "- Keystone: (no text)");
});

// ── buildRollingSummary ──────────────────────────────────────────────────────
process.stdout.write("\nbuildRollingSummary()\n\n");

test("empty turns → empty string", () => {
  assert.strictEqual(buildRollingSummary([]), "");
  assert.strictEqual(buildRollingSummary(null), "");
});

test("keeps most-recent lines within budget and notes elision", () => {
  const turns = Array.from({ length: 10 }, (_, i) => turn(i % 2 ? "assistant" : "user", `line number ${i} content`));
  const out = buildRollingSummary(turns, { maxTokens: 20 });
  assert.ok(out.includes("elided"), "should note dropped lines");
  // the most recent line (index 9) must be present; an early one dropped
  assert.ok(out.includes("line number 9"), "keeps newest");
  assert.ok(!out.includes("line number 0"), "drops oldest under tight budget");
});

test("fits entirely when budget is ample (no elision note)", () => {
  const turns = [turn("user", "alpha"), turn("assistant", "beta")];
  const out = buildRollingSummary(turns, { maxTokens: 1000 });
  assert.ok(!out.includes("elided"));
  assert.ok(out.includes("alpha") && out.includes("beta"));
});

// ── assembleBudgetedContext ──────────────────────────────────────────────────
process.stdout.write("\nassembleBudgetedContext()\n\n");

test("empty turns → empty compacted, no summary", () => {
  const r = assembleBudgetedContext({ turns: [], currentMessage: "hi" });
  assert.deepStrictEqual(r.compacted, []);
  assert.strictEqual(r.summary, "");
  assert.strictEqual(r.meta.summarized, 0);
});

test("small history is kept verbatim with no summary injected", () => {
  const turns = [
    turn("user", "first question"),
    turn("assistant", "first answer"),
    turn("user", "second question"),
    turn("assistant", "second answer"),
  ];
  const r = assembleBudgetedContext({ turns, currentMessage: "third", contextWindow: 8192 });
  assert.strictEqual(r.summary, "");
  assert.strictEqual(r.meta.summarized, 0);
  assert.strictEqual(r.compacted.length, 4);
  assert.deepStrictEqual(r.compacted, turns);
});

test("never drops the most recent turn, and summarizes the overflow", () => {
  // 12k-char turns (~3000 tokens each) vs a tight ~2600-token verbatim budget.
  const turns = [
    turn("user", big(12000)),
    turn("assistant", big(12000)),
    turn("user", big(12000)),
    turn("assistant", "the freshest reply"),
  ];
  const r = assembleBudgetedContext({
    turns,
    currentMessage: "",
    contextWindow: 4000,
    maxOutputTokens: 0,
    systemReserve: 0,
    marginTokens: 0,
    maxHistory: 4000,
  });
  assert.ok(r.meta.summarized >= 1, "older turns should be summarized");
  assert.ok(r.meta.keptVerbatim >= 1, "at least the most recent turn kept");
  assert.ok(r.summary.length > 0, "summary built from overflow");
  // the freshest reply survives verbatim somewhere in compacted
  assert.ok(r.compacted.some((m) => m.text === "the freshest reply"), "freshest turn kept verbatim");
});

test("summary + single kept user turn: merges, then ends on a synthetic assistant ack", () => {
  // Force only the last (user) turn to be kept verbatim. The summary (user) and
  // the kept user turn coalesce into one user block; a trailing synthetic ack
  // keeps the sequence from ending on user.
  const turns = [
    turn("assistant", big(12000)),
    turn("user", big(12000)),
    turn("assistant", big(12000)),
    turn("user", "latest user line"),
  ];
  const r = assembleBudgetedContext({
    turns, currentMessage: "", contextWindow: 4000,
    maxOutputTokens: 0, systemReserve: 0, marginTokens: 0, maxHistory: 4000,
  });
  assert.strictEqual(r.compacted.length, 2);
  assert.strictEqual(r.compacted[0].role, "user");
  assert.ok(r.compacted[0].text.startsWith(SUMMARY_HEADER), "leads with summary header");
  assert.ok(r.compacted[0].text.includes("latest user line"), "merged the kept user turn");
  assert.strictEqual(r.compacted[1].role, "assistant");
  assert.strictEqual(r.compacted[1].text, SUMMARY_ACK);
  assert.strictEqual(r.compacted[1]._synthetic, true, "ack is flagged synthetic");
  assertValidProviderSeq(providerSeq(r.compacted), "summary+kept-user");
});

test("turns ending on a user (orphan) never leave compacted trailing on user", () => {
  // Realistic non-alternating tail: a turn whose provider reply failed to persist.
  const turns = [
    turn("user", "q1"), turn("assistant", "a1"),
    turn("user", "q2"), turn("assistant", "a2"),
    turn("user", "q3 — no reply was ever logged"),
  ];
  const r = assembleBudgetedContext({ turns, currentMessage: "q4", contextWindow: 8192 });
  assert.strictEqual(r.compacted[r.compacted.length - 1].role, "assistant", "must not trail on user");
  assertValidProviderSeq(providerSeq(r.compacted), "orphan-user-tail");
});

test("non-alternating input (consecutive users) is coalesced into a valid sequence", () => {
  // Two consecutive user turns (e.g. two failed turns in a row) must not survive
  // as user→user in the provider payload.
  const turns = [
    turn("user", "first failed msg"),
    turn("user", "second failed msg"),
    turn("assistant", "finally a reply"),
    turn("user", "and another"),
  ];
  const r = assembleBudgetedContext({ turns, currentMessage: "now", contextWindow: 8192 });
  assertValidProviderSeq(providerSeq(r.compacted), "consecutive-users");
});

test("no ack inserted when the verbatim block already starts with assistant", () => {
  // Force only the last (assistant) turn to be kept → seam is user-summary→assistant.
  const turns = [
    turn("user", big(12000)),
    turn("assistant", big(12000)),
    turn("user", big(12000)),
    turn("assistant", "latest assistant line"),
  ];
  const r = assembleBudgetedContext({
    turns,
    currentMessage: "",
    contextWindow: 4000,
    maxOutputTokens: 0,
    systemReserve: 0,
    marginTokens: 0,
    maxHistory: 4000,
  });
  assert.strictEqual(r.compacted.length, 2, "summary + the single kept assistant turn");
  assert.strictEqual(r.compacted[0].role, "user");
  assert.ok(r.compacted[0].text.startsWith(SUMMARY_HEADER));
  assert.strictEqual(r.compacted[1].role, "assistant");
  assert.strictEqual(r.compacted[1].text, "latest assistant line");
});

test("roles strictly alternate across the whole compacted sequence", () => {
  const turns = Array.from({ length: 20 }, (_, i) => turn(i % 2 ? "assistant" : "user", big(2000) + ` t${i}`));
  const r = assembleBudgetedContext({ turns, currentMessage: "", contextWindow: 8192 });
  for (let i = 1; i < r.compacted.length; i++) {
    assert.notStrictEqual(r.compacted[i].role, r.compacted[i - 1].role, `roles repeat at index ${i}`);
  }
  // and it must not end on a user turn (the real current message, a user turn, follows)
  if (r.compacted.length) {
    assert.strictEqual(r.compacted[r.compacted.length - 1].role, "assistant", "should not trail on a user turn");
  }
});

test("non user/assistant roles and empty text are filtered out", () => {
  const turns = [
    turn("system", "ignore me"),
    turn("user", ""),
    turn("user", "kept"),
    turn("assistant", "reply"),
  ];
  const r = assembleBudgetedContext({ turns, currentMessage: "x", contextWindow: 8192 });
  assert.strictEqual(r.compacted.length, 2);
  assert.deepStrictEqual(r.compacted.map((m) => m.text), ["kept", "reply"]);
});

// ── coalesceRoles / normalizeProviderSequence ────────────────────────────────
process.stdout.write("\ncoalesceRoles() / normalizeProviderSequence()\n\n");

test("coalesceRoles merges consecutive same-role turns", () => {
  const out = coalesceRoles([
    turn("user", "a"), turn("user", "b"), turn("assistant", "c"), turn("assistant", "d"), turn("user", "e"),
  ]);
  assert.deepStrictEqual(out.map((m) => m.role), ["user", "assistant", "user"]);
  assert.strictEqual(out[0].text, "a\nb");
  assert.strictEqual(out[1].text, "c\nd");
});

test("coalesceRoles drops the synthetic flag once real content is merged in", () => {
  const out = coalesceRoles([
    { role: "user", text: "summary", _synthetic: true },
    { role: "user", text: "real user msg" },
  ]);
  assert.strictEqual(out.length, 1);
  assert.ok(!out[0]._synthetic, "merged turn carries real content → not synthetic");
});

test("normalizeProviderSequence guarantees start-user / alternate / end-assistant", () => {
  const cases = [
    [],
    [turn("user", "u")],
    [turn("assistant", "a")],
    [turn("assistant", "a"), turn("user", "u")],
    [turn("user", "u1"), turn("user", "u2"), turn("assistant", "a")],
    [turn("user", "u"), turn("assistant", "a"), turn("user", "u2")],
    [turn("assistant", "a1"), turn("assistant", "a2")],
  ];
  for (const c of cases) {
    const out = normalizeProviderSequence(c.map((t) => ({ ...t })));
    if (out.length) {
      assert.strictEqual(out[0].role, "user", `start-user for ${JSON.stringify(c)}`);
      assert.strictEqual(out[out.length - 1].role, "assistant", `end-assistant for ${JSON.stringify(c)}`);
      for (let i = 1; i < out.length; i++) {
        assert.notStrictEqual(out[i].role, out[i - 1].role, `alternate for ${JSON.stringify(c)} at ${i}`);
      }
    }
    // and appending the real user message stays valid
    assertValidProviderSeq(providerSeq(out), JSON.stringify(c));
  }
});

test("deterministic fuzz: any messy history → valid provider sequence", () => {
  // Deterministic pseudo-random sequences (no Math.random) covering odd lengths,
  // role runs, tight budgets, and empty texts.
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 0; n < 60; n++) {
    const len = Math.floor(rand() * 14);
    const turns = Array.from({ length: len }, () => {
      const role = rand() < 0.5 ? "user" : "assistant";
      const text = rand() < 0.15 ? "" : "w ".repeat(1 + Math.floor(rand() * 40)).trim();
      return turn(role, text);
    });
    const r = assembleBudgetedContext({
      turns,
      currentMessage: "current",
      contextWindow: 2000 + Math.floor(rand() * 8000),
      maxHistory: 300 + Math.floor(rand() * 4000),
    });
    assertValidProviderSeq(providerSeq(r.compacted), `fuzz n=${n} len=${len}`);
  }
});

// ── session-summary-store: no-session fallback (pure, no I/O) ─────────────────
process.stdout.write("\nsession-summary-store (no-session path)\n\n");

test("normalizeClientHistory maps roles/text and drops empties", () => {
  const out = store.normalizeClientHistory([
    { role: "user", text: "a" },
    { role: "assistant", content: "b" },
    { role: "user", text: "" },
    null,
    { role: "weird", text: "c" },
  ]);
  assert.deepStrictEqual(out, [
    { role: "user", text: "a" },
    { role: "assistant", text: "b" },
    { role: "user", text: "c" }, // unknown role coerced to user
  ]);
});

test("assembleSessionContext with no sessionId uses client history verbatim", () => {
  const clientHistory = [
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
    { role: "assistant", text: "a2" },
  ];
  const r = store.assembleSessionContext({
    sessionId: null,
    clientHistory,
    currentMessage: "q3",
    requestedProvider: "",
    surfaceMode: "dream-chat",
  });
  assert.strictEqual(r.meta.source, "client");
  assert.strictEqual(r.meta.summarized, 0);
  assert.deepStrictEqual(r.compacted, clientHistory);
});

// ── Summary ──────────────────────────────────────────────────────────────────
const total = passed + failed;
process.stdout.write(`\n${passed}/${total} passed\n`);
if (failed > 0) {
  process.stderr.write(`${failed} failed\n`);
  process.exit(1);
}
