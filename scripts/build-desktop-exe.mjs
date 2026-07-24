#!/usr/bin/env node
// build-desktop-exe.mjs — compile the thin desktop launcher (
// desktop/launcher.js) into a single, double-clickable `unisona.exe` using Node's
// built-in Single Executable Application (SEA) support. This is step 2 of the
// Phase-1 packaging plan in desktop/README.md (ADR-0014):
// wrap ONLY the launcher — the Core (server.js + native modules) ships as a
// separate app tree + a real node runtime the launcher spawns. We deliberately do
// NOT use `pkg` (deprecated) or Electron (ADR-0014 rejects a bundled Chromium).
//
// Prereqs: Node >= 20 (this script's own runtime becomes the exe's base). `postject`
// is fetched on demand via `npx -y postject` (needs network the first time).
//
// Output: desktop/dist/unisona.exe (+ sea-prep.blob).
// Sign it (Azure Trusted Signing) and lay it into an installer as later steps.
//
// Usage: node scripts/build-desktop-exe.mjs

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// 2b. (Windows) Embed the Unisona icon NOW — BEFORE postject. rcedit rewrites the PE
//     resource section; on a postject'd SEA exe (blob appended) it hangs, but on the
//     clean node copy it's instant, and postject preserves the icon resource it added.
if (isWin) {
  const icoPath = join(desktopDir, "unisona.ico");
  if (existsSync(icoPath)) {
    const rceditExe = join(desktopDir, "node_modules", "rcedit", "bin", "rcedit-x64.exe");
    if (!existsSync(rceditExe)) {
      console.log("[build] installing rcedit (pinned build dep)…");
      const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      run(process.execPath, [npmCli, "install", "--no-audit", "--no-fund", "--no-save", "--prefix", desktopDir, "rcedit@4.0.1"]);
    }
    run(rceditExe, [exePath, "--set-icon", icoPath]);
    console.log("[build] embedded unisona.ico into the exe.");
  } else {
    console.log("[build] (no unisona.ico found — skipping icon embed)");
  }
}

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

// 4. (Windows) Flip the PE subsystem from CONSOLE (3) to GUI (2) so double-clicking
//    the exe never pops a console window — it's a standalone desktop app. The
//    launcher already redirects its logs to a file when packaged (no stdout needed).
//    This only rewrites one header field; the SEA blob + fuse are untouched. Signing
//    happens after this, so it doesn't invalidate a signature we care about.
if (isWin) {
  setPeSubsystemGui(exePath);
  console.log("[build] flipped PE subsystem → GUI (no console window).");
}

console.log(`\n✓ Built ${exePath} (${mb(exePath)} MB)`);
console.log("  One binary, windowless — runs the launcher AND (re-execed with");
console.log("  UNISONA_CORE=1) the Core; opens a chromeless app window. Next: sign it");
console.log("  (SignPath Foundation), then ship the . tree beside it.");

// Rewrite the PE Optional Header's Subsystem field to IMAGE_SUBSYSTEM_WINDOWS_GUI (2).
// Layout: e_lfanew (u32 @ 0x3C) → PE sig (4) + COFF header (20) → Optional Header;
// Subsystem is a u16 at offset 68 within the Optional Header (same for PE32/PE32+).
function setPeSubsystemGui(file) {
  const buf = readFileSync(file);
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error("not a PE (no MZ)"); // 'MZ'
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error("not a PE (no PE\\0\\0)"); // 'PE\0\0'
  const subsystemOff = peOff + 4 + 20 + 68;
  const GUI = 2;
  if (buf.readUInt16LE(subsystemOff) !== GUI) {
    buf.writeUInt16LE(GUI, subsystemOff);
    writeFileSync(file, buf);
  }
}
