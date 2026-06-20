"""LOCAL DETERMINISTIC REPO-FIX RUNNER — the execution layer that makes the connector
a state machine instead of "a bunch of tools".

The LLM proposes; this layer validates and executes deterministically. Same issue type
should route to the same playbook, run in the same sandbox, pass the same gates, and
leave the same receipt — no improvisation in the control path.

HARD SAFETY RAILS (non-negotiable):
  - NEVER writes to or pushes a protected branch (master/main/dev/gh-pages).
  - All edits happen inside a per-task git worktree on a bot-owned branch (`mcp-local/<id>`).
  - Edits are scoped to allowed globs; forbidden paths (.env*, secrets, keys, private
    data, wallet) are refused outright.
  - Every applied diff is secret-scanned and forbidden-path-scanned before it lands.
  - local_test_run only runs allowlisted commands — no arbitrary shell.
  - Every action appends a receipt to data/convergence/patch-receipts.jsonl.

Tools exposed: local_repo_status, local_repo_search, local_file_read,
local_worktree_create, local_worktree_destroy, local_patch_apply, local_test_run,
recipe_list, recipe_run, worker_status, receipt_get.

Reference: deterministic local-repair protocol — issue → classify → recipe → worktree →
patch → tests → PR → receipt.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Configuration ────────────────────────────────────────────────────────────
REPO_ROOT = Path(os.environ.get("LANTERN_REPO_ROOT") or r"C:\dev\lantern-os")
WORKTREE_BASE = Path(os.environ.get("LANTERN_WORKTREE_BASE")
                     or str(REPO_ROOT.parent / "lantern-worktrees"))
RECEIPTS_PATH = REPO_ROOT / "data" / "convergence" / "patch-receipts.jsonl"
BOT_BRANCH_PREFIX = "mcp-local/"

# ── Safety constants ─────────────────────────────────────────────────────────
PROTECTED_BRANCHES = {"master", "main", "dev", "develop", "gh-pages"}

FORBIDDEN_GLOBS = [
    ".env", ".env.*", "**/.env", "**/.env.*",
    "secrets/**", "**/secrets/**",
    "data/private/**", "data/wallet/**", "data/profiles/**",
    "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa*",
]

# Targeted secret patterns (name, regex) — kept specific to avoid false positives.
_SECRET_PATTERNS = [
    ("anthropic_key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("brave_key", re.compile(r"\bBSA[A-Za-z0-9_\-]{20,}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
    ("private_key_block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("github_pat", re.compile(r"\bghp_[A-Za-z0-9]{30,}\b")),
    ("assigned_secret", re.compile(
        r"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}['\"]")),
]

# Allowlisted local_test_run command prefixes — read-only / test / lint only.
_TEST_ALLOWLIST = (
    "python -m pytest", "pytest",
    "node --check",
    "npm test", "npm run test", "npm run lint",
    "git diff --check",
    "ruff", "mypy", "make check",
)

MAX_OUTPUT = 6000  # tail size for captured command output


# ── low-level helpers ────────────────────────────────────────────────────────
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _git(args: List[str], cwd: Path, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cwd), *args],
                          capture_output=True, text=True, timeout=timeout)


def _repo(repo: str = "") -> Path:
    return Path(repo) if repo else REPO_ROOT


def _tail(text: str, n: int = MAX_OUTPUT) -> str:
    text = text or ""
    return text if len(text) <= n else "…(truncated)…\n" + text[-n:]


def _rel(path: str) -> str:
    p = path.replace("\\", "/")
    return p[2:] if p.startswith("./") else p  # strip a leading "./" only (keep dotfiles)


def _is_forbidden(rel_path: str) -> bool:
    rp = _rel(rel_path)
    return any(fnmatch.fnmatch(rp, g) or fnmatch.fnmatch(Path(rp).name, g)
               for g in FORBIDDEN_GLOBS)


def _scan_secrets(text: str) -> List[str]:
    return [name for name, pat in _SECRET_PATTERNS if pat.search(text or "")]


def _resolve_in_repo(path: str, root: Path) -> Optional[Path]:
    """Resolve `path` and ensure it stays inside `root` (no traversal)."""
    try:
        root_r = root.resolve()
        target = (root_r / path).resolve()
        target.relative_to(root_r)  # raises if outside
        return target
    except Exception:
        return None


def _safe_id(task_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", task_id or "")


def _worktree_path(task_id: str) -> Path:
    return WORKTREE_BASE / _safe_id(task_id)


def write_receipt(record: Dict[str, Any], path: Optional[Path] = None) -> None:
    path = path or RECEIPTS_PATH  # resolved at call time so the path stays overridable
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": _now(), **record}) + "\n")
    except Exception:
        pass


# ── Tools: read-only ─────────────────────────────────────────────────────────
def local_repo_status(repo: str = "") -> Dict[str, Any]:
    """Git status of the canonical local checkout: branch, sha, dirty files, ahead/behind.
    Read-only."""
    root = _repo(repo)
    try:
        branch = _git(["rev-parse", "--abbrev-ref", "HEAD"], root).stdout.strip()
        sha = _git(["rev-parse", "--short", "HEAD"], root).stdout.strip()
        porc = _git(["status", "--porcelain"], root).stdout.splitlines()
        dirty = [l[3:] for l in porc][:50]
        ab = _git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], root)
        ahead = behind = None
        if ab.returncode == 0 and ab.stdout.strip():
            parts = ab.stdout.split()
            if len(parts) == 2:
                ahead, behind = int(parts[0]), int(parts[1])
        return {"ok": True, "repo": str(root), "branch": branch, "sha": sha,
                "clean": len(porc) == 0, "dirty_count": len(porc), "dirty": dirty,
                "ahead": ahead, "behind": behind}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "repo": str(root)}


def local_repo_search(pattern: str, glob: str = "", max_results: int = 50,
                      repo: str = "") -> Dict[str, Any]:
    """Search the local checkout for a regex/string (ripgrep if available, else stdlib).
    Read-only. Optional `glob` filters filenames (e.g. '*.py')."""
    root = _repo(repo)
    results: List[Dict[str, Any]] = []
    rg = shutil.which("rg")
    try:
        if rg:
            args = [rg, "--line-number", "--no-heading", "--max-count", "5", "-e", pattern]
            if glob:
                args += ["--glob", glob]
            out = subprocess.run(args, cwd=str(root), capture_output=True, text=True, timeout=60)
            for line in out.stdout.splitlines()[:max_results]:
                m = re.match(r"^(.*?):(\d+):(.*)$", line)
                if m:
                    results.append({"file": _rel(m.group(1)), "line": int(m.group(2)),
                                    "text": m.group(3)[:200]})
        else:
            rx = re.compile(pattern)
            for p in root.rglob(glob or "*"):
                if not p.is_file() or ".git" in p.parts:
                    continue
                try:
                    for i, line in enumerate(p.read_text("utf-8", errors="ignore").splitlines(), 1):
                        if rx.search(line):
                            results.append({"file": _rel(str(p.relative_to(root))),
                                            "line": i, "text": line[:200]})
                            if len(results) >= max_results:
                                raise StopIteration
                except StopIteration:
                    break
                except Exception:
                    continue
        return {"ok": True, "pattern": pattern, "count": len(results), "results": results[:max_results]}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "pattern": pattern}


def local_file_read(path: str, repo: str = "", max_bytes: int = 20000) -> Dict[str, Any]:
    """Read a file from the local checkout. Refuses path traversal and forbidden paths
    (.env*, secrets, keys, private data)."""
    root = _repo(repo)
    if _is_forbidden(path):
        return {"ok": False, "error": f"forbidden path refused: {path}"}
    target = _resolve_in_repo(path, root)
    if target is None:
        return {"ok": False, "error": f"path escapes repo root: {path}"}
    if not target.is_file():
        return {"ok": False, "error": f"not a file: {path}"}
    try:
        raw = target.read_bytes()
        truncated = len(raw) > max_bytes
        text = raw[:max_bytes].decode("utf-8", errors="replace")
        return {"ok": True, "path": _rel(path), "truncated": truncated,
                "bytes": len(raw), "content": text}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "path": path}


# ── Tools: worktree sandbox ──────────────────────────────────────────────────
def local_worktree_create(task_id: str = "", base: str = "master", repo: str = "") -> Dict[str, Any]:
    """Create an isolated git worktree on a bot-owned branch (mcp-local/<task_id>) off
    `base`. This is the only place edits are allowed — never the live working tree."""
    root = _repo(repo)
    task_id = _safe_id(task_id) or f"t{datetime.now(timezone.utc).strftime('%H%M%S')}"
    wt = _worktree_path(task_id)
    branch = f"{BOT_BRANCH_PREFIX}{task_id}"
    try:
        WORKTREE_BASE.mkdir(parents=True, exist_ok=True)
        if wt.exists():
            return {"ok": False, "error": "worktree already exists", "task_id": task_id,
                    "worktree": str(wt)}
        _git(["fetch", "origin", base], root)  # best-effort
        # Prefer origin/<base> so we branch off the canonical tip, not a stale local ref.
        start = f"origin/{base}"
        if _git(["rev-parse", "--verify", start], root).returncode != 0:
            start = base
        res = _git(["worktree", "add", "-b", branch, str(wt), start], root)
        if res.returncode != 0:
            return {"ok": False, "error": res.stderr.strip() or "worktree add failed",
                    "task_id": task_id}
        base_sha = _git(["rev-parse", "--short", "HEAD"], wt).stdout.strip()
        write_receipt({"event": "worktree_create", "task_id": task_id, "branch": branch,
                       "base": base, "base_sha": base_sha, "worktree": str(wt)})
        return {"ok": True, "task_id": task_id, "worktree": str(wt), "branch": branch,
                "base": base, "base_sha": base_sha}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "task_id": task_id}


def local_worktree_destroy(task_id: str) -> Dict[str, Any]:
    """Remove a task worktree and its bot branch."""
    root = _repo()
    wt = _worktree_path(task_id)
    branch = f"{BOT_BRANCH_PREFIX}{_safe_id(task_id)}"
    try:
        _git(["worktree", "remove", "--force", str(wt)], root)
        _git(["branch", "-D", branch], root)
        write_receipt({"event": "worktree_destroy", "task_id": task_id, "branch": branch})
        return {"ok": True, "task_id": task_id, "removed": str(wt)}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "task_id": task_id}


def _worktree_branch(wt: Path) -> str:
    return _git(["rev-parse", "--abbrev-ref", "HEAD"], wt).stdout.strip()


# ── Tools: deterministic patch + test gates ──────────────────────────────────
def _diff_target_files(patch: str) -> List[str]:
    files = set()
    for line in patch.splitlines():
        if line.startswith("+++ ") or line.startswith("--- "):
            p = line[4:].strip()
            if p in ("/dev/null", ""):
                continue
            files.add(_rel(re.sub(r"^[ab]/", "", p)))
        elif line.startswith("diff --git "):
            m = re.search(r" b/(\S+)", line)
            if m:
                files.add(_rel(m.group(1)))
    return sorted(files)


def local_patch_apply(task_id: str, patch: str, allowed_globs: str = "") -> Dict[str, Any]:
    """Apply a unified diff inside the task's worktree, after deterministic safety checks:
    target files must not be forbidden, must match `allowed_globs` (comma-separated, if
    given), and the added lines must contain no secrets. Never touches a protected branch."""
    wt = _worktree_path(task_id)
    if not wt.exists():
        return {"ok": False, "error": "no worktree for task; call local_worktree_create first",
                "task_id": task_id}
    branch = _worktree_branch(wt)
    if branch in PROTECTED_BRANCHES or not branch.startswith(BOT_BRANCH_PREFIX):
        return {"ok": False, "error": f"refusing to patch protected/non-bot branch '{branch}'"}

    targets = _diff_target_files(patch)
    globs = [g.strip() for g in allowed_globs.split(",") if g.strip()]
    rejected: List[Dict[str, str]] = []
    for f in targets:
        if _is_forbidden(f):
            rejected.append({"file": f, "reason": "forbidden path"})
        elif globs and not any(fnmatch.fnmatch(f, g) for g in globs):
            rejected.append({"file": f, "reason": f"outside allowed_globs {globs}"})

    added = "\n".join(l[1:] for l in patch.splitlines()
                      if l.startswith("+") and not l.startswith("+++"))
    secrets = _scan_secrets(added)
    if secrets:
        rejected.append({"file": "*", "reason": f"secret detected: {secrets}"})

    if rejected:
        write_receipt({"event": "patch_rejected", "task_id": task_id, "branch": branch,
                       "targets": targets, "rejected": rejected})
        return {"ok": False, "applied": False, "task_id": task_id, "targets": targets,
                "rejected": rejected}

    # git apply --check then apply
    check = subprocess.run(["git", "-C", str(wt), "apply", "--check", "--whitespace=nowarn", "-"],
                           input=patch, capture_output=True, text=True, timeout=60)
    if check.returncode != 0:
        return {"ok": False, "applied": False, "task_id": task_id, "targets": targets,
                "error": "git apply --check failed: " + _tail(check.stderr, 800)}
    apply = subprocess.run(["git", "-C", str(wt), "apply", "--whitespace=nowarn", "-"],
                           input=patch, capture_output=True, text=True, timeout=60)
    ok = apply.returncode == 0
    write_receipt({"event": "patch_apply", "task_id": task_id, "branch": branch,
                   "files_changed": targets, "applied": ok})
    return {"ok": ok, "applied": ok, "task_id": task_id, "files_changed": targets,
            "error": None if ok else _tail(apply.stderr, 800)}


def local_test_run(command: str, task_id: str = "", timeout: int = 600,
                   repo: str = "") -> Dict[str, Any]:
    """Run an ALLOWLISTED test/lint command (pytest, node --check, npm test/lint, ruff,
    mypy, git diff --check). Runs in the task worktree if task_id given, else the repo.
    Arbitrary shell is refused."""
    cmd = (command or "").strip()
    if not any(cmd == p or cmd.startswith(p + " ") for p in _TEST_ALLOWLIST):
        return {"ok": False, "error": f"command not allowlisted: {cmd!r}",
                "allowlist": list(_TEST_ALLOWLIST)}
    if task_id:
        cwd = _worktree_path(task_id)
        if not cwd.exists():
            return {"ok": False, "error": "no worktree for task", "task_id": task_id}
    else:
        cwd = _repo(repo)
    try:
        proc = subprocess.run(cmd, shell=True, cwd=str(cwd), capture_output=True,
                              text=True, timeout=timeout)
        write_receipt({"event": "test_run", "task_id": task_id, "command": cmd,
                       "exit_code": proc.returncode})
        return {"ok": proc.returncode == 0, "exit_code": proc.returncode, "command": cmd,
                "cwd": str(cwd), "stdout_tail": _tail(proc.stdout, 3000),
                "stderr_tail": _tail(proc.stderr, 2000)}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"timeout after {timeout}s", "command": cmd}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "command": cmd}


# ── Tools: deterministic recipes ─────────────────────────────────────────────
# Each recipe is a fixed contract: what to observe, where edits are allowed, which tests
# must pass, what is forbidden, and the done-criteria. The LLM fills the patch; the
# contract is fixed so the same issue class always routes the same way.
RECIPES: Dict[str, Dict[str, Any]] = {
    "failed_check": {
        "observe": ["github_pr_status", "github_get_job_logs", "local_repo_search"],
        "allowed_edits": ["src/**", "apps/**", "tests/**", "scripts/**"],
        "required_tests": ["python -m pytest", "node --check"],
        "forbidden_actions": ["push master", "merge", "edit .env*", "edit secrets/**"],
        "done_when": ["failing check now green", "diff within allowed_edits", "receipt written"],
    },
    "merge_conflict": {
        "observe": ["github_pr_status", "local_repo_status"],
        "allowed_edits": ["<conflicted files only>"],
        "required_tests": ["python -m pytest", "git diff --check"],
        "forbidden_actions": ["push master", "force-push protected", "resolve outside conflict files"],
        "done_when": ["no conflict markers", "tests pass", "pushed to bot branch only"],
    },
    "slop_debug_statement": {
        "observe": ["local_repo_search:console.log|print(", "git diff --check"],
        "allowed_edits": ["<files flagged by slop check>"],
        "required_tests": ["node --check", "git diff --check"],
        "forbidden_actions": ["push master", "touch unrelated files"],
        "done_when": ["debug statements removed", "slop gate green"],
    },
    "anti_sprawl": {
        "observe": ["local_repo_status", "local_repo_search"],
        "allowed_edits": ["<new files only; no duplicates of existing modules>"],
        "required_tests": ["python -m pytest"],
        "forbidden_actions": ["create parallel implementation", "push master"],
        "done_when": ["extends existing module", "no duplicate file", "receipt written"],
    },
    "single_workstream": {
        "observe": ["github_list_pull_requests", "github_pr_status"],
        "allowed_edits": [],
        "required_tests": [],
        "forbidden_actions": ["open second lane PR before first merges", "push master"],
        "done_when": ["only one open PR per agent lane"],
    },
    "docs_anchor": {
        "observe": ["local_repo_search", "local_file_read"],
        "allowed_edits": ["docs/**", "*.md", "README.md"],
        "required_tests": ["git diff --check"],
        "forbidden_actions": ["push master", "edit code paths"],
        "done_when": ["anchor/link fixed", "diff docs-only"],
    },
    "missing_env_doc": {
        "observe": ["local_repo_search:os.environ|getenv", "local_file_read:.env.example"],
        "allowed_edits": [".env.example", "docs/**", "README.md"],
        "required_tests": ["git diff --check"],
        "forbidden_actions": ["commit real secrets", "edit .env.local", "push master"],
        "done_when": ["env var documented in .env.example", "no real secret committed"],
    },
    "role_rename": {
        "observe": ["local_repo_search:<old name>", "local_repo_status"],
        "allowed_edits": ["src/**", "apps/**", "docs/**", "tests/**"],
        "required_tests": ["python -m pytest", "node --check"],
        "forbidden_actions": ["push master", "rename across forbidden paths"],
        "done_when": ["all references renamed", "tests pass", "diff within scope"],
    },
}


def recipe_list() -> Dict[str, Any]:
    """List the deterministic repair recipes (fixed playbooks per issue class)."""
    return {"ok": True, "count": len(RECIPES),
            "recipes": {k: {"forbidden_actions": v["forbidden_actions"],
                            "required_tests": v["required_tests"]} for k, v in RECIPES.items()}}


def recipe_run(recipe: str, issue: str = "", task_id: str = "") -> Dict[str, Any]:
    """Return the deterministic contract + execution plan for a recipe. This is the router:
    it hands the fixed contract (observe/allowed_edits/required_tests/forbidden/done_when)
    and the exact next-tool sequence to the caller. Edits still flow through
    local_patch_apply (validated) and local_test_run (gated) — the contract is the boss."""
    spec = RECIPES.get(recipe)
    if not spec:
        return {"ok": False, "error": f"unknown recipe '{recipe}'",
                "available": list(RECIPES.keys())}
    plan = [
        "local_worktree_create(task_id, base='master')",
        f"observe: {spec['observe']}",
        "LLM proposes unified-diff patch within allowed_edits",
        "local_patch_apply(task_id, patch, allowed_globs=<allowed_edits>)",
        f"local_test_run for each of {spec['required_tests']} (task_id)",
        "if green + diff in scope: open stacked fix PR (github_create_pull_request) to bot branch",
        "else: local_worktree_destroy(task_id) + safe report",
        "receipt_get(task_id)",
    ]
    return {"ok": True, "recipe": recipe, "issue": issue, "task_id": task_id,
            "contract": spec, "execution_plan": plan, "requires_human": recipe == "single_workstream"}


# ── Tools: worker status + receipts ──────────────────────────────────────────
def worker_status() -> Dict[str, Any]:
    """Report the local runner state: repo root, active task worktrees, receipt count."""
    root = _repo()
    worktrees: List[Dict[str, str]] = []
    try:
        out = _git(["worktree", "list", "--porcelain"], root).stdout
        cur: Dict[str, str] = {}
        for line in out.splitlines():
            if line.startswith("worktree "):
                cur = {"path": line[len("worktree "):]}
            elif line.startswith("branch "):
                cur["branch"] = line[len("branch "):].replace("refs/heads/", "")
                if cur.get("branch", "").startswith(BOT_BRANCH_PREFIX):
                    worktrees.append(cur)
    except Exception:
        pass
    receipts = 0
    try:
        if RECEIPTS_PATH.exists():
            receipts = sum(1 for _ in open(RECEIPTS_PATH, encoding="utf-8"))
    except Exception:
        pass
    return {"ok": True, "repo": str(root), "worktree_base": str(WORKTREE_BASE),
            "active_task_worktrees": worktrees, "receipt_count": receipts,
            "recipes": len(RECIPES)}


def receipt_get(task_id: str) -> Dict[str, Any]:
    """Fetch all receipts for a task id (the replay/audit trail)."""
    out: List[Dict[str, Any]] = []
    try:
        if RECEIPTS_PATH.exists():
            for line in open(RECEIPTS_PATH, encoding="utf-8"):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("task_id") == task_id:
                    out.append(rec)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "task_id": task_id}
    return {"ok": True, "task_id": task_id, "count": len(out), "receipts": out}


# ── Registration (mirrors github_tools.register) ─────────────────────────────
LOCAL_TOOLS = {
    "local_repo_status": local_repo_status,
    "local_repo_search": local_repo_search,
    "local_file_read": local_file_read,
    "local_worktree_create": local_worktree_create,
    "local_worktree_destroy": local_worktree_destroy,
    "local_patch_apply": local_patch_apply,
    "local_test_run": local_test_run,
    "recipe_list": recipe_list,
    "recipe_run": recipe_run,
    "worker_status": worker_status,
    "receipt_get": receipt_get,
}

INT_PARAMS = {"max_results", "max_bytes", "timeout"}


def register(registry: Dict[str, Any]) -> List[str]:
    """Merge the local-runner tools into an MCP TOOLS_REGISTRY. Returns names added."""
    registry.update(LOCAL_TOOLS)
    return list(LOCAL_TOOLS.keys())
