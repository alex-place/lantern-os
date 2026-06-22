/**
 * Chat grounding — gate + calibration wiring tests
 *
 * Proves the contract of the "turn on chat grounding" change:
 *   1. isVerifyEnabled() precedence: SIGMA0_VERIFY env override beats the flag;
 *      with no override the chat_grounding admin flag defaults ON.
 *   2. calibrationEventsFor() maps verify-pass records → grounding events:
 *      only externally-grounded claims carry ground truth; outcome = refuted?0:1.
 *   3. recordGrounding()/summarize() round-trip: events fold into a Brier score.
 *
 * Hermetic — no network, no server, no real flag-store writes (feature-flags is
 * stubbed via require.cache; calibration writes to a temp dir).
 *
 * Run: node tests/test_chat_grounding.js   (or: node --test tests/test_chat_grounding.js)
 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ffPath = require.resolve("../apps/lantern-garage/lib/feature-flags");
// Stub feature-flags.isFlagEnabledOr so the default-on path is independent of the
// real data/admin/feature-flags.json (and never writes to it).
function stubFlag(returnValue) {
  require.cache[ffPath] = {
    id: ffPath, filename: ffPath, loaded: true, children: [], exports: {
      // returnValue === "fallback" → behave like an absent flag (returns the caller's default)
      isFlagEnabledOr: (key, fallback) => (returnValue === "fallback" ? fallback : returnValue),
    },
  };
}
function clearFlagStub() { delete require.cache[ffPath]; }

const { isVerifyEnabled, calibrationEventsFor } = require("../apps/lantern-garage/lib/dream-chat");
const gc = require("../apps/lantern-garage/lib/grounding-calibration");

const ORIG_ENV = process.env.SIGMA0_VERIFY;
function setEnv(v) { if (v === undefined) delete process.env.SIGMA0_VERIFY; else process.env.SIGMA0_VERIFY = v; }
function restoreEnv() { setEnv(ORIG_ENV); clearFlagStub(); }

test("isVerifyEnabled: defaults ON when no env override and flag absent", () => {
  setEnv(undefined);
  stubFlag("fallback"); // absent flag → returns the caller's fallback (true)
  assert.equal(isVerifyEnabled(), true);
  restoreEnv();
});

test("isVerifyEnabled: admin can disable via the chat_grounding flag", () => {
  setEnv(undefined);
  stubFlag(false); // flag exists and is disabled
  assert.equal(isVerifyEnabled(), false);
  restoreEnv();
});

test("isVerifyEnabled: SIGMA0_VERIFY=false kills it even if the flag is ON", () => {
  setEnv("false");
  stubFlag(true);
  assert.equal(isVerifyEnabled(), false);
  restoreEnv();
});

test("isVerifyEnabled: SIGMA0_VERIFY=true forces it ON even if the flag is OFF", () => {
  setEnv("true");
  stubFlag(false);
  assert.equal(isVerifyEnabled(), true);
  restoreEnv();
});

test("calibrationEventsFor: skips ungrounded claims, maps outcome from refuted", () => {
  const records = [
    { claim: "a", source: "codebase-grep", confidence: 0.85, refuted: false },
    { claim: "b", source: "gemini-grounding", confidence: 0.35, refuted: true },
    { claim: "c", source: "none", confidence: 0.6, refuted: false },        // skipped (no signal)
    { claim: "d", source: "web-search", confidence: 0.75, refuted: false },
  ];
  const events = calibrationEventsFor(records, "keystone");
  assert.equal(events.length, 3, "the source:'none' claim must be skipped");
  assert.deepEqual(events.map((e) => e.key), ["agent:keystone", "agent:keystone", "agent:keystone"]);
  assert.deepEqual(events.map((e) => e.outcome), [1, 0, 1], "refuted → 0, confirmed → 1");
  assert.deepEqual(events.map((e) => e.predicted), [0.85, 0.35, 0.75]);
});

test("calibrationEventsFor: unknown agent falls back to agent:lantern; empty input is safe", () => {
  const e = calibrationEventsFor([{ source: "web-search", confidence: 0.7, refuted: false }], undefined);
  assert.equal(e[0].key, "agent:lantern");
  assert.deepEqual(calibrationEventsFor(null, "x"), []);
  assert.deepEqual(calibrationEventsFor(undefined, "x"), []);
});

test("recordGrounding/summarize: events fold into a Brier score (temp dir, deterministic ts)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-grounding-"));
  try {
    gc.recordGrounding({ key: "agent:keystone", predicted: 0.9, outcome: 1, ts: "2026-01-01T00:00:00Z", source: "web" }, root);
    gc.recordGrounding({ key: "agent:keystone", predicted: 0.2, outcome: 0, ts: "2026-01-01T00:00:01Z", source: "web" }, root);

    const summary = gc.summarize(gc.readEvents(root));
    assert.equal(summary.total_events, 2);
    assert.equal(summary.keys["agent:keystone"].n, 2);
    // brier = mean( (0.9-1)^2 , (0.2-0)^2 ) = mean(0.01, 0.04) = 0.025
    assert.ok(Math.abs(summary.global_brier - 0.025) < 1e-9, `brier ${summary.global_brier} != 0.025`);
    // trust = Beta posterior mean = (1+hits)/(2+n) = (1+1)/(2+2) = 0.5
    assert.ok(Math.abs(summary.keys["agent:keystone"].trust - 0.5) < 1e-9);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
