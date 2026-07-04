// Repo-managed git hooks contract — the sprawl tripwire must run locally, not just CI.
//
// #1975 added two new public surfaces with no loop-stage justification; the sprawl
// check only lived in CI and the fork contributor had no local hook, so it was caught
// in review instead of before the push. This test locks in the fix: the pre-push hook
// invokes the sprawl tripwire, git is pointed at the tracked hooks via core.hooksPath,
// and that setup is auto-wired into `npm install`. It also exercises the tripwire's
// pure enforcement logic so a regression that weakens the check is caught here.
//
// Run: node apps/lantern-garage/test/git-hooks-repo-managed.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const REPO = path.resolve(__dirname, "../../..");
const HOOKS = path.join(REPO, "scripts", "hooks");
const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");

let failures = 0;
const checks = [];
function check(name, fn) { checks.push([name, fn]); }

// ── Wiring: the pre-push hook enforces the sprawl tripwire ───────────────────
check("pre-push invokes the sprawl tripwire", () => {
  const h = read("scripts/hooks/pre-push");
  assert.ok(/sprawl-tripwire\.mjs/.test(h), "pre-push must call scripts/sprawl-tripwire.mjs");
  assert.ok(/SKIP_SPRAWL_CHECK/.test(h), "pre-push must honour a SKIP_SPRAWL_CHECK bypass");
});

check("sprawl check runs BEFORE the workstream gate's early exit", () => {
  const h = read("scripts/hooks/pre-push");
  const sprawlAt = h.indexOf("sprawl-tripwire.mjs");
  // The workstream gate early-exits on `SKIP_MONOWORKSTREAM=1` / missing gh; if the
  // sprawl block sat after it, those common cases would skip the surface check. Anchor
  // on the exact early-exit statement (the words "workstream gate" also appear in the
  // file's top comment, which would match too early).
  const earlyExitAt = h.indexOf('= "1" ]; then exit 0; fi');
  assert.ok(sprawlAt > 0 && earlyExitAt > 0, "expected sprawl call and the workstream early-exit");
  assert.ok(sprawlAt < earlyExitAt, "sprawl tripwire must precede the workstream early-exit");
});

// ── Wiring: git is pointed at the tracked hooks, auto-installed ───────────────
check("setup-hooks.mjs sets core.hooksPath to scripts/hooks", () => {
  const s = read("scripts/setup-hooks.mjs");
  assert.ok(/HOOKS_REL\s*=\s*["']scripts\/hooks["']/.test(s), "HOOKS_REL must be scripts/hooks");
  assert.ok(/core\.hooksPath/.test(s), "must configure core.hooksPath");
  assert.ok(/update-index/.test(s), "must mark hooks executable (git ignores non-exec hooks on POSIX)");
});

check("npm install auto-installs hooks via prepare (root + app)", () => {
  const root = JSON.parse(read("package.json"));
  assert.ok(/setup-hooks\.mjs/.test(root.scripts.prepare || ""), "root prepare must run setup-hooks.mjs");
  assert.ok(/setup-hooks\.mjs/.test(root.scripts.hooks || ""), "root should expose an explicit hooks script");
  const app = JSON.parse(read("apps/lantern-garage/package.json"));
  assert.ok(/setup-hooks\.mjs/.test(app.scripts.prepare || ""), "app prepare must run setup-hooks.mjs");
});

check("both installers use core.hooksPath (unified, no per-machine copy)", () => {
  assert.ok(/core\.hooksPath|setup-hooks\.mjs/.test(read("scripts/install-hooks.sh")), "install-hooks.sh unified");
  assert.ok(/core\.hooksPath|setup-hooks\.mjs/.test(read("scripts/Install-MonoworkstreamHooks.ps1")), "ps1 unified");
});

check("canonical hooks are present and event-named", () => {
  for (const h of ["pre-commit", "commit-msg", "prepare-commit-msg", "pre-push", "post-merge", "post-checkout", "post-commit"]) {
    assert.ok(fs.existsSync(path.join(HOOKS, h)), `scripts/hooks/${h} must exist`);
    assert.ok(read(`scripts/hooks/${h}`).startsWith("#!"), `${h} must have a shebang`);
  }
});

check("legacy dispatchers guard against recursion", () => {
  for (const h of ["post-checkout", "post-commit"]) {
    const s = read(`scripts/hooks/${h}`);
    assert.ok(/git-common-dir/.test(s), `${h} must resolve the real .git/hooks (not core.hooksPath)`);
    assert.ok(/!=\s*"\$0"/.test(s), `${h} must not re-invoke itself`);
  }
});

// ── Enforcement: the tripwire logic the hook depends on actually works ────────
async function logicChecks() {
  const mod = await import(pathToFileURL(path.join(REPO, "scripts", "sprawl-tripwire.mjs")).href);

  check("a new surface with NO loop stage is a violation", () => {
    const r = mod.evaluateSurfaces([{ path: "apps/lantern-garage/public/x.html", content: "<html><head><title>x</title></head></html>" }]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.violations.length, 1);
  });

  check("a meta-tag loop stage justifies a surface", () => {
    const r = mod.evaluateSurfaces([{ path: "apps/lantern-garage/public/x.html", content: '<meta name="loop-stage" content="observe">' }]);
    assert.ok(r.ok);
    assert.strictEqual(r.justified[0].stage, "observe");
  });

  check("a comment-form loop stage also justifies (reset-password used verify)", () => {
    const r = mod.evaluateSurfaces([{ path: "apps/lantern-garage/public/x.html", content: "<!-- loop-stage: verify -->" }]);
    assert.ok(r.ok);
    assert.strictEqual(r.justified[0].stage, "verify");
  });

  check("an invalid stage name is NOT accepted", () => {
    assert.strictEqual(mod.extractLoopStage('<meta name="loop-stage" content="banana">'), null);
  });
}

(async () => {
  await logicChecks();
  for (const [name, fn] of checks) {
    try { await fn(); console.log("  ok  -", name); }
    catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
  }
  console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
  process.exit(failures ? 1 : 0);
})();
