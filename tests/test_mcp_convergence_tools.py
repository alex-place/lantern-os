"""Unit tests for the MCP convergence / workflow tools (offline — gh is stubbed)."""
import sys
import json
from pathlib import Path

import pytest

# Put src/mcp_server on the path the same way server.py does, so the flat
# `import convergence_tools` / `import github_tools` resolve under pytest too.
_MCP = Path(__file__).resolve().parents[1] / "src" / "mcp_server"
sys.path.insert(0, str(_MCP))

import convergence_tools as ct  # noqa: E402
import github_tools as gt  # noqa: E402


def _wire(queue=None, run=None):
    """Reset the module context (live queue + helpers) for each test."""
    ct.register({}, {
        "task_queue": [] if queue is None else queue,
        "run_task": run or (lambda tid: {"ok": True, "status": "done", "confidence": 0.3}),
        "append_jsonl": lambda p, o: True,
        "repo_root": Path("."),
    })


def test_register_populates_registry():
    reg = {}
    added = ct.register(reg, {"task_queue": [], "run_task": lambda x: {},
                              "append_jsonl": lambda *a: True, "repo_root": Path(".")})
    for name in ("convergence_run", "github_triage_prs", "github_pr_status", "worker_tick", "lantern_command"):
        assert name in reg
    assert set(added) == set(ct.CONVERGENCE_TOOLS)


def test_classify_pr():
    assert ct._classify_pr("MERGEABLE", "CLEAN", [], 0, False)[0] == "ready"
    assert ct._classify_pr("CONFLICTING", "DIRTY", [], 0, False)[0] == "conflicting"
    assert ct._classify_pr("MERGEABLE", "UNSTABLE", ["Slop Check"], 0, False)[0] == "blocked"
    assert ct._classify_pr("MERGEABLE", "BEHIND", [], 0, False)[0] == "stale"
    assert ct._classify_pr("MERGEABLE", "CLEAN", [], 2, False)[0] == "checks_running"
    assert ct._classify_pr("MERGEABLE", "CLEAN", [], 0, True)[0] == "draft"


def test_safety_gates():
    assert ct.repo_allowed("alex-place", "lantern-os")
    assert not ct.repo_allowed("evil", "repo")
    assert ct.branch_allowed("mcp/fix-1")
    assert ct.branch_allowed("claude/x")
    assert ct.branch_allowed("fix/y")
    assert not ct.branch_allowed("master")          # never write the base branch
    assert not ct.branch_allowed("random-branch")   # disallowed prefix


def test_convergance_and_convergence_alias(monkeypatch):
    _wire()
    monkeypatch.setattr(gt, "_run_gh", lambda *a, **k: "[]")
    monkeypatch.setattr(gt, "github_list_issues", lambda *a, **k: {"issues": []})
    for cmd in ("!convergance", "!convergence", "convergance"):
        r = ct.lantern_command(cmd)
        assert r["ok"] and r["routed_to"] == "convergence_run"
        assert r["result"]["mode"] == "triage"


def test_autonomous_work_parses_issue_number(monkeypatch):
    _wire()
    monkeypatch.setattr(gt, "github_get_issue", lambda o, r, n: {"title": "x", "state": "OPEN", "labels": [], "body": "b"})
    r = ct.lantern_command("!autonomous-work 123")
    assert r["ok"] and r["issue"] == 123
    assert not ct.lantern_command("!autonomous-work")["ok"]


def test_pr_status_command_parses(monkeypatch):
    _wire()
    monkeypatch.setattr(ct, "github_pr_status", lambda o, r, n: {"ok": True, "number": n, "status": "ready"})
    r = ct.lantern_command("!pr-status 745")
    assert r["routed_to"] == "github_pr_status" and r["result"]["number"] == 745


def test_queue_run_routes_to_worker_tick():
    ran = []
    _wire(queue=[{"id": "a", "status": "pending"}],
          run=lambda tid: (ran.append(tid), {"ok": True, "status": "done"})[1])
    r = ct.lantern_command("!queue-run")
    assert r["routed_to"] == "worker_tick"
    assert ran == ["a"]


def test_worker_tick_picks_one_pending():
    ran = []
    _wire(queue=[{"id": "t1", "status": "pending"}, {"id": "t2", "status": "done"},
                 {"id": "t3", "status": "pending"}],
          run=lambda tid: (ran.append(tid), {"ok": True, "status": "done"})[1])
    r = ct.worker_tick(limit=1)
    assert r["ran"] == 1 and ran == ["t1"]


def test_worker_tick_no_pending():
    _wire(queue=[{"id": "t", "status": "done"}])
    r = ct.worker_tick()
    assert r["ran"] == 0 and r["note"]


def test_unknown_command_lists_known():
    _wire()
    r = ct.lantern_command("!nope")
    assert not r["ok"] and "known" in r


def test_github_triage_ranks_blocked_after_ready(monkeypatch):
    _wire()
    views = {
        1: {"number": 1, "title": "blocked", "headRefName": "feat/a", "mergeable": "MERGEABLE",
            "mergeStateStatus": "UNSTABLE", "isDraft": False, "labels": [],
            "statusCheckRollup": [{"name": "Slop Check", "conclusion": "FAILURE"}], "reviewDecision": ""},
        2: {"number": 2, "title": "ready", "headRefName": "feat/b", "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN", "isDraft": False, "labels": [],
            "statusCheckRollup": [{"name": "CI", "conclusion": "SUCCESS"}], "reviewDecision": ""},
    }

    def fake_run_gh(args, *a, **k):
        if args[:2] == ["pr", "list"]:
            return json.dumps([{"number": 1}, {"number": 2}])
        if args[:2] == ["pr", "view"]:
            return json.dumps(views[int(args[2])])
        return "[]"

    monkeypatch.setattr(gt, "_run_gh", fake_run_gh)
    r = ct.github_triage_prs("alex-place", "lantern-os")
    assert r["ok"] and [p["number"] for p in r["prs"]] == [2, 1]   # ready before blocked
    assert r["prs"][1]["status"] == "blocked" and "Slop Check" in r["prs"][1]["blockers"]
