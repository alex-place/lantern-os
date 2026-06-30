#!/usr/bin/env node
/**
 * Dev-environment Rust check for Lantern OS contributors.
 * Runs silently if Rust is present. Attempts auto-install if missing.
 * Non-blocking: failures do not prevent startup.
 */

const { execSync, execFileSync } = require("child_process");
const { existsSync } = require("fs");
const { join } = require("path");

function hasRust() {
  try {
    execSync("rustc --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (hasRust()) {
    return;
  }

  console.log("[ensure-rust] Rust not found. Attempting auto-install...");

  const root = join(__dirname, "..");
  const isWin = process.platform === "win32";
  const script = isWin
    ? join(root, "scripts", "Install-Rust.ps1")
    : join(root, "scripts", "install-rust.sh");

  if (!existsSync(script)) {
    console.warn(`[ensure-rust] Installer not found: ${script}`);
    return;
  }

  try {
    if (isWin) {
      // Shell-free: the installer path is a discrete argv element (handles spaces
      // and never re-interprets the path through a shell).
      execFileSync(
        "powershell",
        ["-ExecutionPolicy", "Bypass", "-File", script],
        { stdio: "inherit", timeout: 300000 }
      );
    } else {
      execFileSync("bash", [script], { stdio: "inherit", timeout: 300000 });
    }
    console.log("[ensure-rust] Rust installed successfully.");
  } catch (err) {
    console.warn("[ensure-rust] Auto-install failed (non-fatal):", err.message);
  }
}

main();
