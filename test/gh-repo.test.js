// #2759 — repo resolution for the GitHub-facing tools. The git probe is exercised
// live (depends on the checkout's origin); the pure parsing + env-precedence that
// decide which repo the tools target are locked down here.
//
// Run: node test/gh-repo.test.js
const assert = require("assert");
const { resolveRepo, parseOwnerRepo, DEFAULT_REPO } = require("../lib/gh-repo");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// parseOwnerRepo — every remote URL form → owner/repo
check("parses https .git url", () => assert.strictEqual(parseOwnerRepo("https://github.com/foo/bar.git"), "foo/bar"));
check("parses https url without .git", () => assert.strictEqual(parseOwnerRepo("https://github.com/foo/bar-baz"), "foo/bar-baz"));
check("parses scp-style ssh url", () => assert.strictEqual(parseOwnerRepo("git@github.com:Owner/Repo.git"), "Owner/Repo"));
check("parses ssh:// url", () => assert.strictEqual(parseOwnerRepo("ssh://git@github.com/foo/bar"), "foo/bar"));
check("parses url with trailing slash", () => assert.strictEqual(parseOwnerRepo("https://github.com/foo/bar/"), "foo/bar"));
check("non-github → null", () => assert.strictEqual(parseOwnerRepo("https://gitlab.com/foo/bar.git"), null));
check("garbage → null", () => assert.strictEqual(parseOwnerRepo("not a url"), null));
check("empty / null → null", () => { assert.strictEqual(parseOwnerRepo(""), null); assert.strictEqual(parseOwnerRepo(null), null); });

// resolveRepo — env override wins over autodetect, and is read fresh each call
check("GH_REPO env overrides autodetect", () => {
  const prev = process.env.GH_REPO;
  process.env.GH_REPO = "octocat/hello-world";
  try { assert.strictEqual(resolveRepo(), "octocat/hello-world"); }
  finally { if (prev === undefined) delete process.env.GH_REPO; else process.env.GH_REPO = prev; }
});
check("blank GH_REPO is ignored (falls through to detect/default)", () => {
  const prev = process.env.GH_REPO;
  process.env.GH_REPO = "   ";
  try { assert.strictEqual(typeof resolveRepo(), "string"); assert.ok(resolveRepo().includes("/")); }
  finally { if (prev === undefined) delete process.env.GH_REPO; else process.env.GH_REPO = prev; }
});
check("always returns an owner/repo string", () => {
  const prev = process.env.GH_REPO;
  delete process.env.GH_REPO;
  try { const r = resolveRepo(); assert.ok(/^[^/]+\/[^/]+$/.test(r), `expected owner/repo, got '${r}'`); }
  finally { if (prev !== undefined) process.env.GH_REPO = prev; }
});
check("DEFAULT_REPO is a sane owner/repo", () => assert.ok(/^[^/]+\/[^/]+$/.test(DEFAULT_REPO)));

process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
