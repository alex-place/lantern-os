"""Regression test for the RSI gated-vs-ungrounded toy
(experiments/rsi_gated_vs_ungrounded.py). Pins the pre-registered findings: ungrounded
recursive self-improvement self-corrupts (assessor-bias ratchet → precision decays,
believed/true delusion explodes) while a Σ_θ-style external gate keeps improvement real and
bounded, and the gated improvement rate is verification-throughput-limited. Demonstrates the
certificate's results at RSI scale for AGI-CONVERGENCE-BLUEPRINT §CONVERGE — not new theory.
"""
import json
from pathlib import Path

import pytest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "experiments"))
import rsi_gated_vs_ungrounded as m  # noqa: E402


def _arm(name, seeds=60, k=m.K_DEFAULT):
    return m.summarize([m.run_arm(name, s, k=k) for s in range(seeds)])


def test_ungrounded_self_deludes_and_decays():
    u = _arm("ungrounded")
    # believed >> true (self-delusion) and late precision below early (assessor-bias ratchet)
    assert u["delusion_median"] > 1.5, u
    assert u["precision_late"] < u["precision_early"], u


def test_gate_bounds_and_does_not_underperform():
    u, g = _arm("ungrounded"), _arm("gated")
    assert g["true_median"] >= u["true_median"], (g["true_median"], u["true_median"])
    assert g["true_iqr"] < u["true_iqr"], (g["true_iqr"], u["true_iqr"])   # lower dispersion
    assert g["crash_rate"] <= u["crash_rate"]
    assert g["delusion_median"] < 1.3                                       # gate stays honest


def test_verification_throughput_limited():
    # more frequent external verification (smaller k) -> more true improvement
    fast = _arm("gated", k=1)["true_median"]
    slow = _arm("gated", k=8)["true_median"]
    assert fast > slow + 0.05, (fast, slow)


def test_committed_report_reproduced():
    p = Path(__file__).resolve().parent.parent / "data" / "sigma0" / "rsi_gated_report.json"
    if not p.exists():
        pytest.skip("run experiments/rsi_gated_vs_ungrounded.py first")
    r = json.loads(p.read_text(encoding="utf-8"))
    assert r["reproduced"] is True
    v = r["verdicts"]
    assert v["H1_delusion_and_precision_decay"] and v["H2_gated_bounded_and_no_worse"]
    assert v["H3_throughput_limited"] and not v["kill_grounding_adds_nothing"]
