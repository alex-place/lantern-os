"""
Superfleet Phase 3 — Sandboxed EXECUTOR worker.

Phase 0–2 made `task_run` an honest *proposal* generator: it routes a queued
Task through the local convergence/Σ₀ path and writes a Convergence Record +
PCSF receipt, but it never touches a repo. This module upgrades that last mile
into an *executor* — the Act → Verify → Converge tail of the loop described in
docs/SUPERFLEET-SWARM-DESIGN.md (Phase 3):

    Observe   claim a queued task (single-writer dispatch — no distributed claim)
    Remember  (carried by the caller's grounding evidence)
    Reason    local Σ₀-coder / convergence path plans the change
    Act       run the change inside a git worktree SANDBOX (auto-cleaned)
    Verify    py_compile / node --check / a bounded test command
    Converge  on success → commit + push a fix branch (NEVER auto-merge);
              on failure → record the failure PATTERN (learning signal)
              either way → emit a Convergence Record + PCSF receipt

Design constraints (from the doc's "Safety rails" + the repo's CLAUDE.md):

  * IN-HOUSE + LOCAL-FIRST ONLY. No cloud is load-bearing. The coder brain is a
    pluggable callable (`coder` arg) — by default the local convergence path.
  * BOUNDED + OPT-IN. The execute path is gated behind SUPERFLEET_EXECUTOR=1
    (off by default). With the flag off, `execute_task` refuses and points the
    caller back at the proposal path (`task_run`).
  * NEVER DESTRUCTIVE BY DEFAULT. All work happens in a throwaway worktree under
    a temp/sandbox root; the worktree is always removed in a finally block. The
    main checkout is never mutated. Push is to a NEW fix branch and we DO NOT
    merge — outward promotion still passes the auto-merge green gate elsewhere.
  * EVIDENCE-STAMPED. Every run emits a Convergence Record + PCSF receipt, same
    shape `task_run` already uses, so observability is uniform.

This module is intentionally free of FastAPI / server imports so it can be unit
tested and dry-run in isolation. The server wires `execute_task` into the tool
registry and passes its queue mutation callbacks in.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

# ── Gate / tunables (all env-overridable; safe, bounded defaults) ──────────────

ENV_FLAG = "SUPERFLEET_EXECUTOR"          # "1" enables the execute path
ENV_BRANCH_PREFIX = "SUPERFLEET_FIX_PREFIX"
ENV_PUSH = "SUPERFLEET_EXECUTOR_PUSH"     # "1" allows push; else commit-only (still safe)
ENV_REMOTE = "SUPERFLEET_EXECUTOR_REMOTE"
ENV_VERIFY_TIMEOUT = "SUPERFLEET_VERIFY_TIMEOUT_SEC"
ENV_CODER_TIMEOUT = "SUPERFLEET_CODER_TIMEOUT_SEC"
ENV_SANDBOX_ROOT = "SUPERFLEET_SANDBOX_ROOT"

DEFAULT_BRANCH_PREFIX = "superfleet/fix"
DEFAULT_REMOTE = "origin"
DEFAULT_VERIFY_TIMEOUT = 180
DEFAULT_CODER_TIMEOUT = 600

# LANTERN-DREAM rule: an unverified result is a proposal — confidence ≤ 0.3.
# Once the in-sandbox verification command passes, the change is grounded and we
# allow a higher (still bounded) executor confidence.
PROPOSAL_CONFIDENCE_CAP = 0.3
VERIFIED_EXECUTOR_CONFIDENCE = 0.7


def executor_enabled() -> bool:
    """True only when the operator has explicitly opted in. Off by default."""
    return os.getenv(ENV_FLAG, "").strip() in ("1", "true", "yes", "on")


def push_enabled() -> bool:
    """Push is a second opt-in on top of the execute gate (defaults to commit-only).

    Committing inside a throwaway worktree mutates nothing the operator keeps;
    pushing creates a remote branch, so it is gated separately. Both must be on
    for the executor to publish a fix branch.
    """
    return os.getenv(ENV_PUSH, "").strip() in ("1", "true", "yes", "on")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(text: str, limit: int = 40) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return (s[:limit] or "task").strip("-")


# ── Git helpers (thin, explicit, repo-scoped) ─────────────────────────────────


def _run(
    args: List[str],
    cwd: Optional[Path] = None,
    timeout: int = 60,
    env: Optional[Dict[str, str]] = None,
) -> Tuple[int, str, str]:
    """Run a subprocess, capturing output. Never raises on non-zero exit —
    returns (returncode, stdout, stderr) so the caller decides what a failure means."""
    try:
        proc = subprocess.run(
            args,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except subprocess.TimeoutExpired as exc:
        return 124, exc.stdout or "", f"timeout after {timeout}s"
    except FileNotFoundError as exc:
        return 127, "", str(exc)
    except Exception as exc:  # pragma: no cover - defensive
        return 1, "", str(exc)


def _git(repo: Path, *args: str, timeout: int = 60) -> Tuple[int, str, str]:
    return _run(["git", "-C", str(repo), *args], timeout=timeout)


def _detect_base_branch(repo: Path) -> str:
    """Best-effort base branch: the repo's current branch, else master/main."""
    code, out, _ = _git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    if code == 0 and out.strip() and out.strip() != "HEAD":
        return out.strip()
    for cand in ("master", "main"):
        code, _, _ = _git(repo, "rev-parse", "--verify", cand)
        if code == 0:
            return cand
    return "master"


# ── Verification command selection (in-house, language-aware) ─────────────────


def select_verification(repo: Path, changed: List[str]) -> List[List[str]]:
    """Pick bounded, in-house syntax/test checks for the changed files.

    Returns a list of argv commands to run *inside the sandbox*. Deliberately
    syntax-level by default (fast, deterministic, no network): py_compile for
    Python, `node --check` for JS. A caller may extend this, but the executor
    never invents a heavy/networked test command on its own.
    """
    py = [f for f in changed if f.endswith(".py")]
    js = [f for f in changed if f.endswith((".js", ".cjs", ".mjs"))]
    cmds: List[List[str]] = []
    if py:
        cmds.append(["python", "-m", "py_compile", *py])
    for f in js:
        cmds.append(["node", "--check", f])
    if not cmds:
        # Nothing language-specific to check — a no-op "true" keeps the flow
        # honest (verification ran, trivially passed) without faking a result.
        cmds.append(["python", "-c", "import sys; sys.exit(0)"])
    return cmds


def run_verification(
    sandbox: Path, changed: List[str], timeout: int
) -> Tuple[bool, List[Dict[str, Any]]]:
    """Run the selected checks inside the sandbox. Returns (all_passed, details)."""
    results: List[Dict[str, Any]] = []
    ok = True
    for cmd in select_verification(sandbox, changed):
        code, out, err = _run(cmd, cwd=sandbox, timeout=timeout)
        passed = code == 0
        ok = ok and passed
        results.append({
            "cmd": " ".join(cmd),
            "returncode": code,
            "passed": passed,
            "stderr": (err or "")[-600:],
        })
    return ok, results


# ── Default in-house coder shim ───────────────────────────────────────────────


def _default_coder(sandbox: Path, task: Dict[str, Any]) -> Dict[str, Any]:
    """Default coder used when the caller supplies none.

    The real Σ₀-coder / convergence-agent edits files inside `sandbox`. This shim
    is intentionally a NO-OP that makes no edits: it lets the full executor flow
    (claim → sandbox → verify → converge) run and be dry-run tested end-to-end
    WITHOUT a model and WITHOUT mutating anything. It returns the contract a real
    coder must return so the wiring is identical when a real coder is plugged in.

    A real coder callable receives (sandbox_path, task_dict) and must:
      * make its edits on disk under `sandbox`
      * return {"changed": [<relative paths>], "summary": str, "evidence": [...]}
    """
    return {
        "changed": [],
        "summary": "no-op coder (no model wired); executor flow exercised only",
        "evidence": [],
        "noop": True,
    }


CoderFn = Callable[[Path, Dict[str, Any]], Dict[str, Any]]


# ── The executor ──────────────────────────────────────────────────────────────


def execute_task(
    task: Dict[str, Any],
    repo_root: Path,
    *,
    coder: Optional[CoderFn] = None,
    append_record: Optional[Callable[[Dict[str, Any]], Any]] = None,
    append_receipt: Optional[Callable[[Dict[str, Any]], Any]] = None,
    record_failure: Optional[Callable[[Dict[str, Any]], Any]] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Run ONE task through the sandboxed Act → Verify → Converge tail.

    Parameters
    ----------
    task : the claimed Task dict ({"id", "description", ...}). The caller owns
        queue state transitions; this function does not mutate the live queue.
    repo_root : the repository the worktree is carved from.
    coder : callable(sandbox, task) -> {"changed", "summary", "evidence"}.
        Defaults to a no-op shim (safe for dry-runs / no-model environments).
    append_record / append_receipt / record_failure : sinks for the Convergence
        Record, PCSF receipt, and failure-pattern log. Defaulted to local JSONL
        appends under repo_root/data when not supplied.
    dry_run : when True, NEVER commits or pushes and NEVER touches the real repo
        beyond creating + removing a throwaway worktree. Proves the flow safely.

    Returns a structured result dict (never raises into the caller).
    """
    coder = coder or _default_coder
    repo_root = Path(repo_root)
    append_record = append_record or _make_jsonl_sink(repo_root / "data" / "convergence" / "records.jsonl")
    append_receipt = append_receipt or _make_jsonl_sink(repo_root / "data" / "pcsf" / "convergance-receipts.jsonl")
    record_failure = record_failure or _make_jsonl_sink(repo_root / "data" / "convergence" / "failure-patterns.jsonl")

    task_id = str(task.get("id") or uuid.uuid4().hex[:8])
    goal = str(task.get("description", "")).strip()
    started = datetime.now(timezone.utc)

    # ── Gate: opt-in only ──
    if not dry_run and not executor_enabled():
        return {
            "ok": False,
            "stage": "gate",
            "error": "executor_disabled",
            "task_id": task_id,
            "note": (
                f"Execute path is opt-in. Set {ENV_FLAG}=1 to enable. "
                "Default path is the proposal generator (task_run)."
            ),
        }

    base_branch = _detect_base_branch(repo_root)
    prefix = os.getenv(ENV_BRANCH_PREFIX, DEFAULT_BRANCH_PREFIX).rstrip("/")
    fix_branch = f"{prefix}/{task_id}-{_slug(goal)}"
    sandbox_root = Path(os.getenv(ENV_SANDBOX_ROOT, "") or tempfile.gettempdir())
    sandbox_root.mkdir(parents=True, exist_ok=True)
    sandbox = sandbox_root / f"superfleet-sandbox-{task_id}-{uuid.uuid4().hex[:6]}"

    verify_timeout = int(os.getenv(ENV_VERIFY_TIMEOUT, str(DEFAULT_VERIFY_TIMEOUT)))

    result: Dict[str, Any] = {
        "ok": False,
        "task_id": task_id,
        "stage": "init",
        "dry_run": dry_run,
        "base_branch": base_branch,
        "fix_branch": fix_branch,
        "sandbox": str(sandbox),
        "pushed": False,
        "committed": False,
        "verified": False,
    }
    log: List[str] = []

    try:
        # ── Act: create the throwaway worktree SANDBOX ──
        code, _, err = _git(
            repo_root, "worktree", "add", "-b", fix_branch, str(sandbox), base_branch, timeout=120
        )
        if code != 0:
            result.update(stage="sandbox", error="worktree_add_failed", detail=err.strip()[:400])
            _converge_fail(result, task, repo_root, started, record_failure, append_record, append_receipt, log)
            return result
        log.append(f"sandbox worktree on {fix_branch} <- {base_branch}")

        # ── Reason/Act: the coder makes the change inside the sandbox ──
        try:
            coder_out = coder(sandbox, task) or {}
        except Exception as exc:
            result.update(stage="coder", error="coder_raised", detail=str(exc)[:400])
            _converge_fail(result, task, repo_root, started, record_failure, append_record, append_receipt, log)
            return result

        changed_reported = [str(c) for c in (coder_out.get("changed") or [])]
        result["coder_summary"] = str(coder_out.get("summary", ""))[:500]
        result["coder_noop"] = bool(coder_out.get("noop"))

        # Ground "changed" in git's own view of the worktree (don't trust the coder blindly).
        code, status_out, _ = _git(sandbox, "status", "--porcelain")
        git_changed = [ln[3:].strip() for ln in status_out.splitlines() if ln.strip()]
        changed = git_changed or changed_reported
        result["changed"] = changed

        # ── Verify: bounded in-house syntax/test checks INSIDE the sandbox ──
        verified, verify_details = run_verification(sandbox, changed, verify_timeout)
        result["verify"] = verify_details
        result["verified"] = verified
        log.append(f"verify: {'PASS' if verified else 'FAIL'} ({len(verify_details)} checks)")

        if not changed:
            # Nothing to converge. Honest no-op (e.g. the default shim or a coder
            # that decided not to act). Not a failure pattern — just empty.
            result.update(
                ok=verified, stage="noop",
                note="coder produced no changes; nothing to commit/push",
            )
            confidence = PROPOSAL_CONFIDENCE_CAP if verified else 0.0
            _emit_records(
                result, task, repo_root, started, confidence,
                append_record, append_receipt, log, verified=verified,
            )
            return result

        if not verified:
            # Verification failed → record the FAILURE PATTERN (the learning signal).
            result.update(stage="verify", error="verification_failed")
            _converge_fail(result, task, repo_root, started, record_failure, append_record, append_receipt, log)
            return result

        # ── Converge: commit (and optionally push) the fix branch. NEVER merge. ──
        if dry_run:
            result.update(
                ok=True, stage="converge-dry-run", committed=False, pushed=False,
                note="dry-run: verified changes present; commit/push intentionally skipped",
            )
            _emit_records(
                result, task, repo_root, started, VERIFIED_EXECUTOR_CONFIDENCE,
                append_record, append_receipt, log, verified=True,
            )
            return result

        _git(sandbox, "add", "-A")
        commit_msg = _commit_message(task_id, goal, result)
        # Author identity for unattended runs (no global config dependence).
        cenv = os.environ.copy()
        cenv.setdefault("GIT_AUTHOR_NAME", "Superfleet Executor")
        cenv.setdefault("GIT_AUTHOR_EMAIL", "executor@lantern-os.local")
        cenv.setdefault("GIT_COMMITTER_NAME", "Superfleet Executor")
        cenv.setdefault("GIT_COMMITTER_EMAIL", "executor@lantern-os.local")
        ccode, _, cerr = _run(
            ["git", "-C", str(sandbox), "commit", "-m", commit_msg],
            timeout=60, env=cenv,
        )
        if ccode != 0:
            result.update(stage="commit", error="commit_failed", detail=cerr.strip()[:400])
            _converge_fail(result, task, repo_root, started, record_failure, append_record, append_receipt, log)
            return result
        result["committed"] = True
        code, sha, _ = _git(sandbox, "rev-parse", "HEAD")
        result["commit"] = sha.strip()[:12] if code == 0 else None
        log.append(f"committed {result['commit']}")

        # Push is a separate opt-in. We push the fix branch and DO NOT merge.
        if push_enabled():
            remote = os.getenv(ENV_REMOTE, DEFAULT_REMOTE)
            pcode, _, perr = _git(sandbox, "push", "-u", remote, fix_branch, timeout=120)
            if pcode != 0:
                # Push failure is non-fatal: the verified commit still exists on the
                # branch. Record it but don't treat the whole task as failed.
                result.update(push_error=perr.strip()[:400])
                log.append("push FAILED (commit retained on branch)")
            else:
                result["pushed"] = True
                log.append(f"pushed {fix_branch} -> {remote} (NOT merged)")
        else:
            log.append(f"push disabled ({ENV_PUSH}!=1); commit retained on branch")

        result.update(ok=True, stage="converge")
        _emit_records(
            result, task, repo_root, started, VERIFIED_EXECUTOR_CONFIDENCE,
            append_record, append_receipt, log, verified=True,
        )
        return result

    finally:
        # ── Sandbox auto-clean: ALWAYS remove the worktree. Keep the branch
        # (it carries the commit) but never leave the throwaway checkout around. ──
        try:
            _git(repo_root, "worktree", "remove", "--force", str(sandbox), timeout=60)
        except Exception:
            pass
        if sandbox.exists():
            shutil.rmtree(sandbox, ignore_errors=True)
        # Prune stale registrations regardless.
        _git(repo_root, "worktree", "prune")
        # If we never committed (failure/no-op/dry-run-with-no-publish) and we
        # created the branch, drop it so we don't litter dead branches. Keep it
        # only when a real commit was published or pushed.
        if not result.get("committed") and not result.get("pushed"):
            _git(repo_root, "branch", "-D", fix_branch)


# ── Converge helpers: records + receipts + failure patterns ───────────────────


def _commit_message(task_id: str, goal: str, result: Dict[str, Any]) -> str:
    title = (goal.splitlines()[0] if goal else "automated change")[:60]
    body = (
        f"Superfleet executor: verified change for task {task_id}.\n\n"
        f"Changed files: {', '.join(result.get('changed', [])) or '(none)'}\n"
        f"Verification: {sum(1 for v in result.get('verify', []) if v.get('passed'))}"
        f"/{len(result.get('verify', []))} checks passed.\n\n"
        "Proposal until reviewed — NOT auto-merged (passes the green-gate elsewhere)."
    )
    return f"fix(superfleet): {title}\n\n{body}"


def _make_jsonl_sink(path: Path) -> Callable[[Dict[str, Any]], bool]:
    def _sink(obj: Dict[str, Any]) -> bool:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(obj, default=str) + "\n")
            return True
        except Exception:
            return False
    return _sink


def _emit_records(
    result: Dict[str, Any],
    task: Dict[str, Any],
    repo_root: Path,
    started: datetime,
    confidence: float,
    append_record: Callable[[Dict[str, Any]], Any],
    append_receipt: Callable[[Dict[str, Any]], Any],
    log: List[str],
    *,
    verified: bool,
) -> None:
    """Emit a Convergence Record + PCSF receipt for a (non-failure) executor run."""
    latency_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    task_id = result.get("task_id")
    goal = str(task.get("description", ""))

    append_record({
        "timestamp": _now(),
        "surface": "mcp-execute-task",
        "hypothesis": goal[:280],
        "evidence_ids": result.get("changed", []),
        "result": result.get("coder_summary", "")[:2000],
        "confidence": confidence,
        "reasoner": "superfleet-executor",
        "verified": verified,
        "task_id": task_id,
        "fix_branch": result.get("fix_branch"),
        "commit": result.get("commit"),
        "pushed": result.get("pushed", False),
        "log": log,
    })
    append_receipt({
        "generatedAt": _now(),
        "profile": "kernel",
        "intent": "execute_task",
        "capacityClass": "local_model",
        "provider": "superfleet-executor",
        "metered": False,
        "privacyBoundary": "internal",
        "claimBoundary": "verified" if verified else "proposal",
        "latencyMs": latency_ms,
        "success": bool(result.get("ok")),
        "committed": result.get("committed", False),
        "pushed": result.get("pushed", False),
        "dryRun": result.get("dry_run", False),
        "verifyChecks": len(result.get("verify", [])),
        "task_id": task_id,
        "fix_branch": result.get("fix_branch"),
    })
    result["convergence_record"] = "data/convergence/records.jsonl"
    result["pcsf_receipt"] = "data/pcsf/convergance-receipts.jsonl"
    result["confidence"] = confidence
    result.setdefault("note", (
        "Verified change; NOT auto-merged (LANTERN-DREAM: proposal until reviewed)."
        if verified else "Unverified — proposal only (confidence capped)."
    ))


def _converge_fail(
    result: Dict[str, Any],
    task: Dict[str, Any],
    repo_root: Path,
    started: datetime,
    record_failure: Callable[[Dict[str, Any]], Any],
    append_record: Callable[[Dict[str, Any]], Any],
    append_receipt: Callable[[Dict[str, Any]], Any],
    log: List[str],
) -> None:
    """Failure path: record the failure PATTERN (learning) + a 0-confidence record."""
    latency_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    pattern = {
        "timestamp": _now(),
        "task_id": result.get("task_id"),
        "stage": result.get("stage"),
        "error": result.get("error"),
        "detail": result.get("detail"),
        "goal": str(task.get("description", ""))[:280],
        "verify": result.get("verify", []),
        "fix_branch": result.get("fix_branch"),
        "latencyMs": latency_ms,
    }
    record_failure(pattern)
    # Also emit a 0-confidence Convergence Record + receipt so the failure is
    # visible in the same evidence stream as successes.
    result["ok"] = False
    _emit_records(
        result, task, repo_root, started, 0.0,
        append_record, append_receipt, log, verified=False,
    )
    result["failure_pattern"] = "data/convergence/failure-patterns.jsonl"
