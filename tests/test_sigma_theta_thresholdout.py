"""Regression tests for the §8.4 third-road (Thresholdout) arm of the holdout-staleness
measurement (SIGMA0-COLLAPSE-CERTIFICATE Part II, experiments/sigma_update_holdout_staleness.py).

Fast: reduced seeds/rounds — these pin the *ordering* facts the certificate cites, not the
headline constants (which come from the committed 32-seed run report).
"""
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "experiments"))
import sigma_update_holdout_staleness as m  # noqa: E402

SEEDS = 8
KW = dict(n=100, rounds=150)


def _avg(mode, **extra):
    rs = [m.run(seed=s, mode=mode, **KW, **extra) for s in range(SEEDS)]
    return (statistics.mean(r["true"] for r in rs),
            statistics.mean(r["gap"] for r in rs),
            rs)


def test_deterministic_per_seed():
    a = m.run(seed=3, mode="thresholdout", **KW)
    b = m.run(seed=3, mode="thresholdout", **KW)
    assert a == b


def test_backcompat_fresh_flag_maps_to_mode():
    assert m.run(seed=1, fresh=True, **KW) == m.run(seed=1, mode="fresh", **KW)
    assert m.run(seed=1, fresh=False, **KW) == m.run(seed=1, mode="fixed", **KW)


def test_validity_thresholdout_beats_naive_fixed():
    _, gap_fixed, _ = _avg("fixed")
    _, gap_thr, _ = _avg("thresholdout")
    assert gap_thr < gap_fixed, (gap_thr, gap_fixed)


def test_extraction_fresh_beats_naive_fixed():
    true_fixed, _, _ = _avg("fixed")
    true_fresh, _, _ = _avg("fresh")
    assert true_fresh > true_fixed


def test_ablation_mechanism_alone_does_not_rescue_extraction():
    # pool_mult=1: no accumulated burned data -> extraction ~ naive fixed, well below fresh.
    true_pool1, _, _ = _avg("thresholdout", pool_mult=1)
    true_fresh, _, _ = _avg("fresh")
    assert true_pool1 < 0.5 * true_fresh, (true_pool1, true_fresh)


def test_burned_pool_compounds_extraction():
    # with the 4n burned pool the managed arm clearly beats the naive fixed arm.
    true_fixed, _, _ = _avg("fixed")
    true_pool4, _, _ = _avg("thresholdout", pool_mult=4)
    assert true_pool4 > 2 * max(true_fixed, 0.1), (true_pool4, true_fixed)


def test_budget_respected():
    _, _, rs = _avg("thresholdout")
    for r in rs:
        assert r["budget_spent"] is not None and r["budget_spent"] <= max(4, 100 // 4)
