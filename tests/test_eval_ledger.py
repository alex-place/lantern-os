"""Tests for the leaderboard provenance helper (#2108)."""
import importlib.util
import json
import os

_SPEC = importlib.util.spec_from_file_location(
    "eval_ledger",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "eval_ledger.py"),
)
eval_ledger = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(eval_ledger)


def test_stamp_adds_git_sha_and_campaign_id():
    row = {"benchmark": "coding", "pass@1": 0.5}
    stamped = eval_ledger.stamp_provenance(row)
    # git_sha + campaign_id are always present after stamping (sha may be None off-git,
    # but the key exists so a reader can group without a KeyError).
    assert "git_sha" in stamped
    assert stamped["campaign_id"], "campaign_id must be a non-empty grouping key"


def test_explicit_campaign_id_wins(monkeypatch):
    monkeypatch.setenv("EVAL_CAMPAIGN_ID", "suite-2026-07-05")
    assert eval_ledger.campaign_id() == "suite-2026-07-05"


def test_campaign_id_falls_back_to_sha(monkeypatch):
    monkeypatch.delenv("EVAL_CAMPAIGN_ID", raising=False)
    cid = eval_ledger.campaign_id()
    assert cid.startswith("sha:") or cid == "uncommitted"


def test_served_checkpoint_from_env(monkeypatch):
    monkeypatch.setenv("OURO_MODEL", "ByteDance/Ouro-1.4B")
    monkeypatch.setenv("OURO_ADAPTER", "/models/ouro-honesty-balanced/final")
    assert eval_ledger.served_checkpoint() == "ByteDance/Ouro-1.4B@final"


def test_served_checkpoint_none_when_unset(monkeypatch):
    monkeypatch.delenv("OURO_MODEL", raising=False)
    monkeypatch.delenv("KEYSTONE_SERVE_OURO_MODEL", raising=False)
    monkeypatch.delenv("OURO_ADAPTER", raising=False)
    assert eval_ledger.served_checkpoint() is None


def test_caller_set_value_not_clobbered():
    row = {"git_sha": "deadbeef", "campaign_id": "mine"}
    eval_ledger.stamp_provenance(row)
    assert row["git_sha"] == "deadbeef"
    assert row["campaign_id"] == "mine"


def test_append_writes_one_stamped_line(tmp_path):
    path = tmp_path / "lb.jsonl"
    eval_ledger.append_leaderboard({"benchmark": "coding", "pass@1": 1.0}, path=str(path))
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    row = json.loads(lines[0])
    assert row["benchmark"] == "coding" and "campaign_id" in row
