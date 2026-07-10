"""
Local git workflow tools for the Lantern OS MCP server.

Gives agents step-by-step control over the local repo without shell access:
  status → create_branch → stage_files → commit → push → open_pr

Ported from the gm-agent-orchestrator legacy MCP (Start-OrchMcpServer.GitWorkflowTools.ps1)
and adapted to Python + the lantern-os safety model.

SAFETY MODEL
------------
- All mutation tools (create_branch, stage, commit, push, open_pr) default to
  dry_run="true" and must be explicitly set to dry_run="false" to write.
- Mutations that touch master/main are hard-refused regardless of dry_run.
- stage_files only accepts repo-relative paths — no absolute paths, no globs,
  no path traversal (../). Each path is resolved and confirmed inside REPO_ROOT.
- WRITE_ENABLED mirrors github_tools.WRITE_ENABLED (GITHUB_WRITE_ENABLED env var).
  Set GITHUB_WRITE_ENABLED=0 to make the entire MCP read-only.

All functions return JSON-serialisable dicts. Errors are {"error": "..."}.
"""

import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]

WRITE_ENABLED = os.getenv("GITHUB_WRITE_ENABLED", "1") not in ("0", "false", "False", "")

_PROTECTED_BRANCHES = {"master", "main", "dev", "production", "release"}


class _GitError(Exception):
    pass


def _git(args: List[str], cwd: Optional[Path] = None, timeout: int = 30) -> str:
    cwd = cwd or REPO_ROOT
    try:
        proc = subprocess.run(
            ["git", *args],
            capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            cwd=str(cwd), timeout=timeout,
        )
    except FileNotFoundError:
        raise _GitError("git not found on PATH")
    except subprocess.TimeoutExpired:
        raise _GitError(f"git timed out after {timeout}s: {' '.join(args[:3])}")
    if proc.returncode != 0:
        raise _GitError((proc.stderr or proc.stdout or "").strip() or f"git exited {proc.returncode}")
    return proc.stdout.strip()


def _gh(args: List[str], timeout: int = 45) -> str:
    import shutil
    gh = shutil.which("gh.exe") or shutil.which("gh") or "gh"
    try:
        proc = subprocess.run(
            [gh, *args],
            capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            cwd=str(REPO_ROOT), timeout=timeout,
        )
    except FileNotFoundError:
        raise _GitError("gh CLI not found")
    except subprocess.TimeoutExpired:
        raise _GitError(f"gh timed out: {' '.join(args[:3])}")
    if proc.returncode != 0:
        raise _GitError((proc.stderr or proc.stdout or "").strip())
    return proc.stdout.strip()


def _require_write(action: str) -> Optional[Dict[str, Any]]:
    if not WRITE_ENABLED:
        return {"error": f"Write disabled: '{action}' blocked (GITHUB_WRITE_ENABLED=0)."}
    return None


def _refuse_protected(branch: str, action: str) -> Optional[Dict[str, Any]]:
    if branch.lower() in _PROTECTED_BRANCHES:
        return {"error": f"Refused: '{action}' targets protected branch '{branch}'. Use a feature branch."}
    return None


def _safe_paths(paths: List[str]) -> Optional[Dict[str, Any]]:
    """Validate that all paths are repo-relative, non-traversing, and within REPO_ROOT."""
    for p in paths:
        if os.path.isabs(p):
            return {"error": f"Refused: absolute path '{p}'. Use repo-relative paths only."}
        if ".." in Path(p).parts:
            return {"error": f"Refused: path traversal in '{p}'."}
        resolved = (REPO_ROOT / p).resolve()
        try:
            resolved.relative_to(REPO_ROOT.resolve())
        except ValueError:
            return {"error": f"Refused: '{p}' escapes the repository root."}
        if re.search(r"[*?\[\]{}]", p):
            return {"error": f"Refused: glob patterns not allowed in path '{p}'."}
    return None


def _err(exc: Exception) -> Dict[str, Any]:
    return {"error": str(exc)}


# ─────────────────────── Status & Inspection ────────────────────────────────

def local_git_status() -> Dict[str, Any]:
    """Current branch, modified/staged/untracked file counts, ahead/behind remote,
    and a risk assessment (low/medium/high) for mutation operations."""
    try:
        branch = _git(["rev-parse", "--abbrev-ref", "HEAD"])
        status_lines = _git(["status", "--porcelain"]).splitlines()
        staged    = [l[3:] for l in status_lines if l and l[0] in "MARCDT"]
        modified  = [l[3:] for l in status_lines if l and l[1] in "MD"]
        untracked = [l[3:] for l in status_lines if l.startswith("??")]

        ahead = behind = 0
        try:
            ab = _git(["rev-list", "--left-right", "--count", f"HEAD...@{{u}}"])
            parts = ab.split()
            if len(parts) == 2:
                ahead, behind = int(parts[0]), int(parts[1])
        except _GitError:
            pass  # no upstream set

        protected = branch.lower() in _PROTECTED_BRANCHES
        if protected:
            risk = "high"
        elif behind > 5 or len(staged) > 20:
            risk = "medium"
        else:
            risk = "low"

        return {
            "branch": branch,
            "protected": protected,
            "staged": staged,
            "modified": modified,
            "untracked": untracked,
            "ahead": ahead,
            "behind": behind,
            "risk": risk,
            "repo_root": str(REPO_ROOT),
        }
    except Exception as exc:
        return _err(exc)


def local_worktree_risk() -> Dict[str, Any]:
    """Git status + risk level summary for safe mutation decisions.

    Returns risk: low | medium | high with a human-readable reason.
    High = protected branch or large pending changes.
    Medium = behind remote or many staged files.
    Low = clean feature branch."""
    status = local_git_status()
    if "error" in status:
        return status
    reasons = []
    if status["protected"]:
        reasons.append(f"on protected branch '{status['branch']}'")
    if status["behind"] > 0:
        reasons.append(f"{status['behind']} commits behind remote")
    if len(status["staged"]) > 10:
        reasons.append(f"{len(status['staged'])} staged files")
    if len(status["modified"]) > 20:
        reasons.append(f"{len(status['modified'])} modified files")
    reason = "; ".join(reasons) if reasons else "clean feature branch"
    return {
        "branch": status["branch"],
        "risk": status["risk"],
        "reason": reason,
        "ahead": status["ahead"],
        "behind": status["behind"],
        "staged_count": len(status["staged"]),
        "modified_count": len(status["modified"]),
    }


# ─────────────────────── Mutation Tools ─────────────────────────────────────

def local_git_create_branch(branch: str, from_ref: str = "", dry_run: str = "true") -> Dict[str, Any]:
    """Create and checkout a new feature branch.

    branch: name for the new branch (refused if it matches master/main/dev/production/release).
    from_ref: base ref/SHA (default: current HEAD).
    dry_run: 'true' (default) just validates; 'false' creates the branch.
    """
    blocked = _require_write("local_git_create_branch")
    if blocked:
        return blocked
    refused = _refuse_protected(branch, "create_branch")
    if refused:
        return refused
    if not branch or not re.match(r"^[a-zA-Z0-9/_.-]+$", branch):
        return {"error": f"Invalid branch name '{branch}'"}
    plan = {"branch": branch, "from_ref": from_ref or "HEAD", "dry_run": dry_run == "true"}
    if dry_run != "false":
        return {"dry_run": True, "plan": plan, "note": "Pass dry_run='false' to execute."}
    try:
        args = ["checkout", "-b", branch]
        if from_ref:
            args.append(from_ref)
        _git(args)
        return {"ok": True, "branch": branch, "from_ref": from_ref or "HEAD"}
    except Exception as exc:
        return _err(exc)


def local_git_stage_files(paths: str, dry_run: str = "true") -> Dict[str, Any]:
    """Stage specific repo-relative file paths for the next commit.

    paths: comma-separated repo-relative paths (e.g. 'src/foo.py,README.md').
    Absolute paths, globs, and path traversal (../) are refused.
    dry_run: 'true' (default) just validates; 'false' stages the files.
    """
    blocked = _require_write("local_git_stage_files")
    if blocked:
        return blocked
    path_list = [p.strip() for p in str(paths).split(",") if p.strip()]
    if not path_list:
        return {"error": "No paths provided"}
    safety = _safe_paths(path_list)
    if safety:
        return safety
    # Check files exist
    missing = [p for p in path_list if not (REPO_ROOT / p).exists()]
    if missing:
        return {"error": f"Files not found: {missing}"}
    plan = {"paths": path_list, "dry_run": dry_run == "true"}
    if dry_run != "false":
        return {"dry_run": True, "plan": plan, "note": "Pass dry_run='false' to stage."}
    try:
        _git(["add", "--"] + path_list)
        return {"ok": True, "staged": path_list}
    except Exception as exc:
        return _err(exc)


def local_git_commit(message: str, dry_run: str = "true") -> Dict[str, Any]:
    """Commit currently staged files.

    Refused on master/main/dev/production/release.
    dry_run: 'true' (default) shows what would be committed; 'false' commits.
    """
    blocked = _require_write("local_git_commit")
    if blocked:
        return blocked
    if not message or len(message.strip()) < 8:
        return {"error": "Commit message too short (minimum 8 chars)"}
    try:
        branch = _git(["rev-parse", "--abbrev-ref", "HEAD"])
    except Exception as exc:
        return _err(exc)
    refused = _refuse_protected(branch, "commit")
    if refused:
        return refused
    # Check staged files
    try:
        staged_out = _git(["diff", "--name-only", "--cached"])
        staged = [l for l in staged_out.splitlines() if l]
    except Exception as exc:
        return _err(exc)
    if not staged:
        return {"error": "Nothing staged to commit"}
    plan = {"branch": branch, "message": message, "staged": staged, "dry_run": dry_run == "true"}
    if dry_run != "false":
        return {"dry_run": True, "plan": plan, "note": "Pass dry_run='false' to commit."}
    try:
        env = os.environ.copy()
        env.setdefault("GIT_AUTHOR_NAME", "unisona.ai MCP")
        env.setdefault("GIT_AUTHOR_EMAIL", "mcp@keystone.local")
        env.setdefault("GIT_COMMITTER_NAME", "unisona.ai MCP")
        env.setdefault("GIT_COMMITTER_EMAIL", "mcp@keystone.local")
        proc = subprocess.run(
            ["git", "commit", "-m", message],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=str(REPO_ROOT), env=env, timeout=30,
        )
        if proc.returncode != 0:
            raise _GitError((proc.stderr or proc.stdout or "").strip())
        sha_line = [l for l in proc.stdout.splitlines() if l.strip().startswith("[")]
        return {"ok": True, "branch": branch, "message": message,
                "committed": staged, "output": sha_line[0] if sha_line else proc.stdout.strip()}
    except Exception as exc:
        return _err(exc)


def local_git_push(remote: str = "origin", set_upstream: str = "true",
                   dry_run: str = "true") -> Dict[str, Any]:
    """Push the current branch to remote.

    Refused on master/main/dev/production/release.
    set_upstream: 'true' (default) passes -u to set tracking.
    dry_run: 'true' (default) shows what would be pushed; 'false' pushes.
    """
    blocked = _require_write("local_git_push")
    if blocked:
        return blocked
    try:
        branch = _git(["rev-parse", "--abbrev-ref", "HEAD"])
    except Exception as exc:
        return _err(exc)
    refused = _refuse_protected(branch, "push")
    if refused:
        return refused
    plan = {"branch": branch, "remote": remote, "set_upstream": set_upstream == "true",
            "dry_run": dry_run == "true"}
    if dry_run != "false":
        return {"dry_run": True, "plan": plan, "note": "Pass dry_run='false' to push."}
    try:
        args = ["push", remote, branch]
        if set_upstream == "true":
            args = ["push", "-u", remote, branch]
        _git(args)
        return {"ok": True, "branch": branch, "remote": remote}
    except Exception as exc:
        return _err(exc)


def local_git_open_pr(title: str, body: str = "", base: str = "master",
                      draft: str = "false", dry_run: str = "true") -> Dict[str, Any]:
    """Open a GitHub pull request for the current branch via the gh CLI.

    base: target branch (default master). Current branch is the head.
    draft: 'true' opens as a draft PR.
    dry_run: 'true' (default) shows the plan; 'false' opens the PR.
    """
    blocked = _require_write("local_git_open_pr")
    if blocked:
        return blocked
    if not title:
        return {"error": "PR title is required"}
    try:
        branch = _git(["rev-parse", "--abbrev-ref", "HEAD"])
    except Exception as exc:
        return _err(exc)
    if branch.lower() == base.lower():
        return {"error": f"Head branch '{branch}' equals base '{base}'. Check out a feature branch first."}
    plan = {"head": branch, "base": base, "title": title, "draft": draft == "true",
            "dry_run": dry_run == "true"}
    if dry_run != "false":
        return {"dry_run": True, "plan": plan, "note": "Pass dry_run='false' to open the PR."}
    try:
        args = ["pr", "create", "--title", title, "--base", base, "--head", branch]
        if body:
            args += ["--body", body]
        if draft == "true":
            args.append("--draft")
        out = _gh(args)
        url = next((l for l in out.splitlines() if l.startswith("http")), out)
        return {"ok": True, "url": url, "head": branch, "base": base, "title": title}
    except Exception as exc:
        return _err(exc)


# ─────────────────────── Service & Health ────────────────────────────────────

def local_server_status() -> Dict[str, Any]:
    """Check which local unisona.ai servers are up (ports 4177, 4178, 8771)
    and return the MCP server's own uptime."""
    import socket
    import time

    def _probe(port: int) -> bool:
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=0.5)
            s.close()
            return True
        except OSError:
            return False

    ports = {
        "stable_4177": _probe(4177),
        "dev_4178":    _probe(4178),
        "mcp_8771":    _probe(8771),
        "bridge_8788": _probe(8788),
        "ouro_11434":  _probe(11434),
    }

    try:
        import psutil
        node_procs = [p.info for p in psutil.process_iter(["name", "pid", "create_time"])
                      if "node" in (p.info.get("name") or "").lower()]
    except ImportError:
        node_procs = []

    return {
        "ports": ports,
        "node_processes": len(node_procs),
        "repo_root": str(REPO_ROOT),
    }


def get_tunnel_canary() -> Dict[str, Any]:
    """Probe the MCP tunnel endpoint (mcp.lantern-os.net) via a lightweight
    tools/list call to confirm end-to-end tunnel health.

    Returns ok=True with latency_ms if reachable, error otherwise.
    Read-only — never mutates anything."""
    import urllib.request
    import json
    import time

    url = "https://mcp.lantern-os.net/messages"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).encode()
    start = time.monotonic()
    try:
        req = urllib.request.Request(url, data=body,
                                     headers={"Content-Type": "application/json"},
                                     method="POST")
        with urllib.request.urlopen(req, timeout=8) as resp:
            elapsed = round((time.monotonic() - start) * 1000)
            payload = json.loads(resp.read())
            tool_count = len(payload.get("result", {}).get("tools", []))
            return {"ok": True, "latency_ms": elapsed, "tool_count": tool_count,
                    "endpoint": url}
    except Exception as exc:
        elapsed = round((time.monotonic() - start) * 1000)
        return {"ok": False, "error": str(exc), "latency_ms": elapsed, "endpoint": url}


def get_recent_task_failures(limit: int = 10) -> Dict[str, Any]:
    """Return the most recent failed/cancelled tasks from the queue ledger.

    Reads data/queue/ledger.jsonl (or equivalent) for status=failed|cancelled events.
    limit: max records to return (default 10)."""
    import json

    ledger_candidates = [
        REPO_ROOT / "data" / "queue" / "ledger.jsonl",
        REPO_ROOT / "data" / "queue.jsonl",
        REPO_ROOT / "data" / "keystone-queue.jsonl",
    ]
    ledger = next((p for p in ledger_candidates if p.exists()), None)
    if not ledger:
        return {"failures": [], "note": "No queue ledger found"}

    failures = []
    try:
        with open(ledger, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                status = ev.get("status") or ev.get("task", {}).get("status", "")
                if status in ("failed", "cancelled"):
                    task = ev.get("task", ev)
                    failures.append({
                        "task_id": task.get("id") or task.get("task_id"),
                        "description": (task.get("description") or "")[:200],
                        "status": status,
                        "ts": ev.get("ts"),
                        "error": task.get("error") or task.get("last_error"),
                    })
    except Exception as exc:
        return {"error": str(exc)}

    return {"failures": failures[-limit:], "total_in_ledger": len(failures)}


# ─────────────────────── Registration ────────────────────────────────────────

LOCAL_GIT_TOOLS: Dict[str, Any] = {
    # status
    "local_git_status":         local_git_status,
    "local_worktree_risk":      local_worktree_risk,
    # mutations (all default dry_run=true)
    "local_git_create_branch":  local_git_create_branch,
    "local_git_stage_files":    local_git_stage_files,
    "local_git_commit":         local_git_commit,
    "local_git_push":           local_git_push,
    "local_git_open_pr":        local_git_open_pr,
    # service & health
    "local_server_status":      local_server_status,
    "get_tunnel_canary":        get_tunnel_canary,
    "get_recent_task_failures": get_recent_task_failures,
}

INT_PARAMS = {"limit"}


def register(registry: Dict[str, Any]) -> List[str]:
    """Merge local git + service tools into an existing MCP TOOLS_REGISTRY."""
    registry.update(LOCAL_GIT_TOOLS)
    return list(LOCAL_GIT_TOOLS.keys())
