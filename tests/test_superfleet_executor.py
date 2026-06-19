"""
Superfleet Phase 3 — sandboxed executor tests.

These prove the executor flow end-to-end against a THROWAWAY git repo created in
a temp dir. Nothing here touches the canonical repo or any real remote: every
test builds its own `git init` sandbox, and the executor's worktree is always
created and removed under tmp_path. This is the "dry-run that proves the flow
without mutating real repos" required by the task.
"""

import importlib.util
import subprocess
from pathlib import Path

import pytest

# Import executor.py directly by path (it lives in src/mcp_server, which is on
# sys.path at server runtime but not on pytest's default pythonpath).
_EXEC_PATH = Path(__file__).resolve().parents[1] / "src" / "mcp_server" / "executor.py"
_spec = importlib.util.spec_from_file_location("superfleet_executor", _EXEC_PATH)
executor = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(executor)


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)


@pytest.fixture
def sandbox_repo(tmp_path):
    """A throwaway git repo with one committed file on `master`."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    _git(repo, "config", "user.email", "t@t.local")
    _git(repo, "config", "user.name", "Test")
    (repo / "mod.py").write_text("x = 1\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    return repo


def _sinks():
    rec, rcpt, fail = [], [], []
    return rec, rcpt, fail, {
        "append_record": rec.append,
        "append_receipt": rcpt.append,
        "record_failure": fail.append,
    }


def test_gate_off_by_default(sandbox_repo, monkeypatch):
    """With the env flag unset and dry_run False, execution is refused."""
    monkeypatch.delenv(executor.ENV_FLAG, raising=False)
    rec, rcpt, fail, sinks = _sinks()
    res = executor.execute_task({"id": "t1", "description": "noop"}, sandbox_repo, dry_run=False, **sinks)
    assert res["ok"] is False
    assert res["error"] == "executor_disabled"
    # No worktree branch should linger.
    assert "superfleet/fix" not in _git(sandbox_repo, "branch").stdout


def test_dry_run_no_changes_no_commit(sandbox_repo, monkeypatch):
    """Default no-op coder + dry-run: flow runs, nothing committed/pushed, sandbox gone."""
    monkeypatch.delenv(executor.ENV_FLAG, raising=False)  # dry_run bypasses the gate
    rec, rcpt, fail, sinks = _sinks()
    res = executor.execute_task({"id": "t2", "description": "explore"}, sandbox_repo, dry_run=True, **sinks)
    assert res["committed"] is False
    assert res["pushed"] is False
    assert res["dry_run"] is True
    # Sandbox worktree removed.
    assert not Path(res["sandbox"]).exists()
    # No fix branch left behind (no commit was made).
    assert res["fix_branch"] not in _git(sandbox_repo, "branch").stdout
    # A convergence record + receipt were emitted regardless.
    assert len(rec) == 1 and len(rcpt) == 1


def test_dry_run_verified_change_not_committed(sandbox_repo, monkeypatch):
    """A coder that makes a VALID edit: dry-run verifies it but does NOT commit/push."""
    monkeypatch.delenv(executor.ENV_FLAG, raising=False)

    def coder(sandbox, task):
        (Path(sandbox) / "new.py").write_text("y = 2\n", encoding="utf-8")
        return {"changed": ["new.py"], "summary": "add new.py", "evidence": ["new.py"]}

    rec, rcpt, fail, sinks = _sinks()
    res = executor.execute_task(
        {"id": "t3", "description": "add a file"}, sandbox_repo, coder=coder, dry_run=True, **sinks
    )
    assert res["verified"] is True
    assert res["ok"] is True
    assert res["committed"] is False  # dry-run never commits
    assert res["pushed"] is False
    assert res["stage"] == "converge-dry-run"
    assert res["confidence"] == executor.VERIFIED_EXECUTOR_CONFIDENCE
    assert not Path(res["sandbox"]).exists()
    assert len(rec) == 1 and len(rcpt) == 1


def test_enabled_commit_no_push(sandbox_repo, monkeypatch):
    """Flag on, push off: a valid change is verified + COMMITTED to a fix branch,
    never pushed, never merged. Sandbox cleaned; commit retained on the branch."""
    monkeypatch.setenv(executor.ENV_FLAG, "1")
    monkeypatch.delenv(executor.ENV_PUSH, raising=False)

    def coder(sandbox, task):
        (Path(sandbox) / "added.py").write_text("z = 3\n", encoding="utf-8")
        return {"changed": ["added.py"], "summary": "add added.py"}

    rec, rcpt, fail, sinks = _sinks()
    res = executor.execute_task(
        {"id": "t4", "description": "commit a file"}, sandbox_repo, coder=coder, dry_run=False, **sinks
    )
    assert res["ok"] is True
    assert res["verified"] is True
    assert res["committed"] is True
    assert res["pushed"] is False
    branch = res["fix_branch"]
    # The fix branch exists and master is unchanged (no merge).
    assert branch in _git(sandbox_repo, "branch").stdout
    assert _git(sandbox_repo, "rev-parse", "master").stdout != _git(sandbox_repo, "rev-parse", branch).stdout
    # Master still has exactly the original file.
    assert (sandbox_repo / "mod.py").exists()
    assert not (sandbox_repo / "added.py").exists()  # change lives only on the branch
    assert not Path(res["sandbox"]).exists()
    assert len(fail) == 0


def test_verification_failure_records_pattern(sandbox_repo, monkeypatch):
    """A coder that writes BROKEN python: verification fails, failure pattern recorded,
    nothing committed, branch dropped."""
    monkeypatch.setenv(executor.ENV_FLAG, "1")

    def coder(sandbox, task):
        (Path(sandbox) / "broken.py").write_text("def (:\n", encoding="utf-8")  # syntax error
        return {"changed": ["broken.py"], "summary": "write broken file"}

    rec, rcpt, fail, sinks = _sinks()
    res = executor.execute_task(
        {"id": "t5", "description": "introduce a bug"}, sandbox_repo, coder=coder, dry_run=False, **sinks
    )
    assert res["ok"] is False
    assert res["verified"] is False
    assert res["committed"] is False
    assert res["stage"] == "verify"
    assert len(fail) == 1  # failure pattern recorded (learning signal)
    assert fail[0]["error"] == "verification_failed"
    # No fix branch lingering.
    assert res["fix_branch"] not in _git(sandbox_repo, "branch").stdout
    assert not Path(res["sandbox"]).exists()


def test_select_verification_languages(tmp_path):
    """Verification command selection is language-aware and bounded."""
    cmds = executor.select_verification(tmp_path, ["a.py", "b.js", "c.txt"])
    flat = [" ".join(c) for c in cmds]
    assert any("py_compile" in f for f in flat)
    assert any("node --check b.js" in f for f in flat)
