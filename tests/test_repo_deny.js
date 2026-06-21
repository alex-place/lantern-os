/**
 * Regression: /repo file serving must deny .git, dotfiles, source, and PII pools (#868).
 * Pure-function test of the route's allowlist + deny matcher. No server.
 *
 * Run: node tests/test_repo_deny.js
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const fileRoutes = require(path.join(__dirname, "..", "apps", "lantern-garage", "routes", "files"));
const REPO = path.join(__dirname, "..");

function run(pathname) {
  const res = { _code: null, _json: null, _html: null, _file: null };
  const deps = {
    fs, path, repoRoot: REPO,
    sendJson: (r, body, code) => { res._json = body; res._code = code; },
    sendFile: (r, p) => { res._file = p; },
    sendHtml: (r, h) => { res._html = h; },
    renderMarkdownDocument: (t) => "<html>" + String(t).slice(0, 12) + "</html>",
  };
  return fileRoutes({}, res, new URL("http://x" + pathname), deps).then(() => res);
}

(async () => {
  let passed = 0; const ok = (n) => { passed++; console.log("  ✓ " + n); };

  let r = await run("/repo/.git/HEAD");
  assert.strictEqual(r._code, 403); assert.strictEqual(r._file, null); assert.strictEqual(r._html, null);
  ok("/repo/.git/HEAD → 403, nothing served (source+history disclosure blocked)");

  r = await run("/repo/.gitignore");
  assert.strictEqual(r._code, 403);
  ok("/repo/.gitignore (dotfile) → 403");

  r = await run("/repo/apps/lantern-garage/server.js");
  assert.strictEqual(r._code, 403);
  ok("/repo/<source>.js → 403 (extension not allowlisted)");

  r = await run("/repo/data/ingest/secret.pdf");
  assert.strictEqual(r._code, 403);
  ok("/repo/data/ingest/*.pdf → 403 (PII pool denied even though .pdf is an allowed ext)");

  r = await run("/repo/README.md");
  assert.notStrictEqual(r._code, 403);
  assert.ok(r._html, "README.md rendered, not blocked");
  ok("/repo/README.md → served (allowed document)");

  console.log(`\nAll ${passed} repo-deny assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
