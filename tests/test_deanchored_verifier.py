"""Regression test for the de-anchored verification primitive
(experiments/deanchored_verifier.py; grounds arXiv:2607.05904, niche per arXiv:2607.07663).
Pins the mechanism on the deterministic mock: an ANCHORED judge rubber-stamps plausible wrong
answers (high false-positive rate = the reward-hacking basin), while a DE-ANCHORED (commit-first)
judge cuts false-positives sharply and discriminates far better — with no external ground truth.
"""
import json
from pathlib import Path

import pytest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "experiments"))
import deanchored_verifier as m  # noqa: E402


def test_last_int():
    assert m.last_int("the answer is 1,234.") == 1234
    assert m.last_int("no numbers here") is None
    assert m.last_int("ANSWER: -7") == -7


def test_deanchoring_cuts_false_positives_on_mock():
    chat = m.make_mock(seed=0)
    r = m.evaluate(chat, m.selftest_items(24))
    a, d = r["anchored"], r["deanchored"]
    assert a["fpr"] > 0.4, a                       # anchored judge lives in the plausibility basin
    assert d["fpr"] < a["fpr"] - 0.3, (d, a)       # de-anchoring cuts false positives sharply
    assert d["discrimination"] > a["discrimination"], (d, a)  # and discriminates better


def test_deanchored_judge_rejects_disagreeing_candidate():
    # a solver that commits 42 must reject a candidate of 99 and accept 42 — no external truth used
    chat = lambda u: "reasoning... ANSWER: 42"  # noqa: E731
    assert m.judge_deanchored(chat, "q", 42) is True
    assert m.judge_deanchored(chat, "q", 99) is False


def test_committed_report_reproduced():
    p = Path(__file__).resolve().parent.parent / "data" / "sigma0" / "deanchored_verifier_report.json"
    if not p.exists():
        pytest.skip("run experiments/deanchored_verifier.py --self-test first")
    r = json.loads(p.read_text(encoding="utf-8"))
    assert r["reproduced_deanchoring_beats_anchored"] is True
    assert r["false_positive_reduction"] > 0.2
