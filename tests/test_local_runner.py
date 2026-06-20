"""Tests for the local deterministic repo-fix runner (src/mcp_server/local_runner.py).

Focus on the safety rails — forbidden paths, secret detection, edit-scope enforcement,
path traversal, test-command allowlist — plus the happy paths for read / worktree /
patch / test / recipes / receipts. Uses a throwaway git repo in tmp_path.
"""
import subprocess

import pytest

import src.mcp_server.local_runner as lr


def _git(args, cwd):
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    _git(["init", "-b", "master"], root)
    _git(["config", "user.email", "t@t.com"], root)
    _git(["config", "user.name", "t"], root)
    (root / "foo.py").write_text('print("hello world")\n', encoding="utf-8")
    (root / "README.md").write_text("# repo\n", encoding="utf-8")
    (root / ".env").write_text("SECRET=abc\n", encoding="utf-8")
    _git(["add", "-A"], root)
    _git(["commit", "-m", "init"], root)

    monkeypatch.setattr(lr, "REPO_ROOT", root)
    monkeypatch.setattr(lr, "WORKTREE_BASE", tmp_path / "wt")
    monkeypatch.setattr(lr, "RECEIPTS_PATH", tmp_path / "receipts.jsonl")
    return root


# ── read-only ────────────────────────────────────────────────────────────────
def test_repo_status(repo):
    s = lr.local_repo_status()
    assert s["ok"] and s["branch"] == "master" and s["clean"] is True and s["sha"]


def test_repo_search(repo):
    r = lr.local_repo_search("hello world", glob="*.py")
    assert r["ok"] and r["count"] >= 1
    assert any(h["file"].endswith("foo.py") for h in r["results"])


def test_file_read_ok_and_guards(repo):
    ok = lr.local_file_read("foo.py")
    assert ok["ok"] and "hello world" in ok["content"]
    assert lr.local_file_read(".env")["ok"] is False          # forbidden
    assert lr.local_file_read("../../etc/passwd")["ok"] is False  # traversal


# ── safety primitives ─────────────────────────────────────────────────────────
def test_is_forbidden():
    assert lr._is_forbidden(".env")
    assert lr._is_forbidden("data/private/x.json")
    assert lr._is_forbidden("keys/id_rsa")
    assert not lr._is_forbidden("src/app.py")


def test_secret_scan():
    assert "anthropic_key" in lr._scan_secrets('x = "sk-ant-abcdefghijklmnopqrstuvwxyz0123"')
    assert "private_key_block" in lr._scan_secrets("-----BEGIN RSA PRIVATE KEY-----")
    assert lr._scan_secrets("just a normal line of code") == []


# ── worktree sandbox ──────────────────────────────────────────────────────────
def test_worktree_create_and_destroy(repo):
    c = lr.local_worktree_create("task1", base="master")
    assert c["ok"], c
    assert c["branch"] == "mcp-local/task1"
    from pathlib import Path
    assert Path(c["worktree"]).exists()
    d = lr.local_worktree_destroy("task1")
    assert d["ok"]
    assert not Path(c["worktree"]).exists()


# ── deterministic patch gate ──────────────────────────────────────────────────
def test_patch_apply_happy(repo):
    c = lr.local_worktree_create("p1", base="master")
    wt = c["worktree"]
    # Generate a real git diff, revert, then apply it through the runner.
    (repo_foo := __import__("pathlib").Path(wt) / "foo.py").write_text(
        'print("hello world")\n# added by test\n', encoding="utf-8")
    patch = _git(["diff"], wt).stdout
    _git(["checkout", "--", "foo.py"], wt)
    res = lr.local_patch_apply("p1", patch, allowed_globs="*.py")
    assert res["ok"] and res["applied"], res
    assert "# added by test" in repo_foo.read_text(encoding="utf-8")
    lr.local_worktree_destroy("p1")


def test_patch_apply_rejects_forbidden(repo):
    lr.local_worktree_create("p2", base="master")
    patch = "--- a/.env\n+++ b/.env\n@@ -1 +1,2 @@\n SECRET=abc\n+EXTRA=1\n"
    res = lr.local_patch_apply("p2", patch)
    assert res["applied"] is False
    assert any("forbidden" in r["reason"] for r in res["rejected"])
    lr.local_worktree_destroy("p2")


def test_patch_apply_rejects_secret(repo):
    lr.local_worktree_create("p3", base="master")
    patch = ('--- a/foo.py\n+++ b/foo.py\n@@ -1 +1,2 @@\n print("hello world")\n'
             '+API_KEY = "sk-ant-abcdefghijklmnopqrstuvwxyz0123"\n')
    res = lr.local_patch_apply("p3", patch)
    assert res["applied"] is False
    assert any("secret" in r["reason"] for r in res["rejected"])
    lr.local_worktree_destroy("p3")


def test_patch_apply_rejects_out_of_scope(repo):
    lr.local_worktree_create("p4", base="master")
    patch = ('--- a/foo.py\n+++ b/foo.py\n@@ -1 +1,2 @@\n print("hello world")\n+# x\n')
    res = lr.local_patch_apply("p4", patch, allowed_globs="docs/*")
    assert res["applied"] is False
    assert any("allowed_globs" in r["reason"] for r in res["rejected"])
    lr.local_worktree_destroy("p4")


def test_patch_apply_requires_worktree(repo):
    res = lr.local_patch_apply("no-such-task", "--- a/foo.py\n+++ b/foo.py\n")
    assert res["ok"] is False and "worktree" in res["error"]


# ── test-command gate ─────────────────────────────────────────────────────────
def test_test_run_rejects_arbitrary_shell(repo):
    res = lr.local_test_run("rm -rf /tmp/whatever")
    assert res["ok"] is False and "not allowlisted" in res["error"]


def test_test_run_allows_listed(repo):
    res = lr.local_test_run("python -m pytest --version")
    assert "error" not in res or "not allowlisted" not in res.get("error", "")
    assert "exit_code" in res


# ── recipes + receipts ────────────────────────────────────────────────────────
def test_recipe_list_and_run(repo):
    rl = lr.recipe_list()
    assert rl["ok"] and "failed_check" in rl["recipes"] and "role_rename" in rl["recipes"]
    rr = lr.recipe_run("role_rename", issue="698", task_id="t9")
    assert rr["ok"] and rr["contract"]["required_tests"]
    assert lr.recipe_run("nope")["ok"] is False


def test_worker_status_and_receipts(repo):
    lr.local_worktree_create("rcpt", base="master")
    st = lr.worker_status()
    assert st["ok"] and st["recipes"] >= 7
    rg = lr.receipt_get("rcpt")
    assert rg["ok"] and rg["count"] >= 1  # worktree_create wrote a receipt
    lr.local_worktree_destroy("rcpt")
