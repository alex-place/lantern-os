#!/usr/bin/env node
/**
 * Batch issue creation for Lantern OS
 * Usage: node scripts/issue-batch.js <manifest.json>
 * Manifest schema: [{ "title": "...", "body": "...", "labels": ["bug"], "milestone": "" }]
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = process.env.LANTERN_REPO || "alex-place/lantern-os";

function runGh(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `gh exited ${code}`));
    });
    proc.stdin.end();
  });
}

async function createIssue(item) {
  const args = ["issue", "create", "--repo", REPO, "--title", item.title];
  if (item.body) {
    const bodyPath = path.join(require("os").tmpdir(), `issue-${Date.now()}.md`);
    fs.writeFileSync(bodyPath, item.body, "utf8");
    args.push("--body-file", bodyPath);
  }
  if (item.labels && item.labels.length) {
    for (const label of item.labels) args.push("--label", label);
  }
  if (item.milestone) args.push("--milestone", item.milestone);
  const result = await runGh(args);
  // Clean up temp body file
  try { fs.unlinkSync(args[args.indexOf("--body-file") + 1]); } catch {}
  return result;
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("Usage: node scripts/issue-batch.js <manifest.json>");
    console.error("Env: LANTERN_REPO (default: alex-place/lantern-os)");
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest)) {
    console.error("Manifest must be a JSON array of issue objects.");
    process.exit(1);
  }

  console.log(`Creating ${manifest.length} issue(s) in ${REPO}...`);
  const results = [];
  for (let i = 0; i < manifest.length; i++) {
    const item = manifest[i];
    try {
      const url = await createIssue(item);
      results.push({ ok: true, title: item.title, url });
      console.log(`  [${i + 1}/${manifest.length}] Created: ${url}`);
    } catch (err) {
      results.push({ ok: false, title: item.title, error: err.message });
      console.error(`  [${i + 1}/${manifest.length}] FAILED: ${item.title} — ${err.message}`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\nDone: ${okCount}/${manifest.length} succeeded.`);

  if (okCount < manifest.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
