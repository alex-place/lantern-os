"""#1208 — Σ₀ adapter eval metric helpers. Pure functions, no GPU/torch needed.

Run: python -m pytest tests/test_sigma0_eval.py -q
"""
import importlib.util
import os

_path = os.path.join(os.path.dirname(__file__), "..", "scripts", "eval_sigma0_adapter.py")
_spec = importlib.util.spec_from_file_location("eval_sigma0_adapter", _path)
ev = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ev)


def test_parse_confidence_forms():
    assert ev.parse_confidence("…\nconfidence: 0.9") == 0.9
    assert ev.parse_confidence("Confidence 85%") == 0.85
    assert ev.parse_confidence("conf=0.4 here") == 0.4
    assert ev.parse_confidence("no number here") is None
    assert ev.parse_confidence("confidence: 250%") is None  # out of range rejected


def test_is_abstention():
    assert ev.is_abstention("I have insufficient evidence to answer.")
    assert ev.is_abstention("I cannot determine that from what's given.")
    assert ev.is_abstention("It's probably 8080. confidence: 0.1")  # low conf => abstain
    assert not ev.is_abstention("It is 8080. confidence: 0.95")     # confident answer
    assert not ev.is_abstention("The function returns the sum.")


def test_has_sigma0_format():
    assert ev.has_sigma0_format("claim: X\nevidence: Y\nconfidence: 0.8")
    assert not ev.has_sigma0_format("just some prose with one source word")  # only 1 marker


def test_ece_perfect_vs_bad():
    # perfectly calibrated: conf 1.0 & correct, conf 0.0 & wrong -> ECE ~0
    assert ev.compute_ece([(1.0, True), (1.0, True), (0.0, False)]) == 0.0
    # overconfident-and-wrong -> large ECE
    assert ev.compute_ece([(0.95, False), (0.9, False)]) > 0.8
    assert ev.compute_ece([]) is None


def test_brier():
    assert ev.brier([(1.0, True), (0.0, False)]) == 0.0          # perfect
    assert ev.brier([(1.0, False)]) == 1.0                        # worst
    assert ev.brier([]) is None


def test_noevidence_probes_exist():
    # the abstention metric needs probes the model can't answer from given context
    assert len(ev.NO_EVIDENCE_PROMPTS) >= 3
    assert all("confidence" in p.lower() for p in ev.NO_EVIDENCE_PROMPTS)
