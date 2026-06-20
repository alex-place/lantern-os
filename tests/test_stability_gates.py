"""Tests for #768 Tier-A provable region-wideners (src/cio_sde/collapse.py).

Two sufficient contraction gates for non-normal A:
  - numerical-range (monotone):  ω(A)=λ_max(A_s) < −margin  ⟹ ‖e^{tA}‖ ≤ e^{ωt}
  - Lyapunov (asymptotic):       ∃P≻0 ⟺ max Re λ(A) < −margin   (accepts non-normal)

Includes the issue's required [[−1,3],[−3,0]] case, the gate-ordering invariant, a
randomized red-team (no false-positive certificates), and empirical validation that the
PROVEN transient bounds actually hold (via matrix exponentials).
"""
import numpy as np
import pytest

# torch is a heavy, optional dependency that CI does not install. Skip the whole
# module (rather than erroring at collection) when it is unavailable, so the
# Python test job stays green where torch isn't present.
torch = pytest.importorskip("torch")
from scipy.linalg import expm

from src.cio_sde.collapse import stability_gates, collapse_certificate, StabilityGates


def _A(rows):
    return torch.tensor(rows, dtype=torch.float32)


# ── the issue's required counterexample ────────────────────────────────────────

def test_counterexample_rejected_by_smallgain_accepted_by_lyapunov():
    """A=[[−1,3],[−3,0]] is Hurwitz (maxReλ=−0.5) but small-gain over-rejects it.
    The Lyapunov gate must accept it; the numerical-range gate must NOT (ω=0)."""
    A = _A([[-1.0, 3.0], [-3.0, 0.0]])

    cert = collapse_certificate(A)
    assert cert.guaranteed is False          # small-gain alpha = −1 + 3 = 2 > 0 → rejects
    assert cert.alpha > 0

    g = stability_gates(A)
    assert g.spectral_abscissa == pytest.approx(-0.5, abs=1e-5)  # Hurwitz
    assert g.gate_lyapunov is True           # accepted by the provable Lyapunov gate
    assert g.gate_numerical_range is False   # ω(A)=0 → transient growth, not monotone
    assert g.numerical_range_abscissa == pytest.approx(0.0, abs=1e-6)
    assert g.proven_contracting is True
    # the certificate exposes the wider proven region
    assert cert.proven_contracting is True and cert.guaranteed is False


# ── basic regimes ──────────────────────────────────────────────────────────────

def test_monotone_normal_matrix_passes_both_gates():
    g = stability_gates(_A([[-1.0, 0.0], [0.0, -2.0]]))
    assert g.gate_numerical_range is True
    assert g.gate_lyapunov is True
    assert g.numerical_range_abscissa == pytest.approx(-1.0, abs=1e-5)


def test_transient_nonnormal_hurwitz_lyapunov_only():
    """[[−1,10],[0,−1]]: both eigenvalues −1 (Hurwitz) but huge transient (ω=4)."""
    g = stability_gates(_A([[-1.0, 10.0], [0.0, -1.0]]))
    assert g.gate_lyapunov is True
    assert g.gate_numerical_range is False      # ω = −1 + 5 = 4 > 0
    assert g.numerical_range_abscissa == pytest.approx(4.0, abs=1e-5)
    assert np.isfinite(g.lyapunov_transient_bound) and g.lyapunov_transient_bound > 5


def test_unstable_matrix_certified_by_neither():
    g = stability_gates(_A([[1.0, 0.0], [0.0, -1.0]]))  # maxReλ = +1
    assert g.gate_lyapunov is False
    assert g.gate_numerical_range is False
    assert g.proven_contracting is False


def test_crouzeix_bound_present_iff_W_in_lhp():
    g_lhp = stability_gates(_A([[-1.0, 3.0], [-3.0, 0.0]]))   # ω = 0 ≤ 0
    assert g_lhp.crouzeix_transient_bound == pytest.approx(1.0 + 2.0 ** 0.5, abs=1e-9)
    g_rhp = stability_gates(_A([[-1.0, 10.0], [0.0, -1.0]]))  # ω = 4 > 0
    assert np.isnan(g_rhp.crouzeix_transient_bound)


def test_margin_tightens_both_gates():
    A = _A([[-0.1, 0.0], [0.0, -0.1]])          # maxReλ = ω = −0.1
    assert stability_gates(A, margin=0.0).proven_contracting is True
    g = stability_gates(A, margin=0.2)          # require rate > 0.2 → fails
    assert g.gate_numerical_range is False and g.gate_lyapunov is False


def test_batched_jacobian_supported():
    A = torch.stack([_A([[-1.0, 0.0], [0.0, -2.0]]),
                     _A([[-1.0, 0.0], [0.0, -2.0]])])  # (2,2,2)
    g = stability_gates(A)
    assert g.gate_numerical_range is True and g.gate_lyapunov is True


# ── invariants + randomized red-team (no false-positive certificates) ───────────

def test_gate_ordering_and_no_false_positives():
    """Over random matrices assert the provable facts:
       (1) numerical-range gate ⟹ Lyapunov gate (W(A) ⊇ spec(A));
       (2) Lyapunov gate ⟹ max Re λ(A) < 0  (no false certificate);
       (3) numerical-range gate ⟹ ω(A) < 0."""
    rng = np.random.default_rng(20260619)
    tol = 1e-6
    for _ in range(400):
        n = int(rng.integers(2, 6))
        M = rng.standard_normal((n, n))
        g = stability_gates(torch.tensor(M, dtype=torch.float64))
        if g.gate_numerical_range:
            assert g.numerical_range_abscissa < tol
            assert g.gate_lyapunov, "numerical-range gate must imply Lyapunov gate"
        if g.gate_lyapunov:
            assert g.spectral_abscissa < tol, "Lyapunov gate certified a non-Hurwitz A!"


def test_proven_transient_bounds_hold_numerically():
    """The PROVEN bounds must actually hold for real matrix exponentials:
       monotone: ‖e^{tA}‖ ≤ e^{ωt};  Lyapunov: sup_t ‖e^{tA}‖ ≤ √cond(P)."""
    ts = np.linspace(0.0, 12.0, 240)

    # monotone case (normal, ω<0): tight exponential envelope
    M1 = np.array([[-0.7, 0.0], [0.0, -1.3]])
    g1 = stability_gates(torch.tensor(M1))
    for t in ts:
        assert np.linalg.norm(expm(M1 * t), 2) <= np.exp(g1.numerical_range_abscissa * t) + 1e-6

    # transient non-normal Hurwitz case: √cond(P) bounds the whole trajectory
    M2 = np.array([[-1.0, 10.0], [0.0, -1.0]])
    g2 = stability_gates(torch.tensor(M2))
    sup = max(np.linalg.norm(expm(M2 * t), 2) for t in ts)
    assert sup <= g2.lyapunov_transient_bound + 1e-6
    assert sup > 1.5    # there really is transient growth the monotone gate rightly flags


def test_boundary_matrix_not_certified():
    """A pure rotation [[0,1],[−1,0]] (eigenvalues ±i, exactly on the imaginary axis)
    must be certified by NEITHER gate — the conservative boundary behavior."""
    g = stability_gates(_A([[0.0, 1.0], [-1.0, 0.0]]))
    assert g.gate_lyapunov is False
    assert g.gate_numerical_range is False    # ω = 0, not < 0
    assert g.proven_contracting is False
    # An extremely non-normal but Hurwitz matrix whose Lyapunov P is so ill-conditioned
    # (cond(P) ≳ 1e12, transient amplification ≳ 1e6) that the conditioning guard refuses
    # to certify it — conservative-correct for a safety gate, and independent of any warning.
    g2 = stability_gates(_A([[-1.0, 3.0e6], [0.0, -1.0]]))
    assert g2.gate_lyapunov is False


def test_crouzeix_bound_holds_numerically():
    """PROVEN-in-literature Crouzeix–Palencia bound, verified in-repo: when W(A) ⊂ LHP
    (ω ≤ 0), ‖e^{tA}‖₂ ≤ 1+√2 for all t."""
    ts = np.linspace(0.0, 20.0, 400)
    for M in (np.array([[-1.0, 3.0], [-3.0, 0.0]]),     # ω = 0 (W touches axis)
              np.array([[0.0, 1.0], [-1.0, 0.0]])):     # ω = 0 (pure rotation)
        g = stability_gates(torch.tensor(M))
        assert g.crouzeix_transient_bound == pytest.approx(1.0 + 2.0 ** 0.5, abs=1e-9)
        sup = max(np.linalg.norm(expm(M * t), 2) for t in ts)
        assert sup <= g.crouzeix_transient_bound + 1e-6


# ── #768 gate #2: ε-pseudospectral abscissa + Kreiss constant ───────────────────

def test_pseudospectral_abscissa_is_provable_upper_bound():
    """α_ε ≤ ω(A)+ε (field-of-values upper bound) must dominate the spectral abscissa, and
    the gate must agree with the slightly-looser numerical-range gate. The ω=0 transient
    counterexample must NOT earn a transient-free certificate."""
    g = stability_gates(_A([[-1.0, 0.0], [0.0, -2.0]]))           # ω = −1
    assert g.pseudospectral_abscissa == pytest.approx(-1.0 + g.pseudospectral_eps, abs=1e-6)
    assert g.pseudospectral_abscissa >= g.spectral_abscissa       # α_ε ≥ α_0 always
    assert g.gate_pseudospectral is True
    gc = stability_gates(_A([[-1.0, 3.0], [-3.0, 0.0]]))          # ω = 0 → transient growth
    assert gc.gate_pseudospectral is False
    assert gc.pseudospectral_abscissa > 0


def test_kreiss_bound_lower_bounds_transient_peak():
    """Kreiss matrix theorem (continuous): K(A) ≤ sup_t‖e^{tA}‖. The computed lower bound
    must sit under the true transient peak, equal 1 for a normal A (no transient), and
    exceed 1 for a transiently-growing non-normal Hurwitz A."""
    ts = np.linspace(0.0, 12.0, 240)
    g_norm = stability_gates(_A([[-1.0, 0.0], [0.0, -2.0]]))
    assert g_norm.kreiss_bound == pytest.approx(1.0, abs=1e-6)    # normal → K(A)=1

    M = np.array([[-1.0, 10.0], [0.0, -1.0]])
    g = stability_gates(torch.tensor(M))
    sup = max(np.linalg.norm(expm(M * t), 2) for t in ts)
    assert g.kreiss_bound > 1.0                                   # detects the transient
    assert g.kreiss_bound <= sup + 1e-6                           # Kreiss lower bound holds


def test_kreiss_large_matrix_uses_cheap_probe():
    """For a large Jacobian (loop_lm's hidden-dim A) the Kreiss probe is capped to one RHP
    point for speed; it must still return a finite lower bound ≥ 1 and not scan a full grid."""
    rng = np.random.default_rng(7)
    n = 80
    # circular law: randn(n,n)/√n has spectral radius ≈1, so the −3I shift makes this
    # comfortably Hurwitz (rightmost eigenvalue ≈ −2) regardless of the random draw.
    M = rng.standard_normal((n, n)) / np.sqrt(n) - 3.0 * np.eye(n)
    g = stability_gates(torch.tensor(M))
    assert np.isfinite(g.kreiss_bound) and g.kreiss_bound >= 1.0
    assert g.gate_lyapunov is True
