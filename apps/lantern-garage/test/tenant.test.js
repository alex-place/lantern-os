// tenant.js (lib/tenant.js): the ONE multi-tenancy seam (ADR-0018, W2). Verifies the
// behaviour-preserving local default, the isolated cloud namespace, session-only key
// custody (W6), the anonymous-cloud gate (W3), and path-traversal safety.
// Run: node apps/lantern-garage/test/tenant.test.js
const assert = require("assert");
const path = require("path");
const {
  resolveTenant, tenantDataRoot, safeTenantSegment, LOCAL_TENANT_ID, DATA_ROOT,
} = require("../lib/tenant");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
// The seam reads process.env at call time, so tests just toggle it between calls.
function local() { delete process.env.LANTERN_TENANCY; }
function cloud() { process.env.LANTERN_TENANCY = "cloud"; }

check("local profile is the single owner, rooted at today's data/ tree (unchanged)", () => {
  local();
  const t = resolveTenant({});
  assert.strictEqual(t.profile, "local");
  assert.strictEqual(t.tenantId, LOCAL_TENANT_ID);
  assert.strictEqual(t.isAuthenticated, true);
  assert.strictEqual(t.dataRoot(), DATA_ROOT); // BEHAVIOUR-PRESERVING: identical path
});

check("local profile keys come from process.env (today's behaviour, incl. GEMINI||GOOGLE fallback)", () => {
  local();
  // Hermetic: snapshot the keys we touch so the test neither depends on nor prints
  // this machine's real provider keys, then restore them exactly.
  const KEYS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try {
    process.env.ANTHROPIC_API_KEY = "anth-local";
    process.env.GOOGLE_API_KEY = "goog-alt";
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY; // exercise the "absent -> null" path deterministically
    const t = resolveTenant({});
    assert.strictEqual(t.resolveKey("anthropic"), "anth-local");
    assert.strictEqual(t.resolveKey("gemini"), "goog-alt"); // GEMINI_API_KEY || GOOGLE_API_KEY
    assert.strictEqual(t.resolveKey("openai"), null);
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

check("cloud profile namespaces memory under data/tenants/<id>", () => {
  cloud();
  const t = resolveTenant({ session: { user: { id: "user_ABC123" } } });
  assert.strictEqual(t.profile, "cloud");
  assert.strictEqual(t.tenantId, "user_ABC123");
  assert.strictEqual(t.isAuthenticated, true);
  assert.strictEqual(t.dataRoot(), path.join(DATA_ROOT, "tenants", "user_ABC123"));
  local();
});

check("cloud profile does NOT leak host env keys to a tenant (W6: session-only BYO)", () => {
  cloud();
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "anth-host"; // a host key IS present in env...
    const withByo = resolveTenant({ session: { user: { id: "u1" }, tenantKeys: { anthropic: "byo-anth" } } });
    assert.strictEqual(withByo.resolveKey("anthropic"), "byo-anth"); // ...the user's own key wins
    const noByo = resolveTenant({ session: { user: { id: "u2" } } });
    assert.strictEqual(noByo.resolveKey("anthropic"), null); // ...and the host key is NOT leaked
  } finally {
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    local();
  }
});

check("cloud profile refuses a data root for an anonymous request (W3 gate)", () => {
  cloud();
  const t = resolveTenant({ session: {} });
  assert.strictEqual(t.isAuthenticated, false);
  assert.strictEqual(t.tenantId, null);
  assert.throws(() => t.dataRoot(), /tenant_unresolved/);
  local();
});

check("tenant id is path-traversal safe; hostile ids stay under data/tenants", () => {
  assert.strictEqual(safeTenantSegment("../../etc/passwd"), "etcpasswd");
  assert.strictEqual(safeTenantSegment("a/b\\c"), "abc");
  assert.strictEqual(safeTenantSegment(""), "");
  assert.strictEqual(safeTenantSegment(null), "");
  const root = tenantDataRoot("cloud", "..\\..\\escape");
  assert.ok(root.startsWith(path.join(DATA_ROOT, "tenants")), "stays under data/tenants: " + root);
});

if (failures) { console.error(`\n${failures} tenant seam test(s) failed`); process.exit(1); }
console.log("\nAll tenant seam tests passed.");
