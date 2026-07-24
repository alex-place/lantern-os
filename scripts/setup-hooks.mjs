#!/usr/bin/env node
/**
 * setup-hooks — point git at the repo-managed hooks (scripts/hooks) so every
 * clone runs the same pre-commit / commit-msg / pre-push checks (workstream +
 * slop + change-record + sprawl tripwire) with NO copy step and NO drift.
 *
 * How: sets `core.hooksPath = scripts/hooks` (a RELATIVE path, so each linked
 * worktree resolves it to its own copy) and marks the event-named hooks
 * executable in git (git silently ignores non-executable hooks on macOS/Linux).
 *
 * Runs automatically from the `prepare` npm script on `npm install` (root and
 * .), and can be run by hand: `npm run hooks` / `make hooks`.
 * It is a deliberate NO-OP (exit 0) outside a git work-tree — e.g. a tarball
 * install or a CI image — so it can never break `npm install`. CI re-runs every
 * one of these checks regardless, so a machine that skips this is still gated.
 *
 * Usage: node scripts/setup-hooks.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HOOKS_REL = "scripts/hooks";
// git event-named hooks that must be executable for git to run them on POSIX.
const EVENT_HOOKS = [
  "pre-commit",
  "commit-msg",
  "prepare-commit-msg",
  "pre-push",
  "post-merge",
  "post-checkout",
  "post-commit",
];

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    ...opts,
  }).trim();
}

function main() {
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"]);
  } catch {
    // Not a git work-tree (tarball / CI image) — nothing to wire, don't fail install.
    process.exit(0);
  }

  if (!existsSync(join(root, HOOKS_REL))) {
    process.stdout.write(`[hooks] ${HOOKS_REL} not found — skipping.\n`);
    process.exit(0);
  }

  // 1. Point git at the repo-managed hooks (idempotent).
  let current = "";
  try {
    current = git(["config", "--local", "core.hooksPath"]);
  } catch {
    current = "";
  }
  if (current !== HOOKS_REL) {
    git(["config", "core.hooksPath", HOOKS_REL]);
    process.stdout.write(
      `[hooks] set core.hooksPath = ${HOOKS_REL} — repo-managed git hooks are now active.\n`
    );
  } else {
    process.stdout.write(`[hooks] core.hooksPath already = ${HOOKS_REL}.\n`);
  }

  // 2. Ensure the event-named hooks are executable in git's index (mode 100755),
  //    so a fresh clone checks them out runnable on macOS/Linux. No-op on Windows.
  for (const h of EVENT_HOOKS) {
    const rel = `${HOOKS_REL}/${h}`;
    if (!existsSync(join(root, rel))) continue;
    try {
      git(["update-index", "--chmod=+x", rel], { cwd: root });
    } catch {
      /* file not tracked yet, or already +x — harmless */
    }
  }
}

try {
  main();
} catch (e) {
  // Never let hook setup break `npm install`; CI is the enforcement backstop.
  process.stdout.write(`[hooks] skipped (${e && e.message ? e.message : e}).\n`);
  process.exit(0);
}
