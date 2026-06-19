"""
Convergence / workflow-level MCP tools — the !convergance + PR-work backbone.

These are *workflow* tools, not raw GitHub tools: they orchestrate the existing
github_* read tools + the task queue into first-class actions, so a client no
longer has to hand-chain 8–15 raw calls.

First patch (this file):
  - convergence_run    : real backend for !convergance (Observe→Reason→Act→Verify→Converge)
  - github_triage_prs  : ranked PR queue (ready / blocked / conflicting / stale / draft)
  - github_pr_status   : one-call mergeability + checks + blockers + next action for a PR
  - worker_tick        : claim + run up to N pending tasks once (proves queue pickup)
  - lantern_command    : bang-command router (!convergance, !autonomous-work, !pr-status …)

Durable receipts → data/convergence/{pr,issue}-work-records.jsonl.

Safety gates (env, enforced by the *write* tools added in the follow-up patch):
  GITHUB_WRITE_ENABLED=1  GITHUB_ALLOWED_REPOS=alex-place/lantern-os
  MCP_ALLOW_MERGE=0  MCP_DEFAULT_BASE_BRANCH=master  MCP_BOT_BRANCH_PREFIX=mcp/
"""

import os
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple

import github_tools  # reuse _run_gh, _api, github_list_* (same dir on sys.path)

# ── Safety gates (scaffold; the read tools below never write) ─────────────────
ALLOWED_REPOS = [r.strip() for r in os.getenv("GITHUB_ALLOWED_REPOS", "alex-place/lantern-os").split(",") if r.strip()]
ALLOW_MERGE = os.getenv("MCP_ALLOW_MERGE", "0") in ("1", "true", "True")
DEFAULT_BASE = os.getenv("MCP_DEFAULT_BASE_BRANCH", "master")
BOT_PREFIX = os.getenv("MCP_BOT_BRANCH_PREFIX", "mcp/")
_ALLOWED_BRANCH_PREFIXES = ("bot/", "claude/", "fix/", "feat/", "mcp/")


def repo_allowed(owner: str, repo: str) -> bool:
    return f"{owner}/{repo}" in ALLOWED_REPOS


def branch_allowed(branch: str) -> bool:
    """Write tools may only touch non-default branches with an allowed prefix."""
    return bool(branch) and branch != DEFAULT_BASE and any(branch.startswith(p) for p in _ALLOWED_BRANCH_PREFIXES)


# ── Context injected by server.register (live queue + helpers) ────────────────
_CTX: Dict[str, Any] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_repo() -> Tuple[str, str]:
    target = (ALLOWED_REPOS[0] if ALLOWED_REPOS else "alex-place/lantern-os")
    owner, _, repo = target.partition("/")
    return owner, repo


def _record(kind: str, obj: Dict[str, Any]) -> None:
    """Write a durable work receipt (kind = 'pr' or 'issue')."""
    try:
        path = _CTX["repo_root"] / "data" / "convergence" / f"{kind}-work-records.jsonl"
        _CTX["append_jsonl"](path, obj)
    except Exception:
        pass


def _gh_json(args: List[str]) -> Any:
    out = github_tools._run_gh(args).strip()
    return json.loads(out) if out else {}


# ── Check-rollup helpers (gh statusCheckRollup mixes CheckRun + StatusContext) ─
def _check_name(c: Dict[str, Any]) -> str:
    return c.get("name") or c.get("context") or "check"


def _check_failed(c: Dict[str, Any]) -> bool:
    return c.get("conclusion") in ("FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE") \
        or c.get("state") in ("FAILURE", "ERROR")


def _check_pending(c: Dict[str, Any]) -> bool:
    if not c.get("conclusion") and c.get("status") in ("IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "EXPECTED"):
        return True
    return c.get("state") == "PENDING"


def _classify_pr(mergeable: str, merge_state: str, failing: List[str], pending: int, draft: bool) -> Tuple[str, str]:
    """Pure decision: (status, next_action). Unit-tested without network."""
    if draft:
        return "draft", "mark ready for review"
    if mergeable == "CONFLICTING" or merge_state == "DIRTY":
        return "conflicting", f"resolve merge conflicts with {DEFAULT_BASE}"
    if failing:
        return "blocked", "fix failing checks: " + ", ".join(failing)
    if pending > 0:
        return "checks_running", "wait for checks to finish"
    if merge_state == "BEHIND":
        return "stale", f"update branch with {DEFAULT_BASE}"
    return "ready", "merge"


# ── Tool: github_pr_status ────────────────────────────────────────────────────
def github_pr_status(owner: str, repo: str, pull_number: int) -> Dict[str, Any]:
    """Return mergeability, checks, blockers, labels, and the recommended next
    action for one PR — one clean call instead of five."""
    try:
        d = _gh_json(["pr", "view", str(pull_number), "--repo", f"{owner}/{repo}", "--json",
                      "number,title,headRefName,mergeable,mergeStateStatus,isDraft,labels,statusCheckRollup,reviewDecision"])
    except Exception as exc:
        return {"ok": False, "error": str(exc), "pull_number": pull_number}
    rollup = d.get("statusCheckRollup") or []
    failing = sorted({_check_name(c) for c in rollup if _check_failed(c)})
    pending = sum(1 for c in rollup if _check_pending(c))
    status, next_action = _classify_pr(d.get("mergeable"), d.get("mergeStateStatus"), failing, pending, d.get("isDraft"))
    return {
        "ok": True, "number": d.get("number"), "title": d.get("title"), "branch": d.get("headRefName"),
        "mergeable": d.get("mergeable"), "merge_state": d.get("mergeStateStatus"), "draft": d.get("isDraft"),
        "review_decision": d.get("reviewDecision") or "",
        "labels": [l["name"] for l in d.get("labels", [])],
        "blockers": failing, "checks_pending": pending,
        "status": status, "next_action": next_action,
    }


# ── Tool: github_triage_prs ──────────────────────────────────────────────────
def github_triage_prs(owner: str, repo: str, perPage: int = 20) -> Dict[str, Any]:
    """Pull open PRs + their checks/mergeability and return a ranked queue
    (ready first, conflicting last) — the missing 'PR issues' brain."""
    try:
        prs = _gh_json(["pr", "list", "--repo", f"{owner}/{repo}", "--state", "open",
                        "--limit", str(int(perPage)), "--json", "number"])
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    ranked: List[Dict[str, Any]] = []
    for p in prs:
        st = github_pr_status(owner, repo, p["number"])
        if st.get("ok"):
            ranked.append({k: st[k] for k in ("number", "title", "branch", "status", "blockers", "next_action")})
    order = {"ready": 0, "checks_running": 1, "stale": 2, "draft": 3, "blocked": 4, "conflicting": 5}
    ranked.sort(key=lambda x: (order.get(x["status"], 9), x["number"]))
    return {"ok": True, "count": len(ranked), "prs": ranked}


# ── Tool: convergence_run ────────────────────────────────────────────────────
def convergence_run(goal: str = "", mode: str = "triage") -> Dict[str, Any]:
    """Run the Convergence Loop over the repo + queue: Observe→Reason→Act→Verify→
    Converge. Modes: triage | status | issues | prs | checks | queue. Read-only;
    returns a grounded proposal (confidence 0.3) with evidence."""
    owner, repo = _default_repo()
    mode = (mode or "triage").lower()
    evidence: Dict[str, Any] = {"workflow_runs": [], "issues": [], "prs": []}
    top_issues: List[Dict[str, Any]] = []
    top_prs: List[Dict[str, Any]] = []
    blocking: List[str] = []
    queue: Dict[str, Any] = {}
    try:
        # Observe
        if mode in ("triage", "issues"):
            iss = github_tools.github_list_issues(owner, repo, state="open", perPage="10")
            top_issues = (iss.get("issues") or [])[:5]
            evidence["issues"] = top_issues
        if mode in ("triage", "prs", "checks"):
            tri = github_triage_prs(owner, repo, perPage=15)
            top_prs = (tri.get("prs") or [])[:8]
            evidence["prs"] = top_prs
            blocking = sorted({b for p in top_prs for b in (p.get("blockers") or [])})
        if mode in ("triage", "queue", "status"):
            q = _CTX.get("task_queue", [])
            queue = {
                "depth": len(q),
                "pending": sum(1 for t in q if t.get("status") == "pending"),
                "active": sum(1 for t in q if t.get("status") == "active"),
            }
            evidence["queue"] = queue
        # Reason → recommend
        rec = _recommend(top_prs, top_issues, blocking, queue)
        summary = _summarize(mode, top_issues, top_prs, blocking, queue)
        return {
            "ok": True, "mode": mode, "goal": goal, "summary": summary,
            "top_issues": [{"number": i.get("number"), "title": i.get("title")} for i in top_issues],
            "top_prs": top_prs, "blocking_checks": blocking,
            "recommended_next_action": rec, "confidence": 0.3, "evidence": evidence,
        }
    except Exception as exc:
        return {"ok": False, "mode": mode, "error": str(exc)}


def _recommend(top_prs, top_issues, blocking, queue) -> str:
    if queue.get("pending"):
        return f"Run the queue: worker_tick to pick up {queue['pending']} pending task(s)."
    ready = [p for p in top_prs if p.get("status") == "ready"]
    if ready:
        return f"Merge ready PR #{ready[0]['number']} (#%s)." % ready[0]["number"]
    blocked = [p for p in top_prs if p.get("status") == "blocked"]
    if blocked:
        return f"Fix checks on PR #{blocked[0]['number']}: {', '.join(blocked[0].get('blockers') or [])}."
    conflicting = [p for p in top_prs if p.get("status") == "conflicting"]
    if conflicting:
        return f"Resolve conflicts on PR #{conflicting[0]['number']}."
    if top_issues:
        return f"Investigate issue #{top_issues[0].get('number')} (!autonomous-work {top_issues[0].get('number')})."
    return "Nothing actionable — queue empty, no open PRs/issues need attention."


def _summarize(mode, top_issues, top_prs, blocking, queue) -> str:
    bits = []
    if top_prs:
        n_ready = sum(1 for p in top_prs if p.get("status") == "ready")
        n_block = sum(1 for p in top_prs if p.get("status") in ("blocked", "conflicting"))
        bits.append(f"{len(top_prs)} open PR(s): {n_ready} ready, {n_block} blocked/conflicting")
    if blocking:
        bits.append(f"blocking checks: {', '.join(blocking[:4])}")
    if top_issues:
        bits.append(f"{len(top_issues)} top open issue(s)")
    if queue:
        bits.append(f"queue depth {queue.get('depth', 0)} ({queue.get('pending', 0)} pending, {queue.get('active', 0)} active)")
    return f"[{mode}] " + ("; ".join(bits) if bits else "no data")


# ── Tool: worker_tick ────────────────────────────────────────────────────────
def worker_tick(limit: int = 1) -> Dict[str, Any]:
    """Claim and run up to N pending tasks once. Proves queue pickup without a
    daemon — each task goes pending → active → done/failed, so active_slots
    becomes meaningful while it runs."""
    try:
        n = max(1, int(limit))
    except (TypeError, ValueError):
        n = 1
    q = _CTX.get("task_queue", [])
    run = _CTX.get("run_task")
    if run is None:
        return {"ok": False, "error": "worker not wired (no run_task in context)"}
    pending = [t for t in q if t.get("status") == "pending"][:n]
    if not pending:
        return {"ok": True, "ran": 0, "results": [], "queue_depth": len(q), "note": "no pending tasks"}
    results = []
    for t in pending:
        try:
            r = run(t["id"])
            results.append({"task_id": t["id"], "ok": r.get("ok"), "status": r.get("status"),
                            "confidence": r.get("confidence")})
        except Exception as exc:
            results.append({"task_id": t.get("id"), "ok": False, "error": str(exc)})
    return {
        "ok": True, "ran": len(results), "results": results,
        "queue_depth": len(q),
        "active_slots": sum(1 for t in q if t.get("status") == "active"),
    }


# ── Tool: lantern_command (bang-command router) ──────────────────────────────
def _investigate_issue(owner: str, repo: str, issue_number: int) -> Dict[str, Any]:
    """Minimal PR1 investigate for !autonomous-work: read the issue + record a
    receipt. (patch/pr modes land in the follow-up github_work_issue tool.)"""
    info = github_tools.github_get_issue(owner, repo, str(issue_number))
    _record("issue", {
        "timestamp": _now(), "surface": "mcp-lantern-command",
        "issue": issue_number, "pr": None, "branch": None,
        "actions_taken": ["investigate"], "evidence": [], "confidence": 0.3,
        "verified": False, "result": "investigation only (patch/pr modes in follow-up patch)",
    })
    return {"title": info.get("title"), "state": info.get("state"),
            "labels": info.get("labels", []), "body_excerpt": (info.get("body") or "")[:400]}


def lantern_command(command: str = "") -> Dict[str, Any]:
    """Execute a Lantern bang command through the MCP backend the UI expects.
    Routes: !convergance/!convergence→convergence_run, !autonomous-work N→investigate,
    !pr-status N→github_pr_status, !triage-prs→github_triage_prs, !fix-pr N→status+plan,
    !queue-run [N]→worker_tick."""
    c = (command or "").strip()
    if not c:
        return {"ok": False, "error": "empty command"}
    if not c.startswith("!"):
        c = "!" + c
    parts = c.split()
    name = parts[0].lower()
    arg = parts[1] if len(parts) > 1 else ""
    owner, repo = _default_repo()

    if name in ("!convergance", "!convergence"):
        return {"ok": True, "command": name, "routed_to": "convergence_run", "result": convergence_run(mode="triage")}
    if name == "!triage-prs":
        return {"ok": True, "command": name, "routed_to": "github_triage_prs", "result": github_triage_prs(owner, repo)}
    if name == "!autonomous-work":
        if not arg.isdigit():
            return {"ok": False, "command": name, "error": "usage: !autonomous-work <issue_number>"}
        return {"ok": True, "command": name, "issue": int(arg), "routed_to": "github_work_issue(investigate)",
                "note": "patch/pr modes land in the follow-up github_work_issue tool",
                "result": _investigate_issue(owner, repo, int(arg))}
    if name == "!pr-status":
        if not arg.isdigit():
            return {"ok": False, "command": name, "error": "usage: !pr-status <pull_number>"}
        return {"ok": True, "command": name, "routed_to": "github_pr_status",
                "result": github_pr_status(owner, repo, int(arg))}
    if name == "!fix-pr":
        if not arg.isdigit():
            return {"ok": False, "command": name, "error": "usage: !fix-pr <pull_number>"}
        return {"ok": True, "command": name, "routed_to": "github_fix_failed_checks",
                "note": "auto-fix lands in the follow-up patch; here is the status + plan",
                "result": github_pr_status(owner, repo, int(arg))}
    if name == "!queue-run":
        return {"ok": True, "command": name, "routed_to": "worker_tick",
                "result": worker_tick(int(arg) if arg.isdigit() else 1)}
    return {"ok": False, "command": name, "error": f"unknown command: {name}",
            "known": ["!convergance", "!convergence", "!triage-prs", "!autonomous-work N",
                      "!pr-status N", "!fix-pr N", "!queue-run [N]"]}


# ── Registration ─────────────────────────────────────────────────────────────
CONVERGENCE_TOOLS = {
    "convergence_run": convergence_run,
    "github_triage_prs": github_triage_prs,
    "github_pr_status": github_pr_status,
    "worker_tick": worker_tick,
    "lantern_command": lantern_command,
}


def register(registry: Dict[str, Any], ctx: Dict[str, Any]) -> List[str]:
    """Wire the live queue + helpers and merge the workflow tools into the registry.
    ctx must provide: task_queue (list), run_task (fn), append_jsonl (fn), repo_root (Path)."""
    _CTX.update(ctx)
    registry.update(CONVERGENCE_TOOLS)
    return list(CONVERGENCE_TOOLS.keys())
