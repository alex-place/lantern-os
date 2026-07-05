"""
Torch-free unit tests for experiments/sigma0_jacobian_stability.py (#2029).

Power iteration is model-agnostic, so we validate ρ recovery on synthetic operators with
analytically-known spectral radius — no GPU/model needed. The one GPU step (building the real
autograd-JVP matvec of the reasoning update) is out of scope here; these prove the estimator +
verdict the run will consume.

Run: python tests/test_sigma0_jacobian_stability.py    (also pytest-compatible)
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "experiments"))
import sigma0_jacobian_stability as J  # noqa: E402


def test_diagonal_rho_is_largest_magnitude():
    mv = J.matvec_from_matrix(np.diag([0.5, -0.9, 0.3]))   # ρ = 0.9 (from the negative entry)
    rho, info = J.power_iteration_spectral_radius(mv, 3)
    assert abs(rho - 0.9) < 1e-4, (rho, info["iters_used"])
    assert info["converged"]


def test_symmetric_matches_numpy_eig():
    rng = np.random.RandomState(3)
    A = rng.randn(6, 6)
    S = A + A.T                                             # symmetric ⇒ real eigenvalues
    expected = max(abs(np.linalg.eigvalsh(S)))
    rho, _ = J.power_iteration_spectral_radius(J.matvec_from_matrix(S), 6, iters=500)
    assert abs(rho - expected) / expected < 1e-3, (rho, expected)


def test_scaled_rotation_complex_pair():
    a = 1.3
    R = np.array([[0.0, -a], [a, 0.0]])                    # eigenvalues ±a·i ⇒ ρ = a
    rho, _ = J.power_iteration_spectral_radius(J.matvec_from_matrix(R), 2)
    assert abs(rho - a) < 1e-6, rho                        # norm scales by exactly a each step


def test_zero_operator_is_rho_zero():
    rho, info = J.power_iteration_spectral_radius(lambda v: np.zeros_like(v), 4)
    assert rho == 0.0 and info["converged"]


def test_history_converges_monotone_from_below_for_diagonal():
    mv = J.matvec_from_matrix(np.diag([0.9, 0.2, 0.1]))
    _, info = J.power_iteration_spectral_radius(mv, 3, seed=1)
    h = info["history"]
    assert h[-1] <= 0.9 + 1e-9 and h[-1] > h[0] - 1e-9     # rises toward ρ, never exceeds it


def test_verdict_regimes():
    assert J.stability_verdict(0.8)["regime"] == "contraction"
    assert J.stability_verdict(0.8)["stable"] is True
    assert J.stability_verdict(1.2)["regime"] == "divergent"
    assert J.stability_verdict(1.2)["stable"] is False
    assert J.stability_verdict(1.0)["regime"] == "critical"
    # margin demands a safety band: ρ=0.97 is "stable" bare but not under a 0.05 margin
    assert J.stability_verdict(0.97)["stable"] is True
    assert J.stability_verdict(0.97, margin=0.05)["stable"] is False
    assert abs(J.stability_verdict(0.9)["margin_to_instability"] - 0.1) < 1e-9


def test_stability_report_schema():
    r = J.stability_report(J.matvec_from_matrix(np.diag([0.5, 0.4])), 2, margin=0.05)
    for key in ("rho", "stable", "margin_to_instability", "regime", "dim", "iters_used", "converged"):
        assert key in r, key
    assert r["stable"] is True and r["regime"] == "contraction" and r["dim"] == 2


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  - {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL- {fn.__name__}\n       {e}")
    print(f"\n{'all passed' if not failed else str(failed) + ' FAILED'} ({len(fns)} tests)")
    sys.exit(1 if failed else 0)
