"""Regression tests for the E-P stochastic-signal falsification
(SIGMA0-COLLAPSE-CERTIFICATE §8.4.1 re-statement; issue #2692;
experiments/sigma_update_stochastic_signal.py).

Fast: reduced seeds/rounds — these pin the *ordering* facts the certificate cites
(H-P1 mechanism confirmed; H-P2 kill condition fired — re-drawn noise rescues a stuck
bias; the rescue is reproduced by zero-information dither; fresh truth still strictly
dominates), not the headline constants (which come from the committed 32-seed report).
"""
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "experiments"))
import sigma_update_stochastic_signal as m  # noqa: E402

SEEDS, ROUNDS = 8, 150


def _avg(n, s_b, s_m, w_i, fresh=False):
    return statistics.mean(m.run(n, s_b, s_m, w_i, fresh_holdout=fresh, seed=s, rounds=ROUNDS)
                           for s in range(SEEDS))


def _avg_dither(n, s_d):
    return statistics.mean(m.run_dither(n, s_d, seed=s, rounds=ROUNDS) for s in range(SEEDS))


def test_deterministic_per_seed():
    a = m.run(50, 0.5, 0.5, 0.25, seed=3, rounds=ROUNDS)
    b = m.run(50, 0.5, 0.5, 0.25, seed=3, rounds=ROUNDS)
    assert a == b
    assert m.run_dither(50, 0.1, seed=3, rounds=ROUNDS) == m.run_dither(50, 0.1, seed=3, rounds=ROUNDS)


def test_hp1_zero_bias_beats_all_bias_and_fixed_alone():
    fixed_alone = _avg(50, 0.0, 0.0, 0.0)
    all_bias = max(_avg(50, 0.5, 0.0, w) for w in (0.0, 0.1, 0.25))
    no_bias = max(_avg(50, 0.0, 0.5, w) for w in (0.1, 0.25, 0.5))
    assert no_bias > 2.0 * max(all_bias, 1e-9), (no_bias, all_bias)
    assert no_bias > 2.0 * max(fixed_alone, 1e-9), (no_bias, fixed_alone)


def test_hp2_kill_redrawn_noise_rescues_stuck_bias():
    det = max(_avg(50, 0.5, 0.0, w) for w in (0.0, 0.1, 0.25))
    rescued = max(_avg(50, 0.5, 1.0, w) for w in (0.1, 0.25))
    assert rescued > 2.0 * max(det, 1e-9), (rescued, det)


def test_posthoc_dither_reproduces_rescue():
    no_dither = _avg_dither(50, 0.0)
    dithered = max(_avg_dither(50, s_d) for s_d in (0.1, 0.2))
    assert dithered > 2.0 * max(no_dither, 1e-9), (dithered, no_dither)


def test_fresh_truth_still_dominates():
    fresh_alone = _avg(50, 0.0, 0.0, 0.0, fresh=True)
    no_bias = max(_avg(50, 0.0, 0.5, w) for w in (0.1, 0.25, 0.5))
    dithered = max(_avg_dither(50, s_d) for s_d in (0.1, 0.2))
    assert fresh_alone > no_bias, (fresh_alone, no_bias)
    assert fresh_alone > dithered, (fresh_alone, dithered)


def test_committed_report_records_the_refutation():
    report_path = Path(__file__).resolve().parent.parent / "data" / "sigma0" / \
        "stochastic_signal_report.json"
    if not report_path.exists():
        import pytest
        pytest.skip("run experiments/sigma_update_stochastic_signal.py to produce the report")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    v = report["verdicts"]
    assert v["H-P1_mechanism_confirmed"] is True
    assert v["H-P2_no_rescue"] is False          # the kill condition fired — on the record
    assert v["posthoc_dither_attribution"] is True
    assert v["fresh_truth_still_dominates"] is True
    assert report["sanity_ok"] is True
