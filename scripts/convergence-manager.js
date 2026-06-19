#!/usr/bin/env node
/**
 * Lantern OS Convergence Manager
 *
 * Self-executing loop that scans repo state, classifies issues by severity,
 * applies auto-fixes where safe, and reports what needs human/agent action.
 *
 * Loop: Status → Scan → Sort → Strike → Validate → Record → Repeat
 *
 * Runs in Node.js >=20, zero external deps, cloud-safe (no PowerShell).
 * Use in CI: node scripts/convergence-manager.js [--fix] [--json] [--max-iter N]
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── Config ───────────────────────────────────────────────────────────────────

const ROOT       = path.resolve(__dirname, "..");
const MAX_ITER   = parseInt(process.argv.find(a => a.startsWith("--max-iter="))?.split("=")[1] ?? "3", 10);
const AUTO_FIX   = process.argv.includes("--fix");
const JSON_OUT   = process.argv.includes("--json");
const FIX_WINDOW = 4;

// Files that MUST exist for the repo to be shippable
const REQUIRED = [
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "apps/lantern-garage/server.js",
  "apps/lantern-garage/cloud-server.js",
  "apps/lantern-garage/package.json",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",
  "skills/super-jarvis-lantern-os/SKILL.md",
];

// Top-level directories allowed to exist (anti-sprawl gate)
const ALLOWED_TOP = new Set([
  "apps", "archive", "assets", "caad", "config", "content", "csf", "data", "dev", "docs",
  "dual-boot", "experiments", "integrations", "lantern-discord", "logs", "lore", "manifests",
  "merge-patches", "models", "patches", "private-ip", "rag", "references", "reports",
  "research", "safezone-debug",
  "scripts", "services", "skills", "src", "surfaces", "test-results", "tests",
  "training_data", ".claude", ".github", ".windsurf",
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

const rel  = p  => path.join(ROOT, p);
const has  = p  => fs.existsSync(rel(p));
const read = p  => fs.readFileSync(rel(p), "utf8");

function git(cmd) {
  try { return execSync(`git -C ${ROOT} ${cmd}`, { encoding: "utf8" }).trim(); }
  catch { return null; }
}

function issue(id, severity, summary, fix, autoFixFn = null) {
  return { id, severity, summary, fix, autoFixFn };
}

// ── Scan ─────────────────────────────────────────────────────────────────────

function scan() {
  const issues = [];

  // 1. Required files
  for (const f of REQUIRED) {
    if (!has(f)) {
      issues.push(issue(`MISSING:${f}`, "high", `Required file missing: ${f}`, `Create ${f}`));
    }
  }

  // 2. Anti-sprawl: unexpected top-level directories
  for (const entry of fs.readdirSync(ROOT)) {
    if (entry.startsWith(".")) continue;
    const full = path.join(ROOT, entry);
    if (fs.statSync(full).isDirectory() && !ALLOWED_TOP.has(entry)) {
      issues.push(issue(
        `SPRAWL:${entry}`,
        "medium",
        `Unexpected top-level directory: ${entry}`,
        `Move ${entry} into an allowed directory or add to ALLOWED_TOP if intentional`
      ));
    }
  }

  // 3. Git state — uncommitted changes
  const dirty = git("status --short");
  if (dirty && dirty.length > 0) {
    issues.push(issue(
      "GIT:DIRTY",
      "medium",
      `Uncommitted changes:\n${dirty}`,
      "Commit or stash all changes before shipping"
    ));
  }

  // 4. Git state — local master ahead of origin
  const ahead = git("rev-list --count origin/master..master 2>/dev/null");
  if (ahead && parseInt(ahead, 10) > 0) {
    issues.push(issue(
      "GIT:UNPUSHED",
      "high",
      `master is ${ahead} commit(s) ahead of origin/master`,
      "Push master: git push origin master"
    ));
  }

  // 5. Package.json engine check
  if (has("apps/lantern-garage/package.json")) {
    const pkg = JSON.parse(read("apps/lantern-garage/package.json"));
    const eng = pkg.engines?.node ?? "";
    if (!eng.includes(">=20") && !eng.includes(">=22")) {
      issues.push(issue(
        "NODE:ENGINE",
        "medium",
        `lantern-garage engines.node is "${eng}", should be >=20`,
        'Set engines.node to ">=20" in apps/lantern-garage/package.json'
      ));
    }
  }

  // 6. deploy.yml — must NOT reference AWS ECS (retired)
  if (has(".github/workflows/deploy.yml")) {
    const deploy = read(".github/workflows/deploy.yml");
    if (deploy.includes("aws-actions") || deploy.includes("ecs")) {
      issues.push(issue(
        "DEPLOY:AWS_REMNANT",
        "high",
        "deploy.yml still references AWS ECS (retired — use GitHub Pages + Railway)",
        "Replace deploy.yml with the GitHub Pages + Railway workflow"
      ));
    }
  }

  // 7. Stash check
  const stashes = git("stash list");
  if (stashes && stashes.trim().length > 0) {
    issues.push(issue(
      "GIT:STASH",
      "low",
      `Stashed work exists:\n${stashes}`,
      "Pop, commit, or drop stash entries before shipping"
    ));
  }

  return issues;
}

// ── Auto-fix registry ────────────────────────────────────────────────────────

function applyAutoFixes(issues) {
  const fixed = [];
  for (const iss of issues) {
    if (iss.autoFixFn) {
      try {
        iss.autoFixFn();
        fixed.push(iss.id);
      } catch (e) {
        // auto-fix failed — leave for human/agent
      }
    }
  }
  return fixed;
}

// ── Loop ─────────────────────────────────────────────────────────────────────

function run() {
  const report = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    mode: AUTO_FIX ? "auto-fix" : "scan-only",
    iterations: [],
    finalIssueCount: 0,
    status: "unknown",
  };

  for (let i = 0; i < MAX_ITER; i++) {
    const issues = scan();
    const top    = issues.slice(0, FIX_WINDOW);
    const iter   = {
      iteration: i + 1,
      issueCount: issues.length,
      leadingIssues: top,
      fixed: [],
    };

    if (!JSON_OUT) {
      console.log(`\n── Iteration ${i + 1}/${MAX_ITER} ── ${issues.length} issue(s) found`);
      for (const iss of top) {
        console.log(`  [${iss.severity.toUpperCase()}] ${iss.id}: ${iss.summary}`);
        console.log(`         Fix: ${iss.fix}`);
      }
    }

    if (AUTO_FIX && issues.length > 0) {
      iter.fixed = applyAutoFixes(top);
    }

    report.iterations.push(iter);

    if (issues.length === 0) {
      report.status = "clean";
      break;
    }

    if (!AUTO_FIX || iter.fixed.length === 0) {
      report.status = issues.some(i => i.severity === "high") ? "needs_agent" : "needs_review";
      break;
    }
  }

  report.finalIssueCount = scan().length;
  if (report.status === "unknown") {
    report.status = report.finalIssueCount === 0 ? "clean" : "max_iter_reached";
  }

  // Write JSON receipt
  const receiptDir  = path.join(ROOT, "manifests", "validation");
  const receiptPath = path.join(receiptDir, "CONVERGENCE-MANAGER-LATEST.json");
  fs.mkdirSync(receiptDir, { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(report, null, 2));

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n── Result: ${report.status} (${report.finalIssueCount} issue(s) remaining)`);
    console.log(`   Receipt: manifests/validation/CONVERGENCE-MANAGER-LATEST.json`);
  }

  process.exit(report.finalIssueCount > 0 ? 1 : 0);
}

run();
