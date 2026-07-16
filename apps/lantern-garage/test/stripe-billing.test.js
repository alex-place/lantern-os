// Stripe billing PURE-core tests — the money-mapping decisions that gate access.
// No SDK, no network: exercises the price→role, status→access, dual-source MAX, and
// idempotency logic that lib/stripe-billing.js owns. The load-bearing invariant is
// that a PURCHASE CAN NEVER MINT ADMIN — mirrored from the Patreon tier tests.
//
// Run: node apps/lantern-garage/test/stripe-billing.test.js
const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

let failures = 0;
function check(name, fn) {
  try { fn(); console.error("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// Load fresh so env-driven price ids are read after we set them.
delete require.cache[require.resolve("../lib/stripe-billing")];
const B = require("../lib/stripe-billing");

// ── tierToRole: the UI keyword → role ────────────────────────────────────────
check("tierToRole maps the three buyable tiers (case-insensitive)", () => {
  assert.equal(B.tierToRole("member"), "supporter");
  assert.equal(B.tierToRole("Pro"), "deep_dreamer");
  assert.equal(B.tierToRole("PILOT"), "pilot");
  assert.equal(B.tierToRole("supporter"), "supporter");   // role names accepted too
  assert.equal(B.tierToRole("admin"), null);              // never a buyable keyword
  assert.equal(B.tierToRole("nonsense"), null);
  assert.equal(B.tierToRole(""), null);
});

// ── roleForPrice: 3-tier resolution + whitelist ──────────────────────────────
check("roleForPrice: exact env price-id match wins", () => {
  process.env.STRIPE_PRICE_PILOT = "price_pilot_live";
  assert.equal(B.roleForPrice({ id: "price_pilot_live", currency: "usd", unit_amount: 20000 }), "pilot");
  delete process.env.STRIPE_PRICE_PILOT;
});
check("roleForPrice: metadata.role honored ONLY when whitelisted (admin typo can't elevate)", () => {
  assert.equal(B.roleForPrice({ id: "p1", metadata: { role: "deep_dreamer" } }), "deep_dreamer");
  assert.equal(B.roleForPrice({ id: "p2", metadata: { role: "admin" } }), null);        // NOT admin
  assert.equal(B.roleForPrice({ id: "p3", metadata: { role: "founder" } }), null);      // NOT a paid tier
});
check("roleForPrice: USD unit_amount fallback thresholds", () => {
  assert.equal(B.roleForPrice({ id: "x", currency: "usd", unit_amount: 500 }), "supporter");
  assert.equal(B.roleForPrice({ id: "x", currency: "usd", unit_amount: 1999 }), "supporter");
  assert.equal(B.roleForPrice({ id: "x", currency: "usd", unit_amount: 2000 }), "deep_dreamer");
  assert.equal(B.roleForPrice({ id: "x", currency: "usd", unit_amount: 20000 }), "pilot");
  assert.equal(B.roleForPrice({ id: "x", currency: "usd", unit_amount: 100000 }), "pilot"); // $1000 → still pilot, not admin
});
check("roleForPrice: FAIL CLOSED on sub-floor, non-USD, or missing price", () => {
  assert.equal(B.roleForPrice({ id: "x", currency: "usd", unit_amount: 499 }), null); // below $5
  assert.equal(B.roleForPrice({ id: "x", currency: "eur", unit_amount: 20000 }), null); // €200 ≠ $200
  assert.equal(B.roleForPrice(null), null);
  assert.equal(B.roleForPrice({ id: "x" }), null);
});

// ── accessForStatus: grant / keep / revoke ───────────────────────────────────
check("accessForStatus: active/trialing grant", () => {
  assert.equal(B.accessForStatus("active"), "grant");
  assert.equal(B.accessForStatus("trialing"), "grant");
});
check("accessForStatus: dunning states KEEP (don't strip mid-retry)", () => {
  assert.equal(B.accessForStatus("past_due"), "keep");
  assert.equal(B.accessForStatus("incomplete"), "keep");
  assert.equal(B.accessForStatus("weird_unknown"), "keep"); // fail-closed against over-revoke
});
check("accessForStatus: terminal states REVOKE", () => {
  for (const s of ["canceled", "unpaid", "incomplete_expired", "paused"]) {
    assert.equal(B.accessForStatus(s), "revoke", s);
  }
});

// ── effectiveRole: dual-source MAX with stripe whitelist ─────────────────────
check("effectiveRole = MAX(patreon, stripe)", () => {
  assert.equal(B.effectiveRole("supporter", "pilot"), "pilot");     // stripe higher
  assert.equal(B.effectiveRole("pilot", "supporter"), "pilot");     // patreon higher
  assert.equal(B.effectiveRole("deep_dreamer", null), "deep_dreamer"); // no stripe
  assert.equal(B.effectiveRole(null, "supporter"), "supporter");    // stripe only
  assert.equal(B.effectiveRole(null, null), "guest");
});
check("effectiveRole clamps a non-whitelisted stripeRole to guest (no buy-admin, ever)", () => {
  assert.equal(B.effectiveRole("supporter", "admin"), "supporter"); // admin snapshot ignored
  assert.equal(B.effectiveRole(null, "admin"), "guest");
  assert.equal(B.effectiveRole(null, "founder"), "guest");
});

// ── idempotency ledger ───────────────────────────────────────────────────────
check("markProcessed / alreadyProcessed dedupe by event id", () => {
  const led = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "billing-")), "processed.jsonl");
  assert.equal(B.alreadyProcessed("evt_1", led), false);
  B.markProcessed("evt_1", "checkout.session.completed", led);
  assert.equal(B.alreadyProcessed("evt_1", led), true);
  assert.equal(B.alreadyProcessed("evt_2", led), false);
});

check("isLiveKey: live iff sk_/rk_live (trimmed); test/empty/garbage → false", () => {
  assert.equal(B.isLiveKey("sk_live_abc"), true);
  assert.equal(B.isLiveKey("rk_live_abc"), true);           // restricted live key still live-mode
  assert.equal(B.isLiveKey("  sk_live_abc  "), true);       // stray whitespace can't misclassify
  assert.equal(B.isLiveKey("sk_test_abc"), false);
  assert.equal(B.isLiveKey("rk_test_abc"), false);
  assert.equal(B.isLiveKey(""), false);
  assert.equal(B.isLiveKey(undefined), false);
  assert.equal(B.isLiveKey("pk_live_abc"), false);          // publishable key is not a secret key
});

check("isConfigured reflects STRIPE_SECRET_KEY", () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(B.isConfigured(), false);
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  assert.equal(B.isConfigured(), true);
  if (prev === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prev;
});

console.error(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
