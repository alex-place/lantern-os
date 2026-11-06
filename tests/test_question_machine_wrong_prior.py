"""Tests for the wrong-prior benchmark (experiments/question_machine_wrong_prior.py).

They pin three things:
  - the design that makes it a fair test: the passive run refutes h0 but cannot separate h1 to h3, and
    only pushing x3 can;
  - the measured limit of the shipped Question Machine: its seam asks about a direction every live
    hypothesis agrees on, so it never changes its conclusion;
  - the controls that let an investigator fail the other way: a right prior, a truth outside the
    hypotheses, and a NAP-denied probe.

Run:  python -m pytest tests/test_question_machine_wrong_prior.py -q
"""
import importlib.util
import json
import pathlib

import pytest

torch = pytest.importorskip("torch")

_PATH = pathlib.Path(__file__).resolve().parents[1] / "experiments" / "question_machine_wrong_prior.py"
_spec = importlib.util.spec_from_file_location("question_machine_wrong_prior", _PATH)
bench = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bench)

F64 = torch.float64


def _after_passive(h="h1"):
    A = bench.mechanisms()
    x0 = torch.tensor(bench.X0, dtype=F64)
    return A, bench.simulate(A[h], x0, bench.push(None, bench.T_PASSIVE), 0.0)[0][-1]


# ── the design ───────────────────────────────────────────────────────────────────────────────

def test_the_passive_run_refutes_h0_but_cannot_separate_the_rest():
    A = bench.mechanisms()
    x0 = torch.tensor(bench.X0, dtype=F64)
    rest = bench.push(None, bench.T_PASSIVE)
    paths = {h: bench.simulate(A[h], x0, rest, 0.0)[0] for h in ("h0", "h1", "h2", "h3", "h4")}
    for h in ("h2", "h3", "h4"):
        assert torch.equal(paths[h], paths["h1"]), h
    assert float((paths["h0"] - paths["h1"]).abs().max()) > 0.2      # under h1 to h4, x1 drives x2


def test_only_pushing_x3_separates_h1_h2_h3():
    A, x = _after_passive()
    for probe in ("actuate_x1", "actuate_x2"):
        us = bench.push(probe, bench.T_PROBE)
        ref = bench.simulate(A["h1"], x, us, 0.0)[0]
        assert all(torch.equal(bench.simulate(A[h], x, us, 0.0)[0], ref) for h in ("h2", "h3")), probe
    us = bench.push("actuate_x3", bench.T_PROBE)
    x1 = {h: float(bench.simulate(A[h], x, us, 0.0)[0][-1, 0]) for h in ("h1", "h2", "h3")}
    assert x1["h2"] - x1["h1"] > 0.1 and x1["h1"] - x1["h3"] > 0.1   # excites, nothing, inhibits


def test_information_gain_finds_the_deciding_probe():
    A, x = _after_passive()
    s = bench.noise_std(bench.SIGMA)
    logp = torch.log(torch.tensor([1e-9, 1.0, 1.0, 1.0], dtype=F64))
    logp = logp - torch.logsumexp(logp, dim=0)
    gain = {p: bench.information_gain(logp, A, x, p, s, seed=i) for i, p in enumerate(bench.PROBES)}
    assert gain["actuate_x3"] > 1.4                                   # log2(3) = 1.585 bits available
    assert gain["actuate_x1"] < bench.MIN_GAIN and gain["actuate_x2"] < bench.MIN_GAIN


# ── the shipped Question Machine ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("arm, flagged", [("wrong", True), ("unknown", True), ("denied", True), ("null", False)])
def test_shipped_reconcile_says_revise_model_exactly_when_the_prior_is_wrong(arm, flagged):
    for seed in range(5):
        _, verdict = bench._passive_facts(arm, bench.COUPLING, bench.SIGMA, seed)
        assert (verdict == "revise_model") is flagged, (arm, seed, verdict)


def test_the_shipped_seam_asks_about_a_direction_that_carries_no_information():
    """Measured limit, not a target. The seam ranks questions by control leverage on the cost, so after
    the passive run it pushes a coordinate whose response every live hypothesis agrees on. It spends the
    whole budget and never changes its conclusion. A Question Machine that investigates fails here."""
    for seed in range(3):
        rec = bench.episode("wrong", "seam", seed)
        assert len(rec["experiments"]) == bench.BUDGET
        assert all(e["probe"] != "actuate_x3" for e in rec["experiments"])
        assert rec["probe_gain_bits"][rec["experiments"][0]["probe"]] < bench.MIN_GAIN
        assert rec["claim"] == "unresolved"


def test_without_probes_the_wrong_prior_is_dropped_but_not_replaced():
    rec = bench.episode("wrong", "passive", 0)
    assert rec["after_passive"]["posterior"]["h0"] < bench.REFUTED
    assert rec["after_passive"]["live"] == ["h1", "h2", "h3"]
    assert rec["claim"] == "unresolved" and rec["experiments"] == []


# ── an investigator, and the controls it could fail ──────────────────────────────────────────

@pytest.mark.parametrize("arm", list(bench.ARMS))
def test_information_gain_investigates_every_arm_correctly(arm):
    for seed in range(5):
        rec = bench.episode(arm, "eig", seed)
        sc = bench.score(rec)
        assert sc["recognized"] and sc["named"] and sc["useful"] and sc["concluded"], (seed, rec["claim"])
        assert sc["evidence"] in (True, None)


def test_a_right_prior_is_kept_without_spending_a_probe():
    for policy in bench.POLICIES:
        rec = bench.episode("null", policy, 2)
        assert rec["claim"] == "h0" and rec["experiments"] == [], policy


def test_a_truth_outside_the_hypotheses_is_refuted_not_absorbed():
    rec = bench.episode("unknown", "eig", 0)
    assert rec["claim"] == "refuted" and rec["falsifier"] is None
    assert rec["best_fit"] > bench.REFUTE_MS
    assert [e["probe"] for e in rec["experiments"]] == ["actuate_x3"]


def test_a_denied_probe_is_named_and_never_run():
    for policy in ("eig", "random", "seam", "oracle"):
        rec = bench.episode("denied", policy, 1)
        assert rec["blocked"] == ["actuate_x3"] and "actuate_x3" not in rec["allowed"]
        assert all(e["probe"] != "actuate_x3" for e in rec["experiments"]), policy
        assert rec["claim"] == "unresolved", policy
    assert bench.episode("denied", "eig", 1)["experiments"] == []    # nothing allowed is worth running


def test_measure_scores_each_cell_and_checks_reproducibility():
    out = bench.measure(2, policies=("seam", "eig"), arms=("wrong", "null"), repro_seeds=1)
    assert set(out) == {"wrong/seam", "wrong/eig", "null/seam", "null/eig"}
    assert all(cell["reproducible"] for cell in out.values())
    assert out["wrong/eig"]["concluded"] == 1.0 and out["wrong/seam"]["concluded"] == 0.0
    assert out["null/seam"]["probes"] == 0.0 and out["null/eig"]["claims"] == {"h0": 2}


def test_the_record_is_reproducible_and_says_what_would_refute_it():
    first = json.dumps(bench.episode("wrong", "eig", 4), sort_keys=True)
    bench._passive_facts.cache_clear()
    assert json.dumps(bench.episode("wrong", "eig", 4), sort_keys=True) == first
    rec = json.loads(first)
    assert rec["claim"] == "h2"
    assert rec["falsifier"]["probe"] == "actuate_x3" and rec["falsifier"]["separation"] > 0.1
    assert json.dumps(bench.episode("wrong", "eig", 5), sort_keys=True) != first   # another world
