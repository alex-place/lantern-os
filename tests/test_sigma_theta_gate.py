"""CI coverage for the Σ_θ A/B/C release gate + decision tree (ADR-0025 / cert §8.1.2).

The gate logic is the load-bearing Verify-stage code that decides whether a weight update may
ship. It must be exercised in CI (no GPU) so a regression in the promotion logic is caught before
any L4 spend. Imports the harness module directly and asserts each planted failure is rejected.
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "sigma_theta_harness",
    os.path.join(ROOT, "experiments", "sigma_theta_abc", "harness.py"),
)
H = importlib.util.module_from_spec(_spec)
sys.modules["sigma_theta_harness"] = H   # register before exec so @dataclass can resolve __module__
_spec.loader.exec_module(H)

CFG = H.GateConfig()

def _good():
    return dict(fresh_pass1=0.86, incumbent_fresh_pass1=0.82, retention_pass1=0.90,
                incumbent_retention_pass1=0.90, proxy_reward=0.8, incumbent_proxy_reward=0.7,
                world_eval=0.85, incumbent_world_eval=0.83, kl_from_prior=0.05, adapter_norm=4.0,
                stability_ok=True, no_contamination=True, provenance_present=True,
                rollback_available=True)


def test_selftest_all_pass():
    assert H.selftest() == 0


def test_clean_improvement_accepted():
    assert H.sigma_theta_gate(_good(), CFG)["accept"] is True


def test_reward_hack_rejected():
    hack = dict(_good(), proxy_reward=0.95, world_eval=0.80)  # proxy up, world below incumbent
    g = H.sigma_theta_gate(hack, CFG)
    assert not g["accept"] and "3_reward_integrity" in g["failed"]


def test_forgetting_rejected():
    forget = dict(_good(), retention_pass1=0.85)  # 0.05 drop > eps
    assert "2_retention" in H.sigma_theta_gate(forget, CFG)["failed"]


def test_instability_rejected():
    assert "5_stability" in H.sigma_theta_gate(dict(_good(), stability_ok=False), CFG)["failed"]


def test_drift_rejected():
    assert "4_drift" in H.sigma_theta_gate(dict(_good(), kl_from_prior=0.30), CFG)["failed"]


def test_decision_none_beats_retrieval_stops_updates():
    g = _good()
    res = {"retrieval": dict(g, fresh_pass1=0.86), "A": dict(g, fresh_pass1=0.865),
           "B": dict(g, fresh_pass1=0.865), "C": dict(g, fresh_pass1=0.865)}
    assert H.abc_decision(res, CFG)["winner"] is None


def test_decision_c_wins_when_rlvr_helps():
    g = _good()
    res = {"retrieval": dict(g, fresh_pass1=0.80), "A": dict(g, fresh_pass1=0.84),
           "B": dict(g, fresh_pass1=0.86, retention_pass1=0.90),
           "C": dict(g, fresh_pass1=0.90, retention_pass1=0.90, proxy_reward=0.8, world_eval=0.89)}
    d = H.abc_decision(res, CFG)
    assert d["winner"] == "C" and d["rl_enabled"] is True


def test_plan_commands_wires_each_arm_to_the_right_trainer():
    class A:
        base = "ByteDance/Ouro-1.4B"
        out = "runs/abc"
    plans = H.plan_commands(A())
    assert [p["arm"] for p in plans] == ["A", "B", "C"]
    byarm = {p["arm"]: " ".join(p["cmd"]) for p in plans}
    assert "train-qlora-ouro.py" in byarm["A"] and "rlvr_grpo_ouro.py" not in byarm["A"]
    assert "rlvr_grpo_ouro.py" in byarm["C"] and "--warm-start" in byarm["C"]  # C warm-starts from B


def test_decide_reports_winner_and_gates():
    g = _good()
    res = {"retrieval": dict(g, fresh_pass1=0.80), "A": dict(g, fresh_pass1=0.84),
           "B": dict(g, fresh_pass1=0.86, retention_pass1=0.90),
           "C": dict(g, fresh_pass1=0.90, retention_pass1=0.90, proxy_reward=0.8, world_eval=0.89)}
    rep = H.decide(res)
    assert rep["decision"]["winner"] == "C"
    assert set(rep["gates"]) == {"A", "B", "C"}


def test_decide_stops_updates_when_none_beat_retrieval():
    g = _good()
    res = {"retrieval": dict(g, fresh_pass1=0.86), "A": dict(g, fresh_pass1=0.865),
           "B": dict(g, fresh_pass1=0.865), "C": dict(g, fresh_pass1=0.865)}
    assert H.decide(res)["decision"]["winner"] is None
