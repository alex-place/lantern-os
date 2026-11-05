"""
Tests for the sound depth-collapse alarm `Sigma0LoopLM.step_ratio_alarm` (src/sigma0/loop_lm.py).

Each case mirrors a theorem in docs/formal/TokenRouting.lean:
- `step_ratio_alarm_sound`: a kappa-contraction never alarms at kappa.
- `alarm_catches_drift`: the drift loop, identical to halving up to trained depth K, alarms at
  kappa = 1/2 exactly when the state after step K + 2 arrives (list index K + 2).
- `trained_depths_certify_nothing`: that drift is 1-Lipschitz, so kappa = 1 cannot catch it.

Run:  python -m pytest tests/test_step_ratio_alarm.py -q
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import pytest  # noqa: E402

pytest.importorskip("torch")
import torch  # noqa: E402

from sigma0.loop_lm import Sigma0LoopLM as S  # noqa: E402


def _run(f, x0, n):
    h = [torch.tensor([float(x0)])]
    for _ in range(n - 1):
        h.append(torch.tensor([f(float(h[-1][0]))]))
    return h


def _drift(K):
    thr = 0.5 ** K
    return lambda x: x / 2 if thr < x else x - thr / 2


def test_contraction_never_alarms_at_its_kappa():
    step, _, reason, ratios = S.step_ratio_alarm(_run(lambda x: x / 2, 1.0, 12), kappa=0.5)
    assert step is None and reason == "no_alarm"
    assert all(r <= 0.5 for r in ratios)


def test_alarm_catches_drift_right_after_trained_depth():
    K = 3
    h = _run(_drift(K), 1.0, 9)
    # identical to halving through depth K, as the theorem requires
    assert [float(v[0]) for v in h[: K + 1]] == [0.5 ** k for k in range(K + 1)]
    step, ratio, reason, _ = S.step_ratio_alarm(h, kappa=0.5)
    assert reason == "receipt_violated"
    assert step == K + 3          # 1-indexed step of list index K + 2
    assert ratio == pytest.approx(1.0)


def test_nonexpansive_drift_evades_kappa_one():
    step, _, reason, _ = S.step_ratio_alarm(_run(_drift(3), 1.0, 12), kappa=1.0)
    assert step is None and reason == "no_alarm"


def test_expansion_alarms_at_kappa_one():
    step, ratio, reason, _ = S.step_ratio_alarm(_run(lambda x: 2 * x, 1.0, 5), kappa=1.0)
    assert reason == "receipt_violated" and step == 3 and ratio == pytest.approx(2.0)


def test_norm_growth_hidden_from_relative_exit():
    # large offset + growing absolute steps: relative deltas look converged, absolute steps grow
    h = [torch.tensor([1000.0 + k * k]) for k in range(6)]
    exit_step, _, reason, _ = S.converge_step(h, eps=0.01, max_steps=6)
    assert reason == "fixed_point" and exit_step == 2
    step, ratio, areason, _ = S.step_ratio_alarm(h, kappa=1.0)
    assert areason == "receipt_violated" and step == 3 and ratio == pytest.approx(3.0)


def test_zero_step_then_motion_is_infinite_ratio():
    h = [torch.tensor([1.0]), torch.tensor([1.0]), torch.tensor([2.0])]
    step, ratio, reason, _ = S.step_ratio_alarm(h, kappa=1.0)
    assert reason == "receipt_violated" and math.isinf(ratio) and step == 3


def test_patience_and_short_inputs():
    h = _run(lambda x: 2 * x, 1.0, 5)
    assert S.step_ratio_alarm(h, kappa=1.0, patience=3)[0] == 5
    assert S.step_ratio_alarm(h, kappa=1.0, patience=4)[0] is None
    assert S.step_ratio_alarm(h[:2], kappa=1.0) == (None, 0.0, "no_alarm", [])
