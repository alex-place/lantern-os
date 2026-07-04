#!/usr/bin/env node
// build-desktop-exe.mjs — compile the thin desktop launcher (apps/lantern-garage/
// desktop/launcher.js) into a single, double-clickable `unisona.exe` using Node's
// built-in Single Executable Application (SEA) support. This is step 2 of the
// Phase-1 packaging plan in apps/lantern-garage/desktop/README.md (ADR-0014):
// wrap ONLY the launcher — the Core (server.js + native modules) ships as a
// separate app tree + a real node runtime the launcher spawns. We deliberately do
// NOT use `pkg` (deprecated) or Electron (ADR-0014 rejects a bundled Chromium).
//
// Prereqs: Node >= 20 (this script's own runtime becomes the exe's base). `postject`
// is fetched on demand via `npx -y postject` (needs network the first time).
//
// Output: apps/lantern-garage/desktop/dist/unisona.exe (+ sea-prep.blob).
// Sign it (Azure Trusted Signing) and lay it into an installer as later steps.
//
// Usage: node scripts/build-desktop-exe.mjs

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const desktopDir = join(repoRoot, "apps", "lantern-garage", "desktop");
const distDir = join(desktopDir, "dist");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const exeName = isWin ? "unisona.exe" : "unisona";
const exePath = join(distDir, exeName);
const blobPath = join(distDir, "sea-prep.blob");
const configPath = join(desktopDir, "sea-config.json");

// The SEA "fuse" sentinel is a fixed public constant Node documents for postject;
// it marks where the blob is injected. Same value for every SEA build.
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(cmd, args, opts = {}) {
  console.log("›", cmd, args.join(" "));
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}
const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);

console.log(`[build] node ${process.version} on ${process.platform}/${process.arch}`);

// 0. Clean output.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// 1. Generate the SEA preparation blob from launcher.js. Paths inside sea-config.json
//    resolve relative to cwd, so run from the desktop dir.
run(process.execPath, ["--experimental-sea-config", configPath], { cwd: desktopDir });

// 2. Copy THIS node binary — it becomes the exe's runtime base.
copyFileSync(process.execPath, exePath);
console.log(`[build] copied runtime → ${exeName} (${mb(exePath)} MB)`);

// 3. Inject the blob into the copied binary. postject rewrites a PE/Mach-O/ELF
//    resource; the copy's original code-signature (if any) is invalidated — that's
//    expected, we re-sign in a later step. Node's own signature check is bypassed
//    by the fuse, so an unsigned injected copy runs.
//
//    We invoke npm and postject via `node <cli.js>` rather than the `npx.cmd`/
//    `npm.cmd` shims: Node 24 on Windows rejects execFileSync of a .cmd file
//    (EINVAL, the CVE-2024-27980 hardening), so calling the shims directly fails.
const postjectCli = join(desktopDir, "node_modules", "postject", "dist", "cli.js");
if (!existsSync(postjectCli)) {
  console.log("[build] installing postject (pinned build dep)…");
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  run(process.execPath, [
    npmCli, "install", "--no-audit", "--no-fund", "--no-save",
    "--prefix", desktopDir, "postject@1.0.0-alpha.6",
  ]);
}
const postjectArgs = [postjectCli, exePath, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", FUSE];
if (isMac) postjectArgs.push("--macho-segment-name", "NODE_SEA");
run(process.execPath, postjectArgs);

console.log(`\n✓ Built ${exePath} (${mb(exePath)} MB)`);
console.log("  Next: sign it (Azure Trusted Signing), then ship node(.exe) + the");
console.log("  apps/lantern-garage tree beside it (installer = step 3/4, ADR-0014).");
