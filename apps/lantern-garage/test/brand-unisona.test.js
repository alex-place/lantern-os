// Brand guard (#2250): the user-visible brand is Unisona. "Keystone"/"Lantern" are code ids
// and file paths only, never visible copy. This lightweight check catches a stray brand word
// in a <title> (zero tolerance) or in visible body copy (outside <script>/<style>/comments).
// Run: node apps/lantern-garage/test/brand-unisona.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "..", "public");
const BRAND = /\b(Keystone|Lantern)\w*/g;

// Documented, legitimate exceptions for BODY copy (titles are still checked everywhere):
//  - knowledgecenter.html: "Keystone" doc titles were swept to unisona.ai in the 2026-07
//    rename, but cards still show real file paths/module names (LANTERN-*.md doc titles,
//    keystone-context.js) — paths are ids, not brand copy.
//  - three-doors-game.html has in-game CHARACTERS named "Lantern"/"Keystone" (hand-drawn
//    reference art + dialogue) — fiction, not the product brand.
const BODY_ALLOWLIST = new Set(["knowledgecenter.html"]);

const stripCode = (s) => s
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<!--[\s\S]*?-->/g, "");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const files = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));

check("no legacy brand in any <title> (zero tolerance)", () => {
  const offenders = [];
  for (const f of files) {
    const html = fs.readFileSync(path.join(PUBLIC, f), "utf8");
    const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
    if (BRAND.test(title)) offenders.push(`${f}: "${title.trim()}"`);
    BRAND.lastIndex = 0;
  }
  assert.strictEqual(offenders.length, 0, `legacy brand in <title>:\n   ${offenders.join("\n   ")}`);
});

check("no legacy brand in visible body copy (allowlisted exceptions aside)", () => {
  const offenders = [];
  for (const f of files) {
    if (BODY_ALLOWLIST.has(f)) continue;
    const vis = stripCode(fs.readFileSync(path.join(PUBLIC, f), "utf8"));
    const hits = vis.match(BRAND);
    BRAND.lastIndex = 0;
    if (hits && hits.length) offenders.push(`${f}: ${[...new Set(hits)].join(", ")}`);
  }
  assert.strictEqual(offenders.length, 0,
    `legacy brand in visible copy — sweep to Unisona (or add to BODY_ALLOWLIST with a reason):\n   ${offenders.join("\n   ")}`);
});

check("allowlist stays minimal (drift guard)", () => {
  // If an allowlisted file is cleaned up, drop it from BODY_ALLOWLIST so the guard tightens.
  for (const f of BODY_ALLOWLIST) {
    const p = path.join(PUBLIC, f);
    if (!fs.existsSync(p)) continue;
    const vis = stripCode(fs.readFileSync(p, "utf8"));
    BRAND.lastIndex = 0;
    assert.ok(BRAND.test(vis), `${f} is allowlisted but now brand-clean — remove it from BODY_ALLOWLIST`);
    BRAND.lastIndex = 0;
  }
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log(`\nBrand guard passed across ${files.length} surfaces (Unisona).`);
