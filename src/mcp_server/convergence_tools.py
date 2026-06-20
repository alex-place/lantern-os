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

Follow-up patch (issue automation — the first *write* tools here):
  - github_work_issue        : investigate | patch (bot branch + push) | pr (open, never merge)
  - github_fix_failed_checks : inspect failed checks → stacked fix PR (default) or bot-branch push

Durable receipts → data/convergence/{pr,issue}-work-records.jsonl.

Safety gates (env, ENFORCED by the write tools below — hard-refuse on violation):
  GITHUB_WRITE_ENABLED=1  GITHUB_ALLOWED_REPOS=alex-place/lantern-os
  MCP_ALLOW_MERGE=0  MCP_DEFAULT_BASE_BRANCH=master  MCP_BOT_BRANCH_PREFIX=mcp/
Hard rules: never write the base branch; never merge; only write allow-listed repos
and branches under an allowed prefix; refuse all writes when WRITE_ENABLED is False.
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


# ── Write-tool safety helpers (shared by github_work_issue / fix_failed_checks) ─
def _write_enabled() -> bool:
    """Re-read github_tools.WRITE_ENABLED live so tests can toggle it."""
    return bool(getattr(github_tools, "WRITE_ENABLED", False))


def _bot_branch(kind: str, number: int) -> str:
    """Deterministic bot branch name under MCP_BOT_BRANCH_PREFIX (always allowed)."""
    return f"{BOT_PREFIX}{kind}-{number}"


def _refuse(reason: str, **extra: Any) -> Dict[str, Any]:
    """Hard refusal as an error dict (never raises, never writes)."""
    out = {"ok": False, "refused": True, "error": reason}
    out.update(extra)
    return out


def _coerce_files(file_changes: Any) -> List[Dict[str, str]]:
    """Normalize file_changes (JSON string or list) → [{path, content}, ...]."""
    if not file_changes:
        return []
    parsed = json.loads(file_changes) if isinstance(file_changes, str) else file_changes
    if not isinstance(parsed, list):
        raise ValueError("file_changes must be a JSON array of {path, content}")
    out: List[Dict[str, str]] = []
    for f in parsed:
        if not isinstance(f, dict) or "path" not in f or "content" not in f:
            raise ValueError("each file change needs {path, content}")
        out.append({"path": str(f["path"]), "content": str(f["content"])})
    return out


# ── Tool: github_work_issue ───────────────────────────────────────────────────
def github_work_issue(owner: str = "", repo: str = "", issue_number: int = 0,
                      mode: str = "investigate", create_pr: bool = False,
                      file_changes: Any = None, fix_plan: str = "") -> Dict[str, Any]:
    """Work a GitHub issue under hard safety gates.

    mode=investigate : read the issue + record a fix_plan. NO writes.
    mode=patch       : investigate + create a bot branch (MCP_BOT_BRANCH_PREFIX)
                       + push proposed file_changes. NO PR, NO merge.
    mode=pr          : patch + open a PR into MCP_DEFAULT_BASE_BRANCH. NEVER merges.

    Safety (hard refuse → error dict): repo not allow-listed; writes disabled
    (github_tools.WRITE_ENABLED False); any attempt to write the base branch.
    Every action is appended to data/convergence/issue-work-records.jsonl.
    """
    if not owner or not repo:
        d_owner, d_repo = _default_repo()
        owner, repo = owner or d_owner, repo or d_repo
    try:
        issue_number = int(issue_number)
    except (TypeError, ValueError):
        return _refuse("issue_number must be an integer", issue_number=issue_number)
    mode = (mode or "investigate").lower().strip()
    if mode not in ("investigate", "patch", "pr"):
        return _refuse(f"unknown mode '{mode}' (use investigate|patch|pr)", mode=mode)
    # create_pr=True is shorthand for mode=pr.
    if create_pr and mode == "patch":
        mode = "pr"

    # ── Gate 1: repo allow-list (applies to every mode) ──
    if not repo_allowed(owner, repo):
        rec = {"timestamp": _now(), "surface": "github_work_issue", "issue": issue_number,
               "pr": None, "branch": None, "actions_taken": [], "mode": mode,
               "verified": False, "confidence": 0.3, "result": "refused: repo not allow-listed"}
        _record("issue", rec)
        return _refuse(f"repo {owner}/{repo} is not allow-listed (GITHUB_ALLOWED_REPOS)",
                       owner=owner, repo=repo, mode=mode)

    actions: List[str] = []
    # ── Observe: read the issue (read-only, all modes) ──
    info = github_tools.github_get_issue(owner, repo, str(issue_number))
    if isinstance(info, dict) and info.get("error"):
        return _refuse(f"could not read issue #{issue_number}: {info['error']}",
                       owner=owner, repo=repo, mode=mode)
    actions.append("investigate")
    plan = fix_plan or _issue_fix_plan(info)
    result: Dict[str, Any] = {
        "ok": True, "mode": mode, "owner": owner, "repo": repo, "issue": issue_number,
        "title": info.get("title"), "state": info.get("state"),
        "labels": info.get("labels", []), "body_excerpt": (info.get("body") or "")[:400],
        "fix_plan": plan, "branch": None, "pull_number": None, "confidence": 0.3,
    }

    if mode == "investigate":
        result["note"] = "investigate only — no writes"
        _record("issue", _issue_receipt(issue_number, None, None, actions, plan,
                                        "investigation only (no writes)"))
        return result

    # ── patch / pr require writes ──
    if not _write_enabled():
        _record("issue", _issue_receipt(issue_number, None, None, actions, plan,
                                        "refused: writes disabled (GITHUB_WRITE_ENABLED=0)"))
        return _refuse("writes disabled (github_tools.WRITE_ENABLED is False)",
                       owner=owner, repo=repo, mode=mode, fix_plan=plan)

    branch = _bot_branch("issue", issue_number)
    # ── Gate 2: never write the base branch; only allowed bot/prefixed branches ──
    if branch == DEFAULT_BASE or not branch_allowed(branch):
        _record("issue", _issue_receipt(issue_number, None, branch, actions, plan,
                                        "refused: target branch not writable"))
        return _refuse(f"refusing to write branch '{branch}' (base branch or disallowed prefix)",
                       owner=owner, repo=repo, mode=mode, branch=branch)

    try:
        files = _coerce_files(file_changes)
    except (ValueError, json.JSONDecodeError) as exc:
        return _refuse(f"invalid file_changes: {exc}", owner=owner, repo=repo, mode=mode)
    if not files:
        return _refuse("patch/pr mode requires file_changes ([{path, content}, ...])",
                       owner=owner, repo=repo, mode=mode, fix_plan=plan)

    # ── Act: create the bot branch off the base, then push the files ──
    br = github_tools.github_create_branch(owner, repo, branch, from_branch=DEFAULT_BASE)
    if isinstance(br, dict) and br.get("error") and "already exists" not in str(br.get("error", "")).lower():
        _record("issue", _issue_receipt(issue_number, None, branch, actions, plan,
                                        f"branch create failed: {br['error']}"))
        return _refuse(f"could not create branch '{branch}': {br['error']}",
                       owner=owner, repo=repo, mode=mode, branch=branch)
    actions.append(f"create_branch:{branch}")
    result["branch"] = branch

    commit_msg = f"fix(#{issue_number}): {(info.get('title') or 'automated patch')[:60]}\n\n{plan[:300]}"
    if len(files) == 1:
        pushed = github_tools.github_create_or_update_file(
            owner, repo, files[0]["path"], files[0]["content"], commit_msg, branch=branch)
    else:
        pushed = github_tools.github_push_files(owner, repo, branch, commit_msg, json.dumps(files))
    if isinstance(pushed, dict) and pushed.get("error"):
        _record("issue", _issue_receipt(issue_number, None, branch, actions, plan,
                                        f"push failed: {pushed['error']}"))
        return _refuse(f"could not push files: {pushed['error']}",
                       owner=owner, repo=repo, mode=mode, branch=branch)
    actions.append("push_files:" + ",".join(f["path"] for f in files))
    result["pushed_files"] = [f["path"] for f in files]

    if mode == "patch":
        result["note"] = "patched bot branch — no PR opened (mode=patch)"
        _record("issue", _issue_receipt(issue_number, None, branch, actions, plan,
                                        "pushed to bot branch (no PR)"))
        return result

    # ── mode == pr: open a PR into the base branch (NEVER merge) ──
    pr_title = f"fix(#{issue_number}): {(info.get('title') or 'automated patch')[:80]}"
    pr_body = (f"Automated patch for #{issue_number} via MCP github_work_issue.\n\n"
               f"**Fix plan**\n{plan}\n\nCloses #{issue_number}")
    pr = github_tools.github_create_pull_request(owner, repo, pr_title, branch, DEFAULT_BASE, body=pr_body)
    if isinstance(pr, dict) and pr.get("error"):
        _record("issue", _issue_receipt(issue_number, None, branch, actions, plan,
                                        f"PR create failed: {pr['error']}"))
        return _refuse(f"could not open PR: {pr['error']}",
                       owner=owner, repo=repo, mode=mode, branch=branch)
    actions.append(f"create_pull_request:#{pr.get('number')}")
    result["pull_number"] = pr.get("number")
    result["pr_url"] = pr.get("html_url")
    result["note"] = "PR opened into base branch — NOT merged"
    _record("issue", _issue_receipt(issue_number, pr.get("number"), branch, actions, plan,
                                    f"PR #{pr.get('number')} opened (not merged)"))
    return result


def _issue_fix_plan(info: Dict[str, Any]) -> str:
    title = info.get("title") or "issue"
    body = (info.get("body") or "").strip()
    first = body.splitlines()[0] if body else ""
    return f"Investigate '{title}'. {first}".strip()


def _issue_receipt(issue: int, pr: Any, branch: Any, actions: List[str],
                   plan: str, result: str) -> Dict[str, Any]:
    return {"timestamp": _now(), "surface": "github_work_issue",
            "issue": issue, "pr": pr, "branch": branch,
            "actions_taken": list(actions), "fix_plan": plan,
            "evidence": [], "confidence": 0.3, "verified": False, "result": result}


# ── Tool: github_fix_failed_checks ────────────────────────────────────────────
def github_fix_failed_checks(owner: str = "", repo: str = "", pull_number: int = 0,
                             create_pr: bool = True, file_changes: Any = None,
                             fix_plan: str = "") -> Dict[str, Any]:
    """Inspect a PR's failed checks and propose/apply a fix under safety gates.

    Reuses github_pr_status + github_get_job_logs to build a fix_plan.
    create_pr=True (DEFAULT, SAFER): create a STACKED bot fix branch and open a
    NEW PR — never touches the original branch. Only when create_pr=False AND the
    original branch is clearly bot-owned (starts with MCP_BOT_BRANCH_PREFIX) do we
    push directly to it.

    Safety (hard refuse): repo not allow-listed; writes disabled; any attempt to
    write the base branch; never merges. Receipts → pr-work-records.jsonl.
    """
    if not owner or not repo:
        d_owner, d_repo = _default_repo()
        owner, repo = owner or d_owner, repo or d_repo
    try:
        pull_number = int(pull_number)
    except (TypeError, ValueError):
        return _refuse("pull_number must be an integer", pull_number=pull_number)

    # ── Gate 1: repo allow-list ──
    if not repo_allowed(owner, repo):
        _record("pr", _pr_receipt(pull_number, None, [], "", "refused: repo not allow-listed"))
        return _refuse(f"repo {owner}/{repo} is not allow-listed (GITHUB_ALLOWED_REPOS)",
                       owner=owner, repo=repo)

    # ── Observe: PR status + failing checks ──
    status = github_pr_status(owner, repo, pull_number)
    if not status.get("ok"):
        return _refuse(f"could not read PR #{pull_number}: {status.get('error')}",
                       owner=owner, repo=repo)
    failing = status.get("blockers") or []
    orig_branch = status.get("branch") or ""
    logs_tail = _failed_job_logs(owner, repo, pull_number)
    plan = fix_plan or _checks_fix_plan(failing, logs_tail)
    actions: List[str] = ["inspect_checks"]
    result: Dict[str, Any] = {
        "ok": True, "owner": owner, "repo": repo, "pull_number": pull_number,
        "original_branch": orig_branch, "failing_checks": failing,
        "fix_plan": plan, "logs_excerpt": logs_tail[-1200:] if logs_tail else "",
        "branch": None, "new_pull_number": None, "confidence": 0.3,
    }

    # No file changes supplied → plan-only (status + plan), no writes.
    try:
        files = _coerce_files(file_changes)
    except (ValueError, json.JSONDecodeError) as exc:
        return _refuse(f"invalid file_changes: {exc}", owner=owner, repo=repo)
    if not files:
        result["note"] = "status + fix_plan only (no file_changes supplied → no writes)"
        _record("pr", _pr_receipt(pull_number, None, actions, plan, "plan only (no writes)"))
        return result

    # ── writes required from here ──
    if not _write_enabled():
        _record("pr", _pr_receipt(pull_number, None, actions, plan,
                                  "refused: writes disabled (GITHUB_WRITE_ENABLED=0)"))
        return _refuse("writes disabled (github_tools.WRITE_ENABLED is False)",
                       owner=owner, repo=repo, fix_plan=plan)

    bot_owned = bool(orig_branch) and orig_branch.startswith(BOT_PREFIX)
    # Decide the target branch:
    #   create_pr=True (default, safer) → always a fresh STACKED bot branch + new PR.
    #   create_pr=False → direct push ONLY if the original branch is bot-owned.
    if not create_pr and bot_owned:
        target_branch, open_new_pr = orig_branch, False
    else:
        target_branch, open_new_pr = _bot_branch("fixpr", pull_number), True

    # ── Gate 2/3: never the base branch; allowed prefix only ──
    if target_branch == DEFAULT_BASE or not branch_allowed(target_branch):
        _record("pr", _pr_receipt(pull_number, target_branch, actions, plan,
                                  "refused: target branch not writable"))
        return _refuse(f"refusing to write branch '{target_branch}' (base branch or disallowed prefix)",
                       owner=owner, repo=repo, branch=target_branch)
    result["branch"] = target_branch
    result["stacked"] = open_new_pr

    # ── Act: for a stacked fix, create the branch off the original PR branch ──
    if open_new_pr:
        from_branch = orig_branch if (orig_branch and branch_allowed(orig_branch)) else DEFAULT_BASE
        br = github_tools.github_create_branch(owner, repo, target_branch, from_branch=from_branch)
        if isinstance(br, dict) and br.get("error") and "already exists" not in str(br.get("error", "")).lower():
            _record("pr", _pr_receipt(pull_number, target_branch, actions, plan,
                                      f"branch create failed: {br['error']}"))
            return _refuse(f"could not create fix branch '{target_branch}': {br['error']}",
                           owner=owner, repo=repo, branch=target_branch)
        actions.append(f"create_branch:{target_branch}")

    commit_msg = f"fix(checks): PR #{pull_number}\n\n{plan[:300]}"
    if len(files) == 1:
        pushed = github_tools.github_create_or_update_file(
            owner, repo, files[0]["path"], files[0]["content"], commit_msg, branch=target_branch)
    else:
        pushed = github_tools.github_push_files(owner, repo, target_branch, commit_msg, json.dumps(files))
    if isinstance(pushed, dict) and pushed.get("error"):
        _record("pr", _pr_receipt(pull_number, target_branch, actions, plan,
                                  f"push failed: {pushed['error']}"))
        return _refuse(f"could not push fix: {pushed['error']}",
                       owner=owner, repo=repo, branch=target_branch)
    actions.append("push_files:" + ",".join(f["path"] for f in files))
    result["pushed_files"] = [f["path"] for f in files]

    if not open_new_pr:
        result["note"] = f"pushed fix directly to bot-owned branch '{target_branch}' (no new PR; never merged)"
        _record("pr", _pr_receipt(pull_number, target_branch, actions, plan,
                                  "pushed to bot-owned PR branch (no new PR)"))
        return result

    # ── open a NEW PR for the stacked fix (NEVER merge) ──
    base = orig_branch if (orig_branch and branch_allowed(orig_branch)) else DEFAULT_BASE
    pr_title = f"fix(checks): repair failing checks on PR #{pull_number}"
    pr_body = (f"Stacked fix for the failing checks on #{pull_number}.\n\n"
               f"**Failing**: {', '.join(failing) or 'unknown'}\n\n**Plan**\n{plan}")
    pr = github_tools.github_create_pull_request(owner, repo, pr_title, target_branch, base, body=pr_body)
    if isinstance(pr, dict) and pr.get("error"):
        _record("pr", _pr_receipt(pull_number, target_branch, actions, plan,
                                  f"PR create failed: {pr['error']}"))
        return _refuse(f"could not open stacked PR: {pr['error']}",
                       owner=owner, repo=repo, branch=target_branch)
    actions.append(f"create_pull_request:#{pr.get('number')}")
    result["new_pull_number"] = pr.get("number")
    result["pr_url"] = pr.get("html_url")
    result["note"] = f"opened stacked fix PR #{pr.get('number')} into '{base}' — NOT merged"
    _record("pr", _pr_receipt(pull_number, target_branch, actions, plan,
                              f"stacked fix PR #{pr.get('number')} opened (not merged)"))
    return result


def _failed_job_logs(owner: str, repo: str, pull_number: int) -> str:
    """Best-effort tail of failed-job logs for the PR head ref (read-only)."""
    try:
        d = _gh_json(["pr", "view", str(pull_number), "--repo", f"{owner}/{repo}",
                      "--json", "statusCheckRollup"])
    except Exception:
        return ""
    tails: List[str] = []
    for c in (d.get("statusCheckRollup") or []):
        if not _check_failed(c):
            continue
        job_id = _job_id_from_check(c)
        if not job_id:
            continue
        logs = github_tools.github_get_job_logs(owner, repo, str(job_id))
        if isinstance(logs, dict) and logs.get("logs_tail"):
            tails.append(f"[{_check_name(c)}]\n{logs['logs_tail'][-800:]}")
        if len(tails) >= 3:
            break
    return "\n\n".join(tails)


def _job_id_from_check(c: Dict[str, Any]) -> str:
    """Extract an Actions job id from a check-rollup entry, if present."""
    for key in ("databaseId", "id"):
        if c.get(key):
            return str(c[key])
    url = c.get("detailsUrl") or c.get("targetUrl") or ""
    if "/job/" in url:
        return url.rsplit("/job/", 1)[-1].split("?")[0]
    return ""


def _checks_fix_plan(failing: List[str], logs_tail: str) -> str:
    if not failing:
        return "No failing checks detected; verify the PR is actually red before patching."
    plan = "Repair failing checks: " + ", ".join(failing) + "."
    if logs_tail:
        plan += " Logs point at the tail output above."
    return plan


def _pr_receipt(pull_number: int, branch: Any, actions: List[str],
                plan: str, result: str) -> Dict[str, Any]:
    return {"timestamp": _now(), "surface": "github_fix_failed_checks",
            "issue": None, "pr": pull_number, "branch": branch,
            "actions_taken": list(actions), "fix_plan": plan,
            "evidence": [], "confidence": 0.3, "verified": False, "result": result}


# ── Tool: lantern_command (bang-command router) ──────────────────────────────
def _investigate_issue(owner: str, repo: str, issue_number: int) -> Dict[str, Any]:
    """!autonomous-work investigate — delegate to github_work_issue (read-only)."""
    res = github_work_issue(owner, repo, issue_number, mode="investigate")
    return {"title": res.get("title"), "state": res.get("state"),
            "labels": res.get("labels", []), "fix_plan": res.get("fix_plan"),
            "body_excerpt": res.get("body_excerpt", "")}


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
            return {"ok": False, "command": name, "error": "usage: !fix-pr <pull_number> [--push]"}
        # Default to the safer stacked-PR gate (create_pr=True). '--push' opts into
        # a direct push, which github_fix_failed_checks still only honors for
        # bot-owned branches. No file_changes here → status + plan (no writes).
        create_pr = "--push" not in parts[1:]
        return {"ok": True, "command": name, "routed_to": "github_fix_failed_checks",
                "result": github_fix_failed_checks(owner, repo, int(arg), create_pr=create_pr)}
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
    "github_work_issue": github_work_issue,
    "github_fix_failed_checks": github_fix_failed_checks,
    "worker_tick": worker_tick,
    "lantern_command": lantern_command,
}


def register(registry: Dict[str, Any], ctx: Dict[str, Any]) -> List[str]:
    """Wire the live queue + helpers and merge the workflow tools into the registry.
    ctx must provide: task_queue (list), run_task (fn), append_jsonl (fn), repo_root (Path)."""
    _CTX.update(ctx)
    registry.update(CONVERGENCE_TOOLS)
    return list(CONVERGENCE_TOOLS.keys())
