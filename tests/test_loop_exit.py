"""
Regression tests for the looped-LM per-token exit policies (src/sigma0/loop_lm.py).

Covers the three Σ₀ exit modes and, in particular, the property that motivated adding the
acceleration criterion: a first-order ``converge`` exit (``‖Δh‖/‖h‖ < eps``) FALSE-EXITS on a
plateau-norm SPIRAL (small constant step that keeps rotating), while the second-order ``accel``
exit (``‖Δᵏ−Δᵏ⁻¹‖ < eps`` for 2 consecutive steps) does not. That spiral is the non-normal /
skew rotation the collapse certificate §1.1 flags as the hard case — see Two-Scale Latent
Dynamics (arXiv:2509.23314).

Run:  python -m pytest tests/test_loop_exit.py -q
  or: python tests/test_loop_exit.py   (self-running, no pytest needed)
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import pytest  # noqa: E402

pytest.importorskip("torch")
import torch  # noqa: E402

from sigma0.loop_lm import Sigma0LoopLM as S  # noqa: E402


def _spiral(n=4, step=0.05, offset=10.0, dtheta=0.9):
    """A trajectory with a LARGE constant offset and a SMALL rotating step. ‖Δh‖/‖h‖ is tiny
    (first-order looks converged) but the step DIRECTION keeps rotating (acceleration stays high)."""
    h = [torch.tensor([offset, 0.0, 0.0, 0.0])]
    for k in range(1, n):
        d = torch.zeros(4)
        d[0] = step * math.cos(k * dtheta)
        d[1] = step * math.sin(k * dtheta)
        h.append(h[-1] + d)
    return h


def test_converge_false_exits_on_spiral():
    """First-order ‖Δh‖/‖h‖ criterion fires 'fixed_point' on the spiral (the bug we're fixing)."""
    step, _, reason, _ = S.converge_step(_spiral(), eps=0.05, max_steps=4)
    assert reason == "fixed_point", f"first-order converge should false-exit on the spiral, got {reason}"


def test_accel_robust_to_spiral():
    """The second-order acceleration criterion must NOT exit on the same spiral — it sees the
    direction still rotating (high acceleration) and rides the loop to max depth instead. This is
    the exact pair: converge_step false-exits (test above) while accel_step rides to max_depth."""
    step, _, reason, _ = S.accel_step(_spiral(), eps=0.05, max_steps=4)
    assert reason == "max_depth", f"accel must not false-exit on a rotating spiral, got {reason}"
    assert step == 4, f"accel should ride a spiral to full depth, got step {step}"


def test_accel_fires_on_true_settle():
    """When the loop genuinely settles (steps become equal → zero acceleration), accel exits."""
    base = torch.tensor([1.0, 2.0, 3.0, 4.0])
    d = torch.tensor([1e-3, 0.0, 0.0, 0.0])           # constant tiny step ⇒ acceleration ≈ 0
    h = [base, base + d, base + 2 * d, base + 3 * d]
    step, accel, reason, _ = S.accel_step(h, eps=0.05, max_steps=4)
    assert reason == "accel_fixed_point", f"constant-velocity settle should exit, got {reason}"
    assert accel < 0.05


def test_qexit_confidence_threshold():
    """Q-exit halts at the first step whose cumulative gate CDF clears q."""
    # high early gate logit ⇒ most halt mass on step 1 ⇒ exits at step 1 for q=0.5
    step, cdf, reason = S.qexit_step([4.0, 0.0, 0.0, 0.0], q=0.5, max_steps=4)
    assert step == 1 and reason == "threshold_met", f"confident early gate should exit at step 1, got {step}/{reason}"
    # all-low gates ⇒ no early halt mass ⇒ rides to the last step (which dumps the remaining mass)
    step2, cdf2, _ = S.qexit_step([-5.0, -5.0, -5.0, -5.0], q=0.95, max_steps=4)
    assert step2 == 4, f"low-confidence gates should ride to full depth, got step {step2}"
    assert cdf2 >= 0.95, "the terminal step must dump the remaining survival mass"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
