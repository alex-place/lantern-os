#!/usr/bin/env node
/**
 * Auto-versioning system for Lantern OS
 * - Bumps patch version on each commit
 * - Adds ISO timestamp to build identifier
 * - Updates CHANGELOG automatically
 * - Writes version.json for client display
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const pkgPath = path.join(repoRoot, "package.json");
const versionPath = path.join(repoRoot, "apps/lantern-garage/version.json");
const changelogPath = path.join(repoRoot, "CHANGELOG.MD");

function getLastCommitMessage() {
  try {
    return execSync("git log -1 --pretty=%B", { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "Auto-update";
  }
}

function getCurrentBranch() {
  try {
    return execSync("git branch --show-current", { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "master";
  }
}

function getLastCommitHash() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function updateVersion() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const parts = pkg.version.split(".");
  parts[2] = String(Number(parts[2]) + 1); // bump patch
  const newVersion = parts.join(".");
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return newVersion;
}

function updateVersionJson(version) {
  const now = new Date().toISOString();
  const branch = getCurrentBranch();
  const commit = getLastCommitHash();
  const buildId = `${version}+${now.slice(0, 10)}.${now.slice(11, 19).replace(/:/g, "")}`;

  const versionObj = {
    version,
    buildId,
    timestamp: now,
    branch,
    commit,
  };

  fs.writeFileSync(versionPath, JSON.stringify(versionObj, null, 2) + "\n");
  return versionObj;
}

function updateChangelog(version, versionObj) {
  const commitMsg = getLastCommitMessage();
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];

  const entry = `## [${version}] - ${dateStr}
**Build:** ${versionObj.buildId}
**Commit:** ${versionObj.commit}

${commitMsg || "- Auto-update"}

---
`;

  let changelog = "";
  if (fs.existsSync(changelogPath)) {
    changelog = fs.readFileSync(changelogPath, "utf8");
  }

  // Insert the new entry above the most recent RELEASED version, keeping the
  // "# Changelog" title and "## [Unreleased]" block pinned to the top. Falls
  // back to a plain prepend for an empty/headerless changelog.
  const firstRelease = changelog.search(/^## \[\d+\.\d+\.\d+/m);
  if (firstRelease === -1) {
    fs.writeFileSync(changelogPath, entry + "\n" + changelog);
  } else {
    const head = changelog.slice(0, firstRelease);
    const rest = changelog.slice(firstRelease);
    fs.writeFileSync(changelogPath, head + entry + "\n" + rest);
  }
}

function main() {
  try {
    const newVersion = updateVersion();
    const versionObj = updateVersionJson(newVersion);
    updateChangelog(newVersion, versionObj);

    console.log(`✓ Version bumped: ${newVersion}`);
    console.log(`✓ Build ID: ${versionObj.buildId}`);
    console.log(`✓ CHANGELOG updated`);
    console.log(`✓ version.json written`);
  } catch (e) {
    console.error("❌ Auto-version failed:", e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { updateVersion, updateVersionJson, updateChangelog };
