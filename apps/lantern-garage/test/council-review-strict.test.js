// COUNCIL_STRICT_GROUNDING (lib/council-review.js): agreement is not grounding.
//
// Default behaviour must not change: an uncontested reply with no anchor and no execution check
// is still "grounded" by low_delta. Under the strict flag, the same reply is grounded only if it
// asserts nothing; a reply that makes claims backed by nothing but the faces agreeing gets the
// honest unverified verdict (seam_open when an external check is reachable, pin when not).
// Execution checks and anchors still ground. Every review records agreementOnly so the flag's
// effect can be measured on the live ledger before it is turned on.
//
// Run: node apps/lantern-garage/test/council-review-strict.test.js
const assert = require("assert");
const { councilReview, STRICT_ASSERT_MIN_DEFAULT, strictGroundingEnabled } = require("../lib/council-review");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// Four sentences, one with a number: assertiveness 0.25, risk 0.25 (< 0.5, so uncontested).
const CLAIMS =
  "The deployment finished without errors and the service is responding normally. " +
  "Every health check passed during the last window. The queue drained completely after the " +
  "restart. The cache was rebuilt from scratch in 42 seconds.";
// Asserts nothing specific (no numbers, no named things): assertiveness 0.
const PLAIN =
  "The convergence loop observes the world, then reasons about what to do next and acts. " +
  "Each stage strengthens the one before it, and nothing is accepted without checking it " +
  "against something real first.";

const savedEnv = { strict: process.env.COUNCIL_STRICT_GROUNDING, min: process.env.COUNCIL_STRICT_ASSERT_MIN };
delete process.env.COUNCIL_STRICT_GROUNDING;
delete process.env.COUNCIL_STRICT_ASSERT_MIN;

check("fixture: CLAIMS is uncontested, unanchored and asserts above the default minimum", () => {
  const r = councilReview(CLAIMS, { emit: false });
  assert.ok(r.delta < 0.5, `delta=${r.delta}`);
  assert.strictEqual(r.anchored, false);
  assert.ok(r.assertiveness >= STRICT_ASSERT_MIN_DEFAULT, `assertiveness=${r.assertiveness}`);
});

check("default (flag unset): agreement alone still grounds, exactly as before", () => {
  assert.strictEqual(strictGroundingEnabled({}), false);
  const r = councilReview(CLAIMS, { emit: false });
  assert.strictEqual(r.verdict, "grounded");
  assert.strictEqual(r.groundedBy, "low_delta");
  assert.strictEqual(r.recommend, "answer");
  assert.strictEqual(r.agreementOnly, true, "the review still says nothing but agreement stood behind it");
  assert.strictEqual(r.strictGrounding, false);
});

check("strict: a reply that makes claims backed only by agreement is unverified (seam_open)", () => {
  const r = councilReview(CLAIMS, { emit: false, strictGrounding: true });
  assert.strictEqual(r.verdict, "seam_open");
  assert.strictEqual(r.recommend, "escalate");
  assert.strictEqual(r.groundedBy, "none");
  assert.strictEqual(r.agreementOnly, true);
  assert.strictEqual(r.strictGrounding, true);
});

check("strict + nothing external reachable: pin, not an escalation to someone who can't check either", () => {
  const r = councilReview(CLAIMS, { emit: false, strictGrounding: true, reachable: false });
  assert.strictEqual(r.verdict, "pin");
  assert.strictEqual(r.recommend, "name_unknown");
  assert.strictEqual(r.escalated, false);
});

check("strict: a reply that asserts nothing is still grounded (no badge noise on plain talk)", () => {
  const r = councilReview(PLAIN, { emit: false, strictGrounding: true });
  assert.strictEqual(r.verdict, "grounded");
  assert.strictEqual(r.groundedBy, "low_delta");
});

check("strict: a too-short reply is still grounded", () => {
  const r = councilReview("Sounds good to me.", { emit: false, strictGrounding: true });
  assert.strictEqual(r.verdict, "grounded");
});

check("strict: an anchored reply still grounds by anchor", () => {
  const r = councilReview(CLAIMS, {
    emit: false, strictGrounding: true,
    groundingContext: "Deploy log: deployment finished without errors; every health check passed; " +
      "queue drained after the restart; cache rebuilt from scratch in 42 seconds.",
  });
  assert.strictEqual(r.anchored, true);
  assert.strictEqual(r.verdict, "grounded");
  assert.strictEqual(r.groundedBy, "anchor");
  assert.strictEqual(r.agreementOnly, false);
});

check("strict: a passing execution check still grounds (execution overrides text)", () => {
  const r = councilReview(CLAIMS, { emit: false, strictGrounding: true, execVerdict: { ran: true, passed: true } });
  assert.strictEqual(r.verdict, "grounded");
  assert.strictEqual(r.groundedBy, "execution");
  assert.strictEqual(r.agreementOnly, false);
});

check("strict: a contested reply is unchanged (seam_open via disagreement)", () => {
  const r = councilReview(CLAIMS, { emit: false, strictGrounding: true, dissent: ["a", "b", "c"] });
  assert.strictEqual(r.verdict, "seam_open");
  assert.strictEqual(r.agreementOnly, false);
});

check("strict: the assertiveness minimum is configurable (raised above the reply's, it grounds again)", () => {
  const r = councilReview(CLAIMS, { emit: false, strictGrounding: true, strictAssertMin: 0.3 });
  assert.strictEqual(r.verdict, "grounded");
});

check("env: COUNCIL_STRICT_GROUNDING=1 turns strict mode on; opts.strictGrounding=false wins over it", () => {
  process.env.COUNCIL_STRICT_GROUNDING = "1";
  try {
    assert.strictEqual(councilReview(CLAIMS, { emit: false }).verdict, "seam_open");
    assert.strictEqual(councilReview(CLAIMS, { emit: false, strictGrounding: false }).verdict, "grounded");
    process.env.COUNCIL_STRICT_ASSERT_MIN = "0.3";
    assert.strictEqual(councilReview(CLAIMS, { emit: false }).verdict, "grounded", "env minimum respected");
    process.env.COUNCIL_STRICT_ASSERT_MIN = "";
    assert.strictEqual(councilReview(CLAIMS, { emit: false }).verdict, "seam_open", "empty env minimum falls back to the default");
  } finally {
    delete process.env.COUNCIL_STRICT_GROUNDING;
    delete process.env.COUNCIL_STRICT_ASSERT_MIN;
  }
});

if (savedEnv.strict !== undefined) process.env.COUNCIL_STRICT_GROUNDING = savedEnv.strict;
if (savedEnv.min !== undefined) process.env.COUNCIL_STRICT_ASSERT_MIN = savedEnv.min;

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall strict-grounding checks passed\n");
