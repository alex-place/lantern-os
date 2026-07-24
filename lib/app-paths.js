"use strict";

/**
 * app-paths.js — the ONE place that decides where writable state (`data/`, the
 * key vault, config) lives (ADR-0014 desktop Phase-0, guardrail G2).
 *
 * A shipped `.exe` must NEVER write inside its own program directory; per-user
 * state belongs in the OS app-data dir. This module is the seam that makes that
 * possible without forking the Core.
 *
 *   - Servers (4177 / 4178 / cloud) — DEFAULT, BEHAVIOUR-PRESERVING. With neither
 *     UNISONA_DESKTOP nor UNISONA_STATE_DIR set, `dataRoot()` === <repoRoot>/data,
 *     byte-for-byte today's path (same anchor lib/tenant.js used). Nothing changes
 *     for any existing deployment.
 *   - Desktop app — the launcher sets UNISONA_DESKTOP=1, rooting state at the OS
 *     per-user app-data dir: %APPDATA%\unisona on Windows,
 *     $XDG_DATA_HOME/unisona (or ~/.local/share/unisona) on Linux,
 *     ~/Library/Application Support/unisona on macOS.
 *   - UNISONA_STATE_DIR overrides the choice explicitly (tests / portable installs).
 *
 * This module DEFINES the seam; lib/tenant.js sources its DATA_ROOT from here so
 * the multi-tenancy seam (ADR-0018) and the desktop state-root move share one
 * anchor. Routing the remaining direct `path.join(repoRoot,"data",…)` call sites
 * (server.js, dreamer-store, conversation-store, …) through here is a later,
 * mechanical slice tracked on the same issue (#1946) — introducing this file
 * changes no behaviour on its own.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

// <repoRoot> — identical rooting to lib/tenant.js / lib/dreamer-store.js
// (lib/ is three levels below the repo root).
const repoRoot = path.resolve(__dirname, "..");

const APP_DIR_NAME = "unisona";

/** Desktop profile iff the launcher set UNISONA_DESKTOP=1 or an explicit state dir. */
function isDesktop(env = process.env) {
  return env.UNISONA_DESKTOP === "1" || Boolean(env.UNISONA_STATE_DIR);
}

/** OS-appropriate per-user app-data base directory (the parent of <app>/). */
function osAppDataBase(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    return env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

/**
 * The state root — the directory that CONTAINS data/, the key vault, and config.
 *   servers  -> <repoRoot>                (so state stays under the checkout: UNCHANGED)
 *   desktop  -> <osAppDataBase>/unisona   (per-user, outside the program dir)
 * UNISONA_STATE_DIR, when set, wins outright (portable / test installs).
 */
function stateRoot(env = process.env, platform = process.platform) {
  if (env.UNISONA_STATE_DIR) return path.resolve(env.UNISONA_STATE_DIR);
  if (isDesktop(env)) return path.join(osAppDataBase(env, platform), APP_DIR_NAME);
  return repoRoot; // behaviour-preserving default
}

/** Writable data root. Default: <repoRoot>/data (UNCHANGED). Desktop: <stateRoot>/data. */
function dataRoot(env = process.env, platform = process.platform) {
  return path.join(stateRoot(env, platform), "data");
}

/**
 * Create the state + data dirs if missing (desktop first-run on a virgin machine).
 * A no-op-safe mkdir -p; returns the ensured data root.
 */
function ensureStateDirs(env = process.env, platform = process.platform) {
  const dr = dataRoot(env, platform);
  fs.mkdirSync(dr, { recursive: true });
  return dr;
}

module.exports = {
  repoRoot,
  APP_DIR_NAME,
  isDesktop,
  osAppDataBase,
  stateRoot,
  dataRoot,
  ensureStateDirs,
};
