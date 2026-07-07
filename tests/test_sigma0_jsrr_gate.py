"""
JSRR acceptance-gate tests (port of STARS' discrete spectral-radius criterion, arXiv:2605.26733).

Two layers, both CPU-only (no model/GPU):
  1. cio_sde.collapse.jsrr_certificate  — the discrete ρ(A)<1 gate on a known matrix.
  2. sigma0.loop_lm._stability_gates / _accept_stability — the serve-loop wiring that makes
     JSRR the acceptance signal generate() consumes.

The empirical Jacobians here are synthetic operators with analytically-known spectral radius,
so the gate's verdict is checkable exactly — the same discipline as test_sigma0_jacobian_stability
(the matvec twin) and test_cio_sde (the continuous gates).

Run: python -m pytest tests/test_sigma0_jsrr_gate.py -q
"""
import os
import sys

import numpy as np
import pytest

torch = pytest.importorskip("torch")   # torch-free CI must skip, not fail collection (#862 convention)

from cio_sde.collapse import jsrr_certificate, JsrrCertificate

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "experiments"))
import sigma0_jacobian_stability as JV  # noqa: E402  — the matvec twin, cross-checked below


def _t(mat):
    return torch.tensor(np.asarray(mat, dtype=float), dtype=torch.float64)


# ── the gate: exact discrete spectral radius verdict ────────────────────────────────────

def test_contraction_accepts():
    # diag ρ = 0.9 (from the −0.9 entry) < 1 ⇒ accept
    c = jsrr_certificate(_t(np.diag([0.5, -0.9, 0.3])))
    assert isinstance(c, JsrrCertificate)
    assert abs(c.spectral_radius - 0.9) < 1e-9
    assert c.regime == "contraction"
    assert c.stable is True


def test_divergent_rejects():
    c = jsrr_certificate(_t(np.diag([1.2, 0.4])))          # ρ = 1.2 > 1 ⇒ reject
    assert abs(c.spectral_radius - 1.2) < 1e-9
    assert c.regime == "divergent"
    assert c.stable is False


def test_scaled_rotation_is_divergent():
    # eigenvalues ±1.3i ⇒ ρ = 1.3 (a rotation the CONTINUOUS numerical-range gate could miss;
    # the discrete radius sees it) — a marginal/divergent discrete loop, correctly rejected.
    c = jsrr_certificate(_t([[0.0, -1.3], [1.3, 0.0]]))
    assert abs(c.spectral_radius - 1.3) < 1e-9
    assert c.stable is False


def test_critical_boundary_not_accepted():
    c = jsrr_certificate(_t(np.eye(2)))                    # ρ = 1.0 exactly
    assert c.regime == "critical"
    assert c.stable is False                               # ρ<1 strict ⇒ the boundary is rejected


def test_margin_band_rejects_near_critical():
    A = _t(np.diag([0.97, 0.1]))                           # ρ = 0.97
    assert jsrr_certificate(A, margin=0.0).stable is True   # bare ρ<1 ⇒ accept
    assert jsrr_certificate(A, margin=0.05).stable is False  # inside a 0.05 safety band ⇒ reject


def test_penalty_and_norm_invariants():
    rng = np.random.RandomState(7)
    M = rng.randn(5, 5)
    c = jsrr_certificate(_t(M))
    # STARS surrogate identity: penalty = ‖Av‖² = radius_estimate²
    assert abs(c.penalty - c.radius_estimate ** 2) < 1e-9
    # ρ ≤ σ_max always (spectral radius bounded by spectral norm), and the single-step
    # power-iteration estimate is a σ_max sample ⇒ ≤ σ_max (up to fp slack).
    assert c.spectral_radius <= c.spectral_norm + 1e-9
    assert c.radius_estimate <= c.spectral_norm + 1e-9


def test_nan_safe_on_degenerate():
    # non-finite entries must not raise and must not be accepted
    c = jsrr_certificate(_t([[float("nan"), 0.0], [0.0, 0.5]]))
    assert c.stable is False


def test_agrees_with_matvec_twin_on_symmetric():
    # the exact-eig gate and the experiments/ power-iteration estimator recover the same ρ
    rng = np.random.RandomState(3)
    A = rng.randn(6, 6)
    S = A + A.T                                             # symmetric ⇒ real spectrum
    exact = jsrr_certificate(_t(S)).spectral_radius
    est, _ = JV.power_iteration_spectral_radius(JV.matvec_from_matrix(S), 6, iters=500)
    assert abs(exact - est) / exact < 1e-3


# ── the wiring: _stability_gates emits jsrr, _accept_stability consumes it ───────────────

def test_stability_gates_emits_jsrr_and_accepts():
    from sigma0.loop_lm import _stability_gates, _accept_stability
    cert = _stability_gates(_t(np.diag([0.5, -0.9, 0.3])))  # ρ = 0.9 ⇒ accept
    assert cert is not None and isinstance(cert.get("jsrr"), dict)
    assert cert["jsrr"]["stable"] is True
    assert abs(cert["jsrr"]["spectral_radius"] - 0.9) < 1e-4
    assert _accept_stability(cert) is True


def test_stability_gates_rejects_divergent():
    from sigma0.loop_lm import _stability_gates, _accept_stability
    cert = _stability_gates(_t(np.diag([1.4, 0.2])))        # ρ = 1.4 ⇒ reject
    assert cert["jsrr"]["stable"] is False
    assert _accept_stability(cert) is False


def test_accept_stability_fallback_and_unknown():
    from sigma0.loop_lm import _accept_stability
    # no jsrr present ⇒ fall back to the continuous proven_contracting gate
    assert _accept_stability({"proven_contracting": True}) is True
    assert _accept_stability({"proven_contracting": False}) is False
    # jsrr present wins over the continuous gate (discrete criterion is primary)
    assert _accept_stability({"jsrr": {"stable": True}, "proven_contracting": False}) is True
    # neither present, or no certificate at all ⇒ honest None (not a fabricated False)
    assert _accept_stability({}) is None
    assert _accept_stability(None) is None


def test_reason_verdict_reads_jsrr_regime():
    from sigma0.loop_lm import assemble_reason_verdict
    # a JSRR-contraction generation reports stable="contract" even if the continuous gate
    # over-rejected (proven_contracting False) — JSRR is the primary read.
    out = {
        "stability_gates": {"jsrr": {"regime": "contraction", "stable": True},
                            "proven_contracting": False},
        "stability_accepted": True, "canary_signal": "none", "exit_reason": "adaptive_qexit",
    }
    v = assemble_reason_verdict(out)
    assert v["stable"] == "contract"
    assert v["converged"] is True
    # divergent regime surfaces as diverge
    out["stability_gates"]["jsrr"] = {"regime": "divergent", "stable": False}
    assert assemble_reason_verdict(out)["stable"] == "diverge"


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
