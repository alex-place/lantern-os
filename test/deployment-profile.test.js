// deployment-profile.js (lib/deployment-profile.js): the hosted-subset gate (ADR-0018,
// W4/W5). Verifies local serves everything (no regression) and cloud serves only the
// chat/explore/help + account/landing subset.
// Run: node test/deployment-profile.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { profile, isCloud, isSurfaceAllowed, HOSTED_SURFACES } = require("../lib/deployment-profile");
const reg = require("../lib/surface-registry");
const PUBLIC = path.resolve(__dirname, "../public");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
function local() { delete process.env.LANTERN_TENANCY; }
function cloud() { process.env.LANTERN_TENANCY = "cloud"; }

const HOSTED = ["index.html", "dream-chat.html", "explore.html", "faq.html"];
const LOCAL_ONLY = ["kalshi-terminal.html", "trading.html", "work.html", "admin-flags.html",
  "create.html", "orchestration.html", "knowledgecenter.html"];

check("local profile is the default and serves EVERY surface (no regression)", () => {
  local();
  assert.strictEqual(profile(), "local");
  assert.strictEqual(isCloud(), false);
  for (const s of [...HOSTED, ...LOCAL_ONLY]) {
    assert.strictEqual(isSurfaceAllowed(s), true, `local should serve ${s}`);
  }
});

check("cloud profile serves the hosted subset (chat / explore / help / shell)", () => {
  cloud();
  assert.strictEqual(profile(), "cloud");
  assert.strictEqual(isCloud(), true);
  for (const s of HOSTED) assert.strictEqual(isSurfaceAllowed(s), true, `cloud should serve ${s}`);
  local();
});

check("cloud profile BLOCKS every local-only surface", () => {
  cloud();
  for (const s of LOCAL_ONLY) assert.strictEqual(isSurfaceAllowed(s), false, `cloud must block ${s}`);
  local();
});

check("hosted subset is chat + explore + help + a minimal account/landing shell", () => {
  // Guard against silent subset creep: the product surfaces + the login/landing shell.
  for (const s of ["dream-chat.html", "explore.html", "faq.html"]) {
    assert.ok(HOSTED_SURFACES.has(s), `${s} must be hosted`);
  }
  // Local-only clusters must NOT leak into the hosted subset.
  for (const s of LOCAL_ONLY) assert.ok(!HOSTED_SURFACES.has(s), `${s} must stay local-only`);
});

check("hosted subset is HONEST — every hosted surface exists on disk and is classified", () => {
  // The drift-killer: the two surface lists (deployment-profile HOSTED_SURFACES and the
  // surface-registry) must stay reconciled. A hosted entry pointing at a missing or
  // unclassified file (e.g. the former dangling "help.html") fails here instead of shipping.
  const onDisk = new Set(fs.readdirSync(PUBLIC).filter((f) => f.toLowerCase().endsWith(".html")));
  for (const s of HOSTED_SURFACES) {
    assert.ok(onDisk.has(s), `hosted surface "${s}" does not exist in public/ (dangling entry)`);
    assert.ok(reg.classify(s) !== null, `hosted surface "${s}" is not classified in lib/surface-registry.js`);
  }
});

if (failures) { console.error(`\n${failures} deployment-profile test(s) failed`); process.exit(1); }
console.log("\nAll deployment-profile tests passed.");
