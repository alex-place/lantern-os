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
    # The generic "final" leaf is qualified by its run dir so this row is distinguishable
    # from any other run's ".../final" adapter (the #2766 provenance fix).
    assert eval_ledger.served_checkpoint() == "ByteDance/Ouro-1.4B@ouro-honesty-balanced-final"


def test_served_checkpoint_none_when_unset(monkeypatch):
    monkeypatch.delenv("OURO_MODEL", raising=False)
    monkeypatch.delenv("KEYSTONE_SERVE_OURO_MODEL", raising=False)
    monkeypatch.delenv("OURO_ADAPTER", raising=False)
    assert eval_ledger.served_checkpoint() is None


def test_non_ouro_engine_ignores_ouro_env(monkeypatch):
    """Regression: leaderboard row qwen25coder-onbox-2173 (benchmark coding, engine
    http, model qwen2.5-coder:latest) was stamped served_checkpoint=ouro@checkpoint-600
    because the box's OURO_* serving env was read unconditionally. A non-Ouro engine
    must stamp the run's own --model arg, not the serving config."""
    monkeypatch.setenv("OURO_MODEL", "ouro")
    monkeypatch.setenv("OURO_ADAPTER", "/models/ck/checkpoint-600")
    row = {"benchmark": "coding", "engine": "http", "model": "qwen2.5-coder:latest"}
    eval_ledger.stamp_provenance(row)
    assert row["served_checkpoint"] == "qwen2.5-coder:latest"


def test_ouro_engines_still_inherit_env(monkeypatch):
    monkeypatch.setenv("OURO_MODEL", "ByteDance/Ouro-1.4B")
    monkeypatch.setenv("OURO_ADAPTER", "/models/ck/checkpoint-600")
    for engine in ("loop", "ouro-fast-cached"):
        row = {"benchmark": "coding", "engine": engine, "model": "ouro:latest"}
        eval_ledger.stamp_provenance(row)
        assert row["served_checkpoint"] == "ByteDance/Ouro-1.4B@checkpoint-600", engine


def test_ouro_engine_env_unset_falls_back_to_base_model(monkeypatch):
    for var in ("OURO_MODEL", "KEYSTONE_SERVE_OURO_MODEL", "OURO_ADAPTER"):
        monkeypatch.delenv(var, raising=False)
    row = {"benchmark": "humaneval", "engine": "ouro-fast-cached",
           "base_model": "ByteDance/Ouro-1.4B"}
    eval_ledger.stamp_provenance(row)
    assert row["served_checkpoint"] == "ByteDance/Ouro-1.4B"


def test_chat_row_unanimous_served_models(monkeypatch):
    monkeypatch.setenv("OURO_MODEL", "ouro")
    monkeypatch.setenv("OURO_ADAPTER", "/models/ck/checkpoint-600")
    row = {"benchmark": "humaneval-chat", "engine": "keystone-chat",
           "served_models": {"qwen2.5-coder:latest": 164}}
    eval_ledger.stamp_provenance(row)
    assert row["served_checkpoint"] == "qwen2.5-coder:latest"


def test_chat_row_mixed_served_models_not_stamped(monkeypatch):
    monkeypatch.setenv("OURO_MODEL", "ouro")
    row = {"benchmark": "humaneval-chat", "engine": "keystone-chat",
           "served_models": {"qwen2.5-coder:latest": 100, "gpt-4o-mini": 64}}
    eval_ledger.stamp_provenance(row)
    # A mixed serve has no single checkpoint — don't invent one; the histogram stays.
    assert "served_checkpoint" not in row


def test_signal_less_row_keeps_env_fallback(monkeypatch):
    monkeypatch.setenv("OURO_MODEL", "ByteDance/Ouro-1.4B")
    monkeypatch.delenv("OURO_ADAPTER", raising=False)
    row = {"benchmark": "misc"}
    eval_ledger.stamp_provenance(row)
    assert row["served_checkpoint"] == "ByteDance/Ouro-1.4B"


def test_checkpoint_id_shapes():
    assert eval_ledger.checkpoint_id("m", None) == "m"
    assert eval_ledger.checkpoint_id("m", "/x/checkpoint-600/") == "m@checkpoint-600"
    # A generic leaf dir ("final") is qualified with its parent so it names the run.
    assert eval_ledger.checkpoint_id(None, "/adapters/final") == "ouro@adapters-final"
    assert eval_ledger.checkpoint_id(None, None) is None


def test_checkpoint_id_generic_leaf_does_not_collapse_distinct_adapters():
    """The provenance bug: every training run's final-checkpoint dir is named `final`, so a
    basename-only id stamped BOTH ouro-sigma0-adapters/final and ouro-distill/<tag>/final as
    `@final` — the ledger could no longer tell which adapter produced a HumanEval row. Distinct
    adapters must now get distinct ids (regression guard for #2766)."""
    sigma0 = eval_ledger.checkpoint_id("ouro", "D:/lantern-train/ouro-sigma0-adapters/final")
    distill = eval_ledger.checkpoint_id("ouro", "D:/lantern-train/ouro-distill/lr5e5-r16/final")
    assert sigma0 == "ouro@ouro-sigma0-adapters-final"
    assert distill == "ouro@lr5e5-r16-final"
    assert sigma0 != distill
    # An already-unique leaf (checkpoint-600) is untouched — no needless parent noise.
    assert eval_ledger.checkpoint_id("ouro", "/x/ck/checkpoint-600") == "ouro@checkpoint-600"
    # Backslash paths (Windows) resolve the same way.
    assert eval_ledger.checkpoint_id("ouro", r"D:\lantern-train\run-A\best") == "ouro@run-A-best"


def test_writer_stamp_beats_env_for_ouro_engine(monkeypatch):
    """An in-process harness can load a --base-model/--adapter that diverges from the
    box's OURO_* env (ledger row ouro-coding-v3-he20: engine ouro-fast-cached but
    base_model Qwen/Qwen2.5-Coder-3B-Instruct). Writers stamp checkpoint_id(args)
    themselves and stamp_provenance must keep it over the env."""
    monkeypatch.setenv("OURO_MODEL", "ByteDance/Ouro-1.4B")
    monkeypatch.setenv("OURO_ADAPTER", "/models/ck/checkpoint-600")
    row = {"benchmark": "humaneval", "engine": "ouro-fast-cached",
           "base_model": "Qwen/Qwen2.5-Coder-3B-Instruct",
           "served_checkpoint": eval_ledger.checkpoint_id("Qwen/Qwen2.5-Coder-3B-Instruct", None)}
    eval_ledger.stamp_provenance(row)
    assert row["served_checkpoint"] == "Qwen/Qwen2.5-Coder-3B-Instruct"


def test_caller_set_served_checkpoint_not_clobbered(monkeypatch):
    monkeypatch.setenv("OURO_MODEL", "ouro")
    row = {"engine": "loop", "served_checkpoint": "replayed@ck123"}
    eval_ledger.stamp_provenance(row)
    assert row["served_checkpoint"] == "replayed@ck123"


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
