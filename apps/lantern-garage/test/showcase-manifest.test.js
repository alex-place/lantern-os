// Regression: the Kingdome of Hearts / Three Doors gallery manifest is the ONLY
// thing tracked in git for that gallery (the .webp bytes live in R2). If it drifts
// — bad category, missing key, broken base — the Explore panel renders empty or
// 404s. This validates the manifest's shape and invariants without a server.
//
// Run: node apps/lantern-garage/test/showcase-manifest.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let failures = 0;
const check = (name, fn) => {
  try { fn(); process.stdout.write("  ok  - " + name + "\n"); }
  catch (e) { failures++; process.stderr.write("  FAIL- " + name + "\n      " + e.message + "\n"); }
};

const MANIFEST = path.resolve(
  __dirname, "../public/assets/content/koh/manifest.json");

if (!fs.existsSync(MANIFEST)) {
  process.stdout.write("SKIP showcase-manifest: manifest not present\n");
  process.exit(0);
}
const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const items = m.items || [];
const CATS = new Set(["door", "hero", "world"]);

check("has title, base, and an items array", () => {
  assert.ok(typeof m.title === "string" && m.title.length);
  assert.ok(typeof m.base === "string" && m.base.length, "base must be set");
  assert.ok(Array.isArray(items) && items.length > 0);
});
check("base is local-relative OR an absolute https URL (R2), ending in '/'", () => {
  assert.ok(m.base.endsWith("/"), "base should end with '/': " + m.base);
  assert.ok(
    m.base.startsWith("/") || /^https:\/\//.test(m.base),
    "base must be a local path or https URL: " + m.base);
});
check("count field matches items length (if present)", () => {
  if (typeof m.count === "number") assert.strictEqual(m.count, items.length);
});
check("every item has id + relative thumb/full keys (no leading slash)", () => {
  for (const it of items) {
    assert.ok(it.id, "missing id");
    for (const k of ["thumb", "full"]) {
      assert.ok(it[k], it.id + " missing " + k);
      assert.ok(!it[k].startsWith("/") && !/^https?:/.test(it[k]),
        it.id + "." + k + " must be a bare key (base is prefixed at render): " + it[k]);
      assert.ok(it[k].endsWith(".webp"), it.id + "." + k + " should be .webp");
    }
  }
});
check("thumb/full keys are unique (no collisions)", () => {
  const seen = new Set();
  for (const it of items) {
    assert.ok(!seen.has(it.full), "duplicate key: " + it.full);
    seen.add(it.full);
  }
});
check("status is 'auto' or 'review'", () => {
  for (const it of items) assert.ok(["auto", "review"].includes(it.status), it.id + " bad status " + it.status);
});
check("auto items: valid category (door|hero|world) + non-empty title", () => {
  for (const it of items.filter((x) => x.status === "auto")) {
    assert.ok(CATS.has(it.cat), it.id + " auto item has bad cat: " + it.cat);
    assert.ok(typeof it.title === "string" && it.title.trim().length, it.id + " auto item needs a title");
  }
});
check("review items: no category, no title (left for human)", () => {
  for (const it of items.filter((x) => x.status === "review")) {
    assert.ok(!it.cat, it.id + " review item should have no cat");
    assert.ok(it.title == null, it.id + " review item should have no title");
  }
});
check("at least one item in each visible section so the panel isn't empty", () => {
  for (const cat of CATS) {
    assert.ok(items.some((it) => it.status === "auto" && it.cat === cat),
      "no items in section: " + cat);
  }
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write(`\nshowcase-manifest: all passed (${items.length} items)\n`);
