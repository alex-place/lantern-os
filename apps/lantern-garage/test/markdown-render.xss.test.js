// Red-team regression: the server-side markdown renderer must never emit a
// live script sink from an attacker-authored link/image. Markdown here is
// rendered from repo .md/.txt files that automation, research-intake, and
// harvest pipelines write — so a malicious doc viewed by an admin is a
// stored-XSS path. escapeHtml alone does NOT neutralize a dangerous scheme.
//
// Run: node apps/lantern-garage/test/markdown-render.xss.test.js
const assert = require("assert");
const { inlineMarkdown, safeUrl } = require("../lib/markdown-render");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// --- safeUrl unit checks ---------------------------------------------------
check("blocks javascript: scheme", () =>
  assert.strictEqual(safeUrl("javascript:alert(1)"), "#"));
check("blocks JaVaScRiPt: (case-insensitive)", () =>
  assert.strictEqual(safeUrl("JaVaScRiPt:alert(1)"), "#"));
check("blocks scheme smuggled with a tab (java\\tscript:)", () =>
  assert.strictEqual(safeUrl("java\tscript:alert(1)"), "#"));
check("blocks scheme smuggled with a newline", () =>
  assert.strictEqual(safeUrl("\njavascript:alert(1)"), "#"));
check("blocks vbscript: scheme", () =>
  assert.strictEqual(safeUrl("vbscript:msgbox(1)"), "#"));
check("blocks data:text/html", () =>
  assert.strictEqual(safeUrl("data:text/html,<script>alert(1)</script>"), "#"));
check("blocks data:image/svg+xml (can carry script)", () =>
  assert.strictEqual(safeUrl("data:image/svg+xml;base64,PHN2Zz4=", { allowData: true }), "#"));
check("allows http(s)", () => {
  assert.strictEqual(safeUrl("https://example.com/x"), "https://example.com/x");
  assert.strictEqual(safeUrl("http://example.com"), "http://example.com");
});
check("allows mailto / tel", () => {
  assert.strictEqual(safeUrl("mailto:a@b.com"), "mailto:a@b.com");
  assert.strictEqual(safeUrl("tel:+15551234"), "tel:+15551234");
});
check("allows relative / anchor URLs", () => {
  assert.strictEqual(safeUrl("/docs/x.md"), "/docs/x.md");
  assert.strictEqual(safeUrl("#section"), "#section");
  assert.strictEqual(safeUrl("../rel/path"), "../rel/path");
});
check("allows raster data image when permitted", () =>
  assert.strictEqual(
    safeUrl("data:image/png;base64,iVBORw0KGgo=", { allowData: true }),
    "data:image/png;base64,iVBORw0KGgo="
  ));

// --- end-to-end: rendered HTML must not contain a live scheme --------------
check("link with javascript: renders href=\"#\", no live scheme", () => {
  const html = inlineMarkdown("[click me](javascript:alert(document.cookie))");
  assert.ok(!/href="javascript:/i.test(html), "javascript: href leaked: " + html);
  assert.ok(/href="#"/.test(html), "expected neutralized href: " + html);
});
check("image with javascript: src renders src=\"#\"", () => {
  const html = inlineMarkdown("![x](javascript:alert(1))");
  assert.ok(!/src="javascript:/i.test(html), "javascript: src leaked: " + html);
});
check("legit markdown link still works", () => {
  const html = inlineMarkdown("[home](https://example.com)");
  assert.ok(/href="https:\/\/example\.com"/.test(html), html);
  assert.ok(/rel="noopener"/.test(html), html);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall markdown-render XSS checks passed");
