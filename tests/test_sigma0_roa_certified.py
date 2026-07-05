"""
Machine-check for the #1991 region-of-attraction certificate.

Turns the grid-*measured* basin bound (sigma0_roa_estimate.py, c* ~= 2.307) into a
*proven* one: a rigorous interval branch-and-bound (mpmath.iv, directed rounding) certifies
V̇ < 0 on {V <= 2.25} minus an analytically-handled origin ball. This test IS the proof
being checked. A control at 2.5 (above the true c*) must fail — otherwise the certifier is
vacuous.

experiments/ is added to sys.path (it is not on pytest's `pythonpath` = apps src). Importing
the module does not run the B&B (guarded by __main__).
"""
import sys
from fractions import Fraction as Fr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "experiments"))

# mpmath (rigorous interval arithmetic) is an OPTIONAL dep, absent in the minimal CI env — like
# torch/discord elsewhere in this suite. Guard the transitive import so a missing mpmath SKIPS
# this module cleanly instead of raising a collection ImportError that aborts the ENTIRE pytest
# run (exit 2) and reds the "Python tests" gate on every PR.
import pytest  # noqa: E402

pytest.importorskip("mpmath")

from sigma0_roa_certify import certify, verify_polynomial  # noqa: E402


def test_polynomial_derivation_is_exact():
    # Re-derives P (from AᵀP+PA=-I), V, and V̇ symbolically and asserts they match the
    # hard-coded forms the interval evaluator uses. Raises inside on any mismatch.
    poly = verify_polynomial()
    assert poly["V"] == "3*x1**2/2 - x1*x2 + x2**2"
    assert poly["lambda_min_lower_bound"] <= 0.69  # certified containment bound


def test_certifies_sublevel_2_25():
    certified, boxes, undecided = certify(Fr(9, 4), min_w="0.001")
    assert certified is True, "V̇ < 0 on {V <= 2.25} must be machine-verifiable"
    assert undecided == 0
    assert boxes > 100  # it actually did the branch-and-bound, not a trivial pass


def test_control_2_5_cannot_certify_has_teeth():
    # 2.5 > true c* (~2.307): there ARE points with V̇ >= 0 inside {V <= 2.5}, so no amount of
    # subdivision can discharge them. If this ever certifies, the method is unsound/vacuous.
    certified, _boxes, undecided = certify(Fr(5, 2), min_w="0.02", box_cap=200_000)
    assert certified is False, "certifier has no teeth if a level above c* certifies"
    assert undecided > 0


def test_more_conservative_bound_also_certifies():
    # Monotonicity sanity: a smaller sublevel set is easier and must also certify.
    certified, _boxes, undecided = certify(Fr(2, 1), min_w="0.002")
    assert certified is True and undecided == 0
