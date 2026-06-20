"""Unit tests for the MCP issue-automation write tools (offline — gh + write fns stubbed).

Covers github_work_issue (investigate/patch/pr) and github_fix_failed_checks under the
hard safety gates: disallowed repo, base-branch write, WRITE_ENABLED False, never merge,
and the "default = stacked PR (not a direct push to a non-bot branch)" rule.
"""
import sys
import json
from pathlib import Path

import pytest

# Same path wiring as test_mcp_convergence_tools.py so flat imports resolve.
_MCP = Path(__file__).resolve().parents[1] / "src" / "mcp_server"
sys.path.insert(0, str(_MCP))

import convergence_tools as ct  # noqa: E402
import github_tools as gt  # noqa: E402


# ── Fixtures / stubs ──────────────────────────────────────────────────────────
@pytest.fixture
def records():
    """Capture every receipt written via _record (kind, obj)."""
    return []


@pytest.fixture(autouse=True)
def wire(records, monkeypatch):
    """Wire ct context with a capturing append_jsonl, and ensure WRITE_ENABLED on."""
    ct.register({}, {
        "task_queue": [],
        "run_task": lambda tid: {"ok": True, "status": "done", "confidence": 0.3},
        "append_jsonl": lambda path, obj: records.append((Path(path).name, obj)),
        "repo_root": Path("."),
    })
    monkeypatch.setattr(gt, "WRITE_ENABLED", True, raising=False)
    yield


class _Calls:
    """Records every stubbed write call so tests assert what *would* have happened."""
    def __init__(self):
        self.created_branches = []
        self.single_files = []
        self.pushed = []
        self.pulls = []
        self.merges = []


@pytest.fixture
def calls(monkeypatch):
    c = _Calls()

    def create_branch(owner, repo, branch, from_branch=""):
        c.created_branches.append((branch, from_branch))
        return {"ok": True, "branch": branch, "from": from_branch}

    def create_or_update_file(owner, repo, path, content, message, branch="", sha=""):
        c.single_files.append({"path": path, "branch": branch, "message": message})
        return {"ok": True, "path": path, "commit_sha": "deadbeef"}

    def push_files(owner, repo, branch, message, files):
        parsed = json.loads(files) if isinstance(files, str) else files
        c.pushed.append({"branch": branch, "files": [f["path"] for f in parsed]})
        return {"ok": True, "branch": branch, "commit_sha": "cafef00d"}

    def create_pull_request(owner, repo, title, head, base, body="", draft="false"):
        c.pulls.append({"title": title, "head": head, "base": base})
        return {"ok": True, "number": 999, "html_url": "http://pr/999"}

    def merge_pull_request(*a, **k):  # must NEVER be called
        c.merges.append(a)
        return {"ok": True}

    monkeypatch.setattr(gt, "github_create_branch", create_branch)
    monkeypatch.setattr(gt, "github_create_or_update_file", create_or_update_file)
    monkeypatch.setattr(gt, "github_push_files", push_files)
    monkeypatch.setattr(gt, "github_create_pull_request", create_pull_request)
    monkeypatch.setattr(gt, "github_merge_pull_request", merge_pull_request)
    return c


def _stub_issue(monkeypatch, title="Broken thing", body="Steps to repro\nmore"):
    monkeypatch.setattr(gt, "github_get_issue", lambda o, r, n: {
        "number": int(n), "title": title, "state": "open", "labels": ["bug"], "body": body})


# ── github_work_issue: mode parsing ───────────────────────────────────────────
def test_work_issue_investigate_no_writes(monkeypatch, calls, records):
    _stub_issue(monkeypatch)
    r = ct.github_work_issue("alex-place", "lantern-os", 42, mode="investigate")
    assert r["ok"] and r["mode"] == "investigate"
    assert r["fix_plan"] and r["branch"] is None and r["pull_number"] is None
    assert calls.created_branches == [] and calls.pulls == []     # NO writes
    assert any(k == "issue-work-records.jsonl" for k, _ in records)


def test_work_issue_bad_mode_refused(monkeypatch, calls):
    _stub_issue(monkeypatch)
    r = ct.github_work_issue("alex-place", "lantern-os", 42, mode="nuke")
    assert not r["ok"] and r["refused"]
    assert calls.created_branches == []


def test_create_pr_true_promotes_patch_to_pr(monkeypatch, calls):
    _stub_issue(monkeypatch)
    r = ct.github_work_issue("alex-place", "lantern-os", 7, mode="patch", create_pr=True,
                             file_changes=[{"path": "a.py", "content": "x"}])
    assert r["ok"] and r["mode"] == "pr"
    assert r["pull_number"] == 999 and len(calls.pulls) == 1


# ── github_work_issue: patch / pr writes go to a bot branch, never base/merge ──
def test_work_issue_patch_uses_bot_branch_no_pr(monkeypatch, calls):
    _stub_issue(monkeypatch)
    r = ct.github_work_issue("alex-place", "lantern-os", 13, mode="patch",
                             file_changes=[{"path": "fix.py", "content": "1"}])
    assert r["ok"] and r["mode"] == "patch"
    assert r["branch"].startswith(ct.BOT_PREFIX)
    # created off the base, single-file path used, NO PR, NO merge
    assert calls.created_branches and calls.created_branches[0][1] == ct.DEFAULT_BASE
    assert calls.single_files and calls.pulls == [] and calls.merges == []


def test_work_issue_pr_opens_into_base_never_merges(monkeypatch, calls):
    _stub_issue(monkeypatch)
    r = ct.github_work_issue("alex-place", "lantern-os", 21, mode="pr",
                             file_changes=[{"path": "a", "content": "1"}, {"path": "b", "content": "2"}])
    assert r["ok"] and r["pull_number"] == 999
    assert calls.pulls[0]["base"] == ct.DEFAULT_BASE
    assert calls.pulls[0]["head"].startswith(ct.BOT_PREFIX)
    assert calls.pushed and calls.merges == []                    # multi-file → push_files; never merged


# ── github_work_issue: safety refusals ────────────────────────────────────────
def test_work_issue_refuses_disallowed_repo(monkeypatch, calls, records):
    _stub_issue(monkeypatch)
    r = ct.github_work_issue("evil", "repo", 1, mode="pr",
                             file_changes=[{"path": "a", "content": "x"}])
    assert not r["ok"] and r["refused"] and "allow-listed" in r["error"]
    assert calls.created_branches == [] and calls.pulls == []
    assert any(k == "issue-work-records.jsonl" for k, _ in records)


def test_work_issue_refuses_when_write_disabled(monkeypatch, calls):
    _stub_issue(monkeypatch)
    monkeypatch.setattr(gt, "WRITE_ENABLED", False, raising=False)
    r = ct.github_work_issue("alex-place", "lantern-os", 5, mode="patch",
                             file_changes=[{"path": "a", "content": "x"}])
    assert not r["ok"] and r["refused"] and "writes disabled" in r["error"].lower()
    assert calls.created_branches == [] and calls.pulls == []


def test_work_issue_never_writes_base_branch(monkeypatch, calls):
    """If the computed bot branch somehow equals the base, hard-refuse."""
    _stub_issue(monkeypatch)
    monkeypatch.setattr(ct, "_bot_branch", lambda kind, n: ct.DEFAULT_BASE)
    r = ct.github_work_issue("alex-place", "lantern-os", 9, mode="patch",
                             file_changes=[{"path": "a", "content": "x"}])
    assert not r["ok"] and r["refused"]
    assert calls.created_branches == [] and calls.merges == []


def test_work_issue_patch_requires_file_changes(monkeypatch, calls):
    _stub_issue(monkeypatch)
    r = ct.github_work_issue("alex-place", "lantern-os", 3, mode="patch")
    assert not r["ok"] and r["refused"] and "file_changes" in r["error"]
    assert calls.created_branches == []


# ── github_fix_failed_checks: default = stacked PR, not a direct push ─────────
def _stub_pr_status(monkeypatch, branch, failing=("Slop Check",)):
    monkeypatch.setattr(ct, "github_pr_status", lambda o, r, n: {
        "ok": True, "number": n, "branch": branch, "blockers": list(failing),
        "status": "blocked", "checks_pending": 0})
    monkeypatch.setattr(ct, "_failed_job_logs", lambda o, r, n: "error: boom\nstacktrace")


def test_fix_checks_default_stacks_pr_not_direct_push(monkeypatch, calls):
    """create_pr defaults True → fresh bot branch + NEW PR, even if PR branch is human-owned."""
    _stub_pr_status(monkeypatch, branch="feat/human-branch")
    r = ct.github_fix_failed_checks("alex-place", "lantern-os", 750,
                                    file_changes=[{"path": "ci.yml", "content": "fix"}])
    assert r["ok"] and r["stacked"] is True
    assert r["branch"].startswith(ct.BOT_PREFIX) and r["branch"] != "feat/human-branch"
    assert r["new_pull_number"] == 999 and len(calls.pulls) == 1
    # NEVER pushed to the human branch directly, NEVER merged
    assert all(b[0] != "feat/human-branch" for b in calls.created_branches)
    assert all(f["branch"].startswith(ct.BOT_PREFIX) for f in calls.single_files)
    assert calls.merges == []


def test_fix_checks_plan_only_without_file_changes(monkeypatch, calls, records):
    _stub_pr_status(monkeypatch, branch="feat/x")
    r = ct.github_fix_failed_checks("alex-place", "lantern-os", 750)  # no file_changes
    assert r["ok"] and r["new_pull_number"] is None and r["branch"] is None
    assert calls.created_branches == [] and calls.pulls == []
    assert any(k == "pr-work-records.jsonl" for k, _ in records)


def test_fix_checks_create_pr_false_human_branch_still_stacks(monkeypatch, calls):
    """create_pr=False but branch is NOT bot-owned → still refuse direct push, stack instead."""
    _stub_pr_status(monkeypatch, branch="feat/human")
    r = ct.github_fix_failed_checks("alex-place", "lantern-os", 750, create_pr=False,
                                    file_changes=[{"path": "a", "content": "x"}])
    assert r["ok"] and r["stacked"] is True                       # NOT a direct push
    assert r["branch"].startswith(ct.BOT_PREFIX)
    assert len(calls.pulls) == 1 and calls.merges == []


def test_fix_checks_create_pr_false_bot_branch_direct_push(monkeypatch, calls):
    """create_pr=False AND bot-owned branch → direct push, no new PR."""
    bot_branch = ct.BOT_PREFIX + "issue-100"
    _stub_pr_status(monkeypatch, branch=bot_branch)
    r = ct.github_fix_failed_checks("alex-place", "lantern-os", 750, create_pr=False,
                                    file_changes=[{"path": "a", "content": "x"}])
    assert r["ok"] and r["stacked"] is False
    assert r["branch"] == bot_branch and r["new_pull_number"] is None
    assert calls.pulls == [] and calls.merges == []
    # pushed straight onto the bot branch
    assert calls.single_files and calls.single_files[0]["branch"] == bot_branch


def test_fix_checks_refuses_disallowed_repo(monkeypatch, calls):
    _stub_pr_status(monkeypatch, branch="mcp/x")
    r = ct.github_fix_failed_checks("evil", "repo", 1,
                                    file_changes=[{"path": "a", "content": "x"}])
    assert not r["ok"] and r["refused"] and "allow-listed" in r["error"]
    assert calls.created_branches == [] and calls.pulls == []


def test_fix_checks_refuses_when_write_disabled(monkeypatch, calls):
    _stub_pr_status(monkeypatch, branch="feat/x")
    monkeypatch.setattr(gt, "WRITE_ENABLED", False, raising=False)
    r = ct.github_fix_failed_checks("alex-place", "lantern-os", 750,
                                    file_changes=[{"path": "a", "content": "x"}])
    assert not r["ok"] and r["refused"] and "writes disabled" in r["error"].lower()
    assert calls.created_branches == [] and calls.pulls == []


# ── record writing ────────────────────────────────────────────────────────────
def test_records_written_to_correct_files(monkeypatch, calls, records):
    _stub_issue(monkeypatch)
    ct.github_work_issue("alex-place", "lantern-os", 1, mode="pr",
                         file_changes=[{"path": "a", "content": "x"}])
    _stub_pr_status(monkeypatch, branch="mcp/issue-1")
    ct.github_fix_failed_checks("alex-place", "lantern-os", 2, create_pr=False,
                                file_changes=[{"path": "a", "content": "x"}])
    names = {k for k, _ in records}
    assert "issue-work-records.jsonl" in names
    assert "pr-work-records.jsonl" in names
    # every receipt is marked unverified with confidence 0.3 (proposal, not truth)
    for _, obj in records:
        assert obj["verified"] is False and obj["confidence"] == 0.3


# ── lantern_command routing into the new tools ────────────────────────────────
def test_lantern_autonomous_work_routes_to_work_issue(monkeypatch):
    _stub_issue(monkeypatch)
    r = ct.lantern_command("!autonomous-work 55")
    assert r["ok"] and r["issue"] == 55
    assert r["routed_to"] == "github_work_issue(investigate)"
    assert r["result"]["fix_plan"]                                 # investigate plan surfaced


def test_lantern_fix_pr_routes_to_fix_failed_checks(monkeypatch):
    _stub_pr_status(monkeypatch, branch="feat/x")
    r = ct.lantern_command("!fix-pr 750")
    assert r["ok"] and r["routed_to"] == "github_fix_failed_checks"
    # default create_pr respected → status + plan (no file_changes → no writes)
    assert r["result"]["ok"] and r["result"]["pull_number"] == 750
    assert "fix_plan" in r["result"]


def test_lantern_fix_pr_bad_arg():
    r = ct.lantern_command("!fix-pr")
    assert not r["ok"] and "usage" in r["error"]


def test_new_tools_registered():
    reg = {}
    ct.register(reg, {"task_queue": [], "run_task": lambda x: {},
                      "append_jsonl": lambda *a: True, "repo_root": Path(".")})
    assert "github_work_issue" in reg
    assert "github_fix_failed_checks" in reg
