"use strict";
// Chat escalation meter — the number the in-house-model decision rests on.
// These tests pin the CONTRACT, not the implementation:
//   - tier classification is model-driven, and a cheap marker beats a frontier family name
//     (claude-3-5-haiku is cheap, not frontier) — getting this backwards would inflate the
//     escalation rate and manufacture a business case that isn't there;
//   - local turns are excluded from the rate's denominator (already free, nothing to save);
//   - PRIVACY: no message text and no raw session id can reach the log;
//   - the verdict thresholds are the ones fixed in the spec doc, before any data existed;
//   - metering never throws, whatever it is handed.
//
// Run: node apps/lantern-garage/test/chat-escalation-meter.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const m = require("../lib/chat-escalation-meter");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

check("the models actually serving us today classify as cheap", () => {
  // Measured from data/conversations: gemini-2.5-flash and gpt-4.1-mini serve the real traffic.
  assert.strictEqual(m.classifyTier("gemini", "gemini-2.5-flash"), "cheap");
  assert.strictEqual(m.classifyTier("openai", "gpt-4.1-mini"), "cheap");
});

check("frontier reasoning models classify as frontier", () => {
  assert.strictEqual(m.classifyTier("anthropic", "claude-opus-5"), "frontier");
  assert.strictEqual(m.classifyTier("openai", "gpt-5"), "frontier");
  assert.strictEqual(m.classifyTier("gemini", "gemini-2.5-pro"), "frontier");
});

check("a cheap marker beats the frontier family name", () => {
  // The trap: every frontier vendor also sells a cheap tier. Misreading haiku/mini/flash as
  // frontier would overstate the escalation rate and invent a saving that does not exist.
  assert.strictEqual(m.classifyTier("anthropic", "claude-3-5-haiku"), "cheap");
  assert.strictEqual(m.classifyTier("xai", "grok-4-mini"), "cheap");
});

check("REGRESSION: 'gemini' contains 'mini' — substring matching must not make Pro look cheap", () => {
  // Found by this suite. A plain substring test matched `mini` inside "ge-mini-", classifying
  // every Gemini Pro turn as cheap. That understates the escalation rate and would have argued
  // against building the model on a measurement artifact. Cheap markers need token boundaries.
  assert.strictEqual(m.classifyTier("gemini", "gemini-2.5-pro"), "frontier");
  assert.strictEqual(m.classifyTier("gemini", "gemini-3-pro"), "frontier");
  // ...while the genuinely cheap Gemini still reads cheap.
  assert.strictEqual(m.classifyTier("gemini", "gemini-2.5-flash"), "cheap");
});

check("size-suffixed open models read as cheap on a boundary", () => {
  assert.strictEqual(m.classifyTier("together", "qwen3-8b"), "cheap");
  assert.strictEqual(m.classifyTier("together", "llama-3.2-3b"), "cheap");
});

check("on-box models classify as local", () => {
  assert.strictEqual(m.classifyTier("ollama", "ouro-1.4b"), "local");
  assert.strictEqual(m.classifyTier("ouro", "whatever"), "local");
});

check("an unknown model falls back to cheap, not frontier", () => {
  // Conservative on purpose: an unclassified model must not inflate the case for building.
  assert.strictEqual(m.classifyTier("newvendor", "some-model-v2"), "cheap");
});

check("escalation rate excludes local turns from the denominator", () => {
  const rows = [
    { ts: new Date().toISOString(), tier: "local" }, { ts: new Date().toISOString(), tier: "local" },
    { ts: new Date().toISOString(), tier: "cheap" }, { ts: new Date().toISOString(), tier: "cheap" },
    { ts: new Date().toISOString(), tier: "cheap" }, { ts: new Date().toISOString(), tier: "frontier" },
  ];
  const s = m.summarize(rows);
  // 1 frontier of 4 BILLABLE turns = 0.25 — the 2 local turns are already free.
  assert.strictEqual(s.escalationRate, 0.25);
  assert.strictEqual(s.turns, 6);
});

check("no data yields a null rate, never a fabricated zero", () => {
  const s = m.summarize([]);
  assert.strictEqual(s.escalationRate, null);
  assert.strictEqual(s.verdict, "no data yet");
  assert.strictEqual(s.sampleAdequate, false);
});

check("the verdict thresholds are the ones fixed in the spec doc", () => {
  const mk = (frontier, cheap) => [
    ...Array(frontier).fill({ ts: new Date().toISOString(), tier: "frontier" }),
    ...Array(cheap).fill({ ts: new Date().toISOString(), tier: "cheap" }),
  ];
  assert.ok(m.summarize(mk(20, 80)).verdict.startsWith("BUILD-SUPPORTIVE"));   // 20%
  assert.ok(m.summarize(mk(8, 92)).verdict.startsWith("INCONCLUSIVE"));        // 8%
  assert.ok(m.summarize(mk(3, 97)).verdict.startsWith("BUILD-NEGATIVE"));      // 3%
});

check("the cost projection reproduces the spec doc's shape", () => {
  const rows = Array(100).fill(null).map((_, i) => ({
    ts: new Date().toISOString(), tier: i < 20 ? "frontier" : "cheap",
    promptChars: 3328 * 4, replyChars: 121 * 4,   // the measured turn
  }));
  const s = m.summarize(rows, { users: [10000], turnsPerUserPerDay: 15 });
  const p = s.projections[0];
  assert.strictEqual(p.users, 10000);
  // At 20% escalation the premium must dominate: escalating costs far more than the base.
  assert.ok(p.escalationPremiumUsd > p.allCheapUsd,
    `premium ${p.escalationPremiumUsd} should exceed base ${p.allCheapUsd}`);
  assert.ok(s.costPerTurnUsd.frontierMultiple > 10,
    `frontier should cost >10x cheap, got ${s.costPerTurnUsd.frontierMultiple}`);
});

check("PRIVACY: message text cannot reach the log, and the session id is hashed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "escmeter-"));
  const row = m.record({
    provider: "openai", model: "gpt-4.1-mini", surface: "stock-trader",
    replyChars: 480, promptChars: 350, latencyMs: 900,
    sessionId: "session-abc-123",
    // A caller trying to push content through — the explicit field list must drop it.
    text: "I am long 400 SPY at 611.20", message: "my position is 400 SPY",
  }, tmp);
  assert.ok(row, "record should return the written row");
  const raw = fs.readFileSync(path.join(tmp, m.REL), "utf8");
  assert.ok(!raw.includes("SPY"), "position text must never be written");
  assert.ok(!raw.includes("611.20"), "prices must never be written");
  assert.ok(!raw.includes("session-abc-123"), "the raw session id must never be written");
  assert.ok(raw.includes("stock-trader"), "the surface label is fine to keep");
  assert.strictEqual(row.text, undefined);
  assert.strictEqual(row.message, undefined);
  assert.ok(row.session && row.session.length === 12, "session should be a short one-way hash");
  fs.rmSync(tmp, { recursive: true, force: true });
});

check("the same session hashes stably, so sessions can be counted without being stored", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "escmeter2-"));
  const a = m.record({ provider: "openai", model: "gpt-4.1-mini", sessionId: "s1" }, tmp);
  const b = m.record({ provider: "openai", model: "gpt-4.1-mini", sessionId: "s1" }, tmp);
  const c = m.record({ provider: "openai", model: "gpt-4.1-mini", sessionId: "s2" }, tmp);
  assert.strictEqual(a.session, b.session);
  assert.notStrictEqual(a.session, c.session);
  assert.strictEqual(m.summarize(m.readRows(tmp)).sessions, 2);
  fs.rmSync(tmp, { recursive: true, force: true });
});

check("metering never throws, whatever it is handed", () => {
  // Fail-open is the contract: a metering bug must not break a user's chat turn.
  assert.doesNotThrow(() => m.record({}, "/nonexistent/path/that/cannot/be/made\0bad"));
  assert.doesNotThrow(() => m.record(null, "/tmp"));
  assert.doesNotThrow(() => m.summarize(null));
  assert.doesNotThrow(() => m.summarize([null, {}, { tier: "bogus" }]));
  assert.deepStrictEqual(m.readRows("/nonexistent/path"), []);
});

check("a partially-written trailing line is skipped, not fatal", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "escmeter3-"));
  m.record({ provider: "openai", model: "gpt-4.1-mini" }, tmp);
  fs.appendFileSync(path.join(tmp, m.REL), '{"tier":"chea');   // torn write
  assert.strictEqual(m.readRows(tmp).length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

check("demand is reported separately from what actually served the turn", () => {
  const rows = [
    { ts: new Date().toISOString(), tier: "frontier", gateEscalate: true },   // agreed
    { ts: new Date().toISOString(), tier: "cheap", gateEscalate: false },     // agreed
    { ts: new Date().toISOString(), tier: "cheap", gateEscalate: true },      // wanted, didn't get
  ];
  const s = m.summarize(rows);
  assert.strictEqual(s.demand.observed, 3);
  assert.ok(Math.abs(s.demand.demandRatePct - 66.67) < 0.1);
  assert.ok(Math.abs(s.demand.agreedWithActualPct - 66.67) < 0.1);
});

check("a zero realized rate with real demand reports POLICY-BOUND, not BUILD-NEGATIVE", () => {
  // The trap worth failing loudly on: escalation switched off makes the realized rate 0 by
  // construction. Reading that as "nobody needs the big model" would kill the in-house model
  // on an artifact of our own routing config. This is exactly the shape of the historical
  // backfill (0/35 realized) that prompted the demand signal.
  const rows = Array(20).fill(null).map(() => ({
    ts: new Date().toISOString(), tier: "cheap", gateEscalate: true,
  }));
  const s = m.summarize(rows);
  assert.strictEqual(s.escalationRate, 0);
  assert.ok(s.verdict.startsWith("POLICY-BOUND"), `got: ${s.verdict}`);
  assert.ok(s.verdict.includes("100%"), "should surface the demand rate it deferred to");
});

check("a zero realized rate with NO demand is a genuine BUILD-NEGATIVE", () => {
  const rows = Array(20).fill(null).map(() => ({
    ts: new Date().toISOString(), tier: "cheap", gateEscalate: false,
  }));
  assert.ok(m.summarize(rows).verdict.startsWith("BUILD-NEGATIVE"));
});

check("per-surface breakdown separates the trader from general chat", () => {
  const rows = [
    { ts: new Date().toISOString(), tier: "frontier", surface: "stock-trader" },
    { ts: new Date().toISOString(), tier: "cheap", surface: "stock-trader" },
    { ts: new Date().toISOString(), tier: "cheap", surface: "dream-chat" },
  ];
  const s = m.summarize(rows);
  assert.strictEqual(s.bySurface["stock-trader"].turns, 2);
  assert.strictEqual(s.bySurface["stock-trader"].frontier, 1);
  assert.strictEqual(s.bySurface["dream-chat"].frontier, 0);
});

console.log(failures ? `\n${failures} FAILED` : "\nall chat-escalation-meter tests passed");
process.exit(failures ? 1 : 0);
