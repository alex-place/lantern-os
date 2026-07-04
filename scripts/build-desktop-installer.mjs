#!/usr/bin/env node
// build-desktop-installer.mjs — assemble the desktop payload and compile the
// direct-download installer (Inno Setup) for unisona.ai. This is the SignPath /
// direct-download half of packaging step 4 (ADR-0014 / desktop/README.md); the
// Microsoft-Store (MSIX) channel is separate.
//
// The staged layout MIRRORS the repo, because the Core reaches outside the garage
// app — e.g. lib/job-worker.js requires ../../../src/creator-intelligence. Placing
// the garage at resources/app (same depth as apps/lantern-garage) and src/ at the
// install root makes those `../../../src` requires resolve with NO launcher change:
//
//   <install>\
//     unisona.exe              ← the SEA (runtime + launcher; also runs the Core)
//     resources\app\           ← apps/lantern-garage (server.js, lib, routes, public, node_modules)
//     src\                     ← repo src/ (creator-intelligence, worktree-manager, …)
//     node_modules\            ← repo-root node_modules (src/ deps resolve here)
//     package.json             ← repo-root package.json (version, etc.)
//
// From resources\app\lib\job-worker.js, `../../../src` climbs to <install>\src. ✓
//
// Prereq to COMPILE: Inno Setup 6 (ISCC.exe) — `winget install JRSoftware.InnoSetup`.
// Without it, staging still runs and you can point unisona.exe at dist/staging to test.
//
// Usage: node scripts/build-desktop-installer.mjs

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const garageDir = join(repoRoot, "apps", "lantern-garage");
const desktopDir = join(garageDir, "desktop");
const distDir = join(desktopDir, "dist");
// Stage OUTSIDE the garage tree — cpSync refuses to copy apps/lantern-garage into a
// subdirectory of itself. <repoRoot>/dist is gitignored and not under the garage.
const stagingDir = join(repoRoot, "dist", "unisona-stage");
const exePath = join(distDir, "unisona.exe");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

function run(cmd, args, opts = {}) {
  console.log("›", cmd, args.map((a) => (String(a).includes(" ") ? `"${a}"` : a)).join(" "));
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}
const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);

console.log(`[installer] Unisona ${version} — node ${process.version} on ${process.platform}`);

// 1. Ensure the exe exists (build it if missing).
if (!existsSync(exePath)) {
  console.log("[installer] unisona.exe not built yet — building it first…");
  run(process.execPath, [join(here, "build-desktop-exe.mjs")]);
}

// 2. Stage the payload. On Windows, robocopy is far faster than cpSync for the
// ~100k node_modules files and rides out long paths / transient locks; cpSync is
// the portable fallback.
console.log("[installer] staging payload → dist/unisona-stage …");
rmSync(stagingDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
mkdirSync(stagingDir, { recursive: true });

// Never ship: build output, build-only deps, VCS, secrets, and — critically — the
// self-referential `lantern-os` node_modules entry, which nests the WHOLE repo
// (incl. live data/ files running servers hold open) and would both bloat the
// payload and lock the copy.
const XD_NAMES = [".git", ".cache"];                 // by name, at any depth
const XF_NAMES = [".env", ".env.local", ".env.*"];   // secrets
const appDst = join(stagingDir, "resources", "app");

if (process.platform === "win32") {
  const robo = (src, dst, xd = []) => {
    console.log("› robocopy", src, "→", dst);
    const args = [src, dst, "/E", "/MT:16", "/R:3", "/W:2", "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
      "/XD", ...XD_NAMES, ...xd, "/XF", ...XF_NAMES];
    try { execFileSync("robocopy", args, { stdio: "inherit" }); }
    catch (e) { if ((e.status ?? 8) >= 8) throw e; } // robocopy exit <8 = success
  };
  robo(garageDir, appDst, [
    join(garageDir, "node_modules", "lantern-os"),
    join(desktopDir, "dist"),
    join(desktopDir, "node_modules"),
  ]);
  robo(join(repoRoot, "src"), join(stagingDir, "src"));
  robo(join(repoRoot, "node_modules"), join(stagingDir, "node_modules"),
    [join(repoRoot, "node_modules", "lantern-os")]);
} else {
  const EXCLUDE = [
    join(desktopDir, "dist") + sep, join(desktopDir, "node_modules") + sep, sep + ".git" + sep,
    sep + "node_modules" + sep + "lantern-os" + sep, sep + "node_modules" + sep + ".cache" + sep,
  ];
  const filter = (s) => !EXCLUDE.some((x) => (s + sep).includes(x)) && !/(^|[\\/])\.env(\.|$)/i.test(s);
  mkdirSync(appDst, { recursive: true });
  cpSync(garageDir, appDst, { recursive: true, filter });
  cpSync(join(repoRoot, "src"), join(stagingDir, "src"), { recursive: true, filter });
  cpSync(join(repoRoot, "node_modules"), join(stagingDir, "node_modules"), { recursive: true, filter });
}
cpSync(join(repoRoot, "package.json"), join(stagingDir, "package.json"));
// App-content config the Core reads at boot (personas.json, doors.json, …) — read
// from <install>/data/contexts, NOT the relocated user state, so it must ship with
// the app or the Core falls back to built-in defaults (the personas.json ENOENT).
cpSync(join(repoRoot, "data", "contexts"), join(stagingDir, "data", "contexts"), { recursive: true });
cpSync(exePath, join(stagingDir, "unisona.exe"));
console.log("[installer] staged.");

// 2b. Completeness guard. The packaged app must contain EVERY declared runtime dep
// or the installed Core crashes at boot (e.g. `Cannot find module 'busboy'`). Check
// against the app node_modules and the root node_modules on the resolution path.
// The `lantern-os` file: self-dep is exempt — nothing imports it and the launcher
// sets SKIP_DEP_PREFLIGHT. Fail LOUD here rather than ship an installer that won't run.
const appPkg = JSON.parse(readFileSync(join(appDst, "package.json"), "utf8"));
const nmDirs = [join(appDst, "node_modules"), join(stagingDir, "node_modules")];
const missingDeps = Object.keys(appPkg.dependencies || {}).filter((dep) => {
  if (dep === "lantern-os") return false;
  return !nmDirs.some((nm) => existsSync(join(nm, ...dep.split("/"))));
});
if (missingDeps.length) {
  console.error(`\n✗ Bundle INCOMPLETE — ${missingDeps.length} declared dependenc${missingDeps.length === 1 ? "y" : "ies"} absent from the staged node_modules:`);
  console.error(`    ${missingDeps.join(", ")}`);
  console.error(`  Build from a checkout with a complete, current \`npm ci\` — and with NO server`);
  console.error(`  running from it (a live server holds node_modules handles and robocopy skips them).`);
  console.error(`  Refusing to compile an installer that won't boot.\n`);
  process.exit(1);
}
console.log(`[installer] completeness check passed (${Object.keys(appPkg.dependencies || {}).length} deps present).`);

// 3. Compile the installer with Inno Setup, if available.
const iss = join(desktopDir, "unisona.iss");
const isccCandidates = [
  process.env.ISCC,                                                        // explicit override
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Inno Setup 6", "ISCC.exe"), // winget per-user
  "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
  "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  "ISCC.exe",                                                              // on PATH
].filter(Boolean);
const iscc = isccCandidates.find((c) => c === "ISCC.exe" || existsSync(c));
if (!iscc) {
  console.log("\n⚠ Inno Setup (ISCC.exe) not found — staged the payload but did NOT compile.");
  console.log("  Install it (winget install JRSoftware.InnoSetup) and re-run, or test the");
  console.log(`  staged app directly:  ${join(stagingDir, "unisona.exe")}`);
  process.exit(0);
}
run(iscc, [
  `/DAppVersion=${version}`,
  `/DStagingDir=${stagingDir}`,
  `/DOutputDir=${distDir}`,
  iss,
]);

const setup = join(distDir, `Unisona-Setup-${version}.exe`);
if (existsSync(setup)) console.log(`\n✓ Built ${setup} (${mb(setup)} MB)`);
console.log("  Per-user install to %LOCALAPPDATA%\\unisona (no admin). Sign it via");
console.log("  SignPath Foundation before public download (ADR-0014 §3).");
