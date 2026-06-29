"use strict";

/**
 * resolve-python — find a Python interpreter that actually exists on THIS machine.
 *
 * OH-1 (#1548): boot child processes spawned a bare `python` (or `process.platform ===
 * "win32" ? "python" : "python3"`). On a box where only the Windows `py` launcher or a
 * venv is on PATH — not a bare `python` — every such spawn throws `ENOENT`, and the AI
 * trader's child crash-loops (retry storm). This module probes for a working interpreter
 * ONCE, caches it, and returns the command + any prefix args to spawn it.
 *
 * Resolution order (first that answers `--version` with exit 0 wins):
 *   1. $PYTHON_PATH / $PYTHON  (explicit override — used verbatim, no probe)
 *   2. an active venv: $VIRTUAL_ENV, then ./.venv, ./.venv-train (repo-local)
 *   3. `python3`, then `python`
 *   4. Windows `py -3` launcher
 *
 * Returns null when NOTHING works, so callers can log a single actionable "disabled:
 * no python interpreter" line instead of spawning into an ENOENT retry storm.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let _cached; // { cmd, prefixArgs } | null — computed once per process

function _works(cmd, prefixArgs) {
  try {
    const r = spawnSync(cmd, [...prefixArgs, "--version"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function _venvPython() {
  const bin = process.platform === "win32"
    ? path.join("Scripts", "python.exe")
    : path.join("bin", "python");
  const roots = [];
  if (process.env.VIRTUAL_ENV) roots.push(process.env.VIRTUAL_ENV);
  // repoRoot = three levels up from apps/lantern-garage/lib
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  roots.push(path.join(repoRoot, ".venv"), path.join(repoRoot, ".venv-train"));
  for (const root of roots) {
    const p = path.join(root, bin);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/**
 * @returns {{cmd: string, prefixArgs: string[]} | null}
 */
function resolvePython() {
  if (_cached !== undefined) return _cached;

  // 1. Explicit override — trust it verbatim (the operator knows their setup).
  const override = process.env.PYTHON_PATH || process.env.PYTHON;
  if (override) { _cached = { cmd: override, prefixArgs: [] }; return _cached; }

  // 2–4. Probe candidates in priority order.
  const candidates = [];
  const venv = _venvPython();
  if (venv) candidates.push({ cmd: venv, prefixArgs: [] });
  candidates.push({ cmd: "python3", prefixArgs: [] });
  candidates.push({ cmd: "python", prefixArgs: [] });
  if (process.platform === "win32") candidates.push({ cmd: "py", prefixArgs: ["-3"] });

  for (const c of candidates) {
    if (_works(c.cmd, c.prefixArgs)) { _cached = c; return _cached; }
  }
  _cached = null; // nothing works
  return _cached;
}

/**
 * Build a full argv for spawning a python script: [cmd, ...prefixArgs, ...scriptArgs].
 * Returns null if no interpreter is available.
 * @param {string[]} scriptArgs
 * @returns {{cmd: string, args: string[]} | null}
 */
function pythonArgv(scriptArgs = []) {
  const py = resolvePython();
  if (!py) return null;
  return { cmd: py.cmd, args: [...py.prefixArgs, ...scriptArgs] };
}

/** Reset the cache — test-only. */
function _reset() { _cached = undefined; }

module.exports = { resolvePython, pythonArgv, _reset };
