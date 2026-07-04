// #1197 — verify-gated local-first escalation.
// The orchestrator is pure/injectable, so we exercise the escalation policy without
// the live kernel or a GPU: a weak local result that "returns something" but isn't
// VERIFIED must escalate to the cloud teacher under requireVerified, and the run must
// report landedBy (local|cloud) for the parity metric.
//
// Run: node apps/lantern-garage/test/keystone-escalation.test.js
const assert = require("assert");
const { runKernelWithEscalation, landedByOf } = require("../lib/keystone-escalation");

let failures = 0;
function check(name, fn) {
  return fn().then(
    () => console.error("  ok  -", name),
    (e) => { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
  );
}

const CHAIN = [
  { provider: "ollama", model: "ouro:latest" },
  { provider: "anthropic", model: "claude-opus-4-8" },
];

// runOne stub: returns the scripted result for each provider in order.
const runner = (byIndex) => async (_p, _m, i) => byIndex[i];

(async () => {
  await check("verified local win → no escalation, landedBy=local", async () => {
    const r = await runKernelWithEscalation({
      providers: CHAIN, requireVerified: true,
      runOne: runner([{ status: "success", tests: { success: true } }]),
    });
    assert.equal(r.landedBy, "local");
    assert.equal(r.verified, true);
    assert.equal(r.escalations.length, 0);
    assert.equal(r.providerUsed.provider, "ollama");
  });

  await check("unverified local (applied, tests fail) → escalates to cloud", async () => {
    const r = await runKernelWithEscalation({
      providers: CHAIN, requireVerified: true,
      runOne: runner([
        { status: "applied_unverified", tests: { success: false, output: "1 failed" } },
        { status: "success", tests: { success: true } },
      ]),
    });
    assert.equal(r.escalations.length, 1, "should escalate once off local");
    assert.equal(r.landedBy, "cloud");
    assert.equal(r.verified, true);
    assert.equal(r.providerUsed.provider, "anthropic");
  });

  await check("legacy (requireVerified=false): applied_unverified counts as landed", async () => {
    const r = await runKernelWithEscalation({
      providers: CHAIN, requireVerified: false,
      runOne: runner([{ status: "applied_unverified", tests: { success: false } }]),
    });
    assert.equal(r.escalations.length, 0, "legacy mode must not escalate (fleet behavior)");
    assert.equal(r.landedBy, "local");
    assert.equal(r.verified, false);
  });

  await check("no tests available → unverified accepted (don't loop forever)", async () => {
    const r = await runKernelWithEscalation({
      providers: CHAIN, requireVerified: true,
      runOne: runner([{ status: "applied_unverified" }]),  // no result.tests
    });
    assert.equal(r.escalations.length, 0);
    assert.equal(r.landedBy, "local");
    assert.equal(r.verified, false, "accepted but flagged unverified");
  });

  await check("local fails outright → cloud verified lands it", async () => {
    const r = await runKernelWithEscalation({
      providers: CHAIN, requireVerified: true,
      runOne: runner([
        { status: "failed", error: "patch did not apply" },
        { status: "success", tests: { success: true } },
      ]),
    });
    assert.equal(r.landedBy, "cloud");
    assert.equal(r.escalations.length, 1);
  });

  await check("chain exhausted, nobody verified → landedBy null", async () => {
    const r = await runKernelWithEscalation({
      providers: CHAIN, requireVerified: true,
      runOne: runner([
        { status: "failed" },
        { status: "applied_unverified", tests: { success: false } },
      ]),
    });
    assert.equal(r.landedBy, null);
    assert.equal(r.verified, false);
    assert.equal(r.providerUsed, null);
  });

  // ── #1937 step 3 (ADR-0012 door-2): a canary/verdict instability signal escalates ──
  await check("door-2: applied reply with a collapse routing hint → escalates (not lands)", async () => {
    const r = await runKernelWithEscalation({
      providers: CHAIN, requireVerified: false,
      runOne: runner([
        { status: "success", routeHint: { escalate: true, reason: "collapse" } }, // confidently-wrong local
        { status: "success", tests: { success: true } },
      ]),
    });
    assert.equal(r.escalations.length, 1, "a flagged reply must escalate, not silently land");
    assert.equal(r.landedBy, "cloud");
    assert.equal(r.escalations[0].failedProvider, "ollama");
  });

  await check("door-2: an ungrounded ReasonVerdict on an applied reply → escalates", async () => {
    const r = await runKernelWithEscalation({
      providers: CHAIN, requireVerified: false,
      runOne: runner([
        { status: "applied_unverified", verdict: { reason: "ungrounded" } },
        { status: "success", tests: { success: true } },
      ]),
    });
    assert.equal(r.escalations.length, 1);
    assert.equal(r.landedBy, "cloud");
  });

  await check("door-2: a TEST-VERIFIED result still lands despite an escalate hint", async () => {
    const r = await runKernelWithEscalation({
      providers: CHAIN, requireVerified: true,
      runOne: runner([{ status: "success", tests: { success: true }, routeHint: { escalate: true, reason: "ungrounded" } }]),
    });
    assert.equal(r.escalations.length, 0, "verification wins — a proven-correct result isn't second-guessed");
    assert.equal(r.landedBy, "local");
    assert.equal(r.verified, true);
  });

  await check("door-2: no hint/verdict → behaviour unchanged (plain success lands)", async () => {
    const r = await runKernelWithEscalation({
      providers: CHAIN, requireVerified: false,
      runOne: runner([{ status: "success" }]),
    });
    assert.equal(r.escalations.length, 0);
    assert.equal(r.landedBy, "local");
  });

  await check("landedByOf: ollama=local, anthropic/openai=cloud, null=null", async () => {
    assert.equal(landedByOf({ provider: "ollama" }), "local");
    assert.equal(landedByOf({ provider: "anthropic" }), "cloud");
    assert.equal(landedByOf({ provider: "openai" }), "cloud");
    assert.equal(landedByOf(null), null);
  });

  console.error(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
