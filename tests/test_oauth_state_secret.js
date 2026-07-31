/**
 * #3098 / #2619 — every OAuth state cookie must be signed with the fail-closed
 * session secret, never a hardcoded literal.
 *
 * routes/indeed.js used `process.env.SESSION_SECRET || "lantern-indeed-oauth-secret"`.
 * That fallback is a constant committed to this repo, so on any deploy without
 * SESSION_SECRET the state cookie was signed with a key an attacker can simply read
 * here — making the state forgeable, which is the one thing signing it prevents.
 * lib/oauth-core.js already carried the #2619 fix; this route did not.
 *
 * The regression is cheap to reintroduce (the `||` fallback reads as defensive), so
 * this pins it by source: no auth-adjacent module may carry a literal fallback secret.
 *
 * Run: node tests/test_oauth_state_secret.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const APP = path.join(__dirname, "..", "apps", "lantern-garage");

let passed = 0;
const ok = (n) => { passed++; console.log("  ✓ " + n); };

// Files that sign or verify something with a server secret.
const SIGNING_MODULES = [
  "routes/indeed.js",
  "lib/oauth-core.js",
  "lib/auth-tokens.js",
  "lib/referrals.js",
];

function main() {
  // ── 1. No literal fallback secret in any signing module ────────────────────────
  // Matches `SESSION_SECRET || "…"` and friends: an env read OR'd with a string.
  const FALLBACK = /process\.env\.[A-Z_]*SECRET[A-Z_]*\s*\|\|\s*["'`]/;
  for (const rel of SIGNING_MODULES) {
    const src = fs.readFileSync(path.join(APP, rel), "utf8");
    // Strip comments so the explanatory note about the OLD code doesn't self-trip.
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!FALLBACK.test(code),
      `${rel}: a hardcoded fallback signing secret is a forgeable-state bug (#2619)`);
  }
  ok(`no literal fallback secret in ${SIGNING_MODULES.length} signing modules`);

  // ── 2. indeed.js specifically resolves through the fail-closed helper ──────────
  const indeed = fs.readFileSync(path.join(APP, "routes/indeed.js"), "utf8");
  assert.ok(/require\(["'].*session-secret["']\)/.test(indeed),
    "routes/indeed.js must import the shared secret resolver");
  assert.ok(/function _secret\(\)\s*\{\s*return resolveSessionSecret\(\)/.test(indeed),
    "routes/indeed.js _secret() must delegate to resolveSessionSecret()");
  assert.ok(!/lantern-indeed-oauth-secret/.test(indeed.replace(/\/\/.*$/gm, "")),
    "the old literal must not survive outside a comment");
  ok("routes/indeed.js signs with resolveSessionSecret(), not a literal");

  // ── 3. The resolver is genuinely fail-closed beyond loopback ──────────────────
  // This is what makes removing the fallback safe rather than merely tidier: without
  // a real secret the process refuses instead of quietly signing with a known key.
  const { resolveSessionSecret } = require(path.join(APP, "lib", "session-secret"));
  assert.throws(
    () => resolveSessionSecret({ PORT: "8080" }),
    /SESSION_SECRET is required/,
    "beyond loopback (PORT set) a missing secret must throw, not fall back");
  assert.throws(
    () => resolveSessionSecret({ NODE_ENV: "production" }),
    /SESSION_SECRET is required/,
    "in production a missing secret must throw, not fall back");
  const local = resolveSessionSecret({});
  assert.ok(typeof local === "string" && local.length > 0,
    "loopback dev still resolves a usable secret");
  ok("resolveSessionSecret fails closed beyond loopback, works on loopback");

  console.log(`\nAll ${passed} oauth-state-secret assertions passed.`);
}

try {
  main();
} catch (err) {
  console.error("\n[FAIL]", (err && err.stack) || err);
  process.exitCode = 1;
}
