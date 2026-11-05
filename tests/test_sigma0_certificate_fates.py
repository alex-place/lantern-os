"""Structured adversarial cases for the collapse certificates.

The older sweeps sample random matrices, which almost never land on the boundary cases that
decide whether "no third fate" and the `guaranteed` flag are true. These are those cases, each
checked against the actual flow (matrix exponential or matrix power), never against the
certificate's own arithmetic.
"""
import numpy as np
import pytest

torch = pytest.importorskip("torch")
expm = pytest.importorskip("scipy.linalg").expm

from src.cio_sde.collapse import (
    collapse_certificate, dichotomy_certificate, discrete_dichotomy_certificate,
    jsrr_certificate, stability_gates,
)


def T(rows):
    return torch.tensor(rows, dtype=torch.float64)


def _sup_flow(M, t_max=60.0, n=600):
    M = np.asarray(M, dtype=float)
    return max(np.linalg.norm(expm(M * t), 2) for t in np.linspace(0.0, t_max, n))


def _sup_power(M, k_max=400):
    M = np.asarray(M, dtype=float)
    P, best = np.eye(M.shape[0]), 1.0
    for _ in range(k_max):
        P = P @ M
        best = max(best, np.linalg.norm(P, 2))
    return best


# ── the third fate exists in the linear regime ───────────────────────────────────────────

@pytest.mark.parametrize("rows", [
    [[0.0, 3.0], [-3.0, 0.0]],
    [[-1.0, 0.0, 0.0], [0.0, 0.0, 2.0], [0.0, -2.0, 0.0]],      # the §1.2 example
])
def test_rotation_is_not_collapse(rows):
    A = T(rows)
    assert np.linalg.norm(expm(A.numpy() * 1000.0), 2) == pytest.approx(1.0, abs=1e-6)
    d = dichotomy_certificate(A)
    assert d.fate == "MARGINAL" and d.marginal_kind == "rotating"
    assert d.collapses is False
    c = collapse_certificate(A)
    assert c.guaranteed is False and c.contraction_rate == 0.0


def test_discrete_rotation_and_period_two_are_not_collapse():
    for rows in ([[0.0, -1.0], [1.0, 0.0]], [[-1.0, 0.0], [0.0, 0.5]]):
        d = discrete_dichotomy_certificate(T(rows))
        assert d.fate == "MARGINAL" and d.marginal_kind == "rotating" and d.collapses is False


def test_frozen_null_modes_are_collapse():
    d = dichotomy_certificate(T([[-1.0, 0.0], [0.0, 0.0]]))
    assert d.fate == "MARGINAL" and d.marginal_kind == "frozen" and d.collapses is True
    dd = discrete_dichotomy_certificate(T([[0.5, 0.0], [0.0, 1.0]]))
    assert dd.fate == "MARGINAL" and dd.marginal_kind == "frozen" and dd.collapses is True
    assert collapse_certificate(T([[-1.0, 0.0], [0.0, 0.0]])).guaranteed is True


# ── defective on the boundary grows without bound ────────────────────────────────────────

def test_defective_axis_mode_is_divergence_not_collapse():
    A = T([[0.0, 1.0], [0.0, 0.0]])
    assert np.linalg.norm(expm(A.numpy() * 1000.0), 2) > 900.0
    d = dichotomy_certificate(A)
    assert d.fate == "DIVERGE" and d.marginal_kind == "defective" and d.collapses is False
    assert collapse_certificate(A).guaranteed is False


def test_defective_axis_mode_is_found_when_rotated_off_the_axes():
    Q, _ = np.linalg.qr(np.random.default_rng(3).standard_normal((3, 3)))
    J = np.array([[0.0, 1.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, -1.0]])
    d = dichotomy_certificate(torch.tensor(Q @ J @ Q.T))
    assert d.collapses is False and d.fate == "DIVERGE"


def test_discrete_defective_unit_mode_is_divergence():
    A = [[1.0, 10.0], [0.0, 1.0]]
    assert np.linalg.norm(np.linalg.matrix_power(np.array(A), 100), 2) > 900.0
    d = discrete_dichotomy_certificate(T(A))
    assert d.fate == "DIVERGE" and d.marginal_kind == "defective" and d.collapses is False


# ── `guaranteed` must mean what it says ──────────────────────────────────────────────────

@pytest.mark.parametrize("rows", [
    [[0.005, 0.0], [0.0, 0.005]],                               # all modes inside the null band
    [[-1.0, 0.0], [0.0, 0.009]],                                # one mode inside the null band
])
def test_slow_growth_inside_the_null_band_is_not_guaranteed(rows):
    A = T(rows)
    assert np.linalg.norm(expm(A.numpy() * 2000.0), 2) > 1e3
    c = collapse_certificate(A)
    assert c.guaranteed is False and c.contraction_rate == 0.0
    assert dichotomy_certificate(A).fate == "DIVERGE"           # the two certificates now agree


def test_small_gain_index_no_longer_implies_guaranteed():
    """α_sym + ‖A_k‖ < 0 does not bound V: from x0 on the 'null' axis, P_M x(0)=0 and the old
    documented bound said P_M x(t)=0, but the coupling pumps the active mode up to 0.37."""
    A = np.array([[-1.0, 0.5], [-0.5, 0.0]])
    c = collapse_certificate(torch.tensor(A))
    assert c.alpha < 0                                          # the index would have passed
    assert c.guaranteed is False
    x1 = max(abs((expm(A * t) @ np.array([0.0, 1.0]))[0]) for t in np.linspace(0, 20, 400))
    assert x1 > 0.3


def test_guaranteed_bound_holds_on_the_actual_flow():
    """When the certificate does say guaranteed, ‖P_M x(t)‖ ≤ ‖P_M x(0)‖e^{αt} must hold."""
    cases = [
        np.diag([-0.9, -0.9, 0.0, 0.0]),
        np.array([[-1.0, 3.0, 0.0], [-3.0, -1.0, 0.0], [0.0, 0.0, 0.0]]),   # normal, rotating decay
        np.array([[-2.0, 1.5], [-1.5, -1.0]]),                  # non-normal, A_s negative definite
    ]
    rng = np.random.default_rng(1)
    for M in cases:
        c = collapse_certificate(torch.tensor(M))
        assert c.guaranteed, c.summary()
        ev, V = np.linalg.eigh(0.5 * (M + M.T))
        Vm = V[:, np.abs(ev) >= 1e-2]
        for _ in range(5):
            x0 = rng.standard_normal(M.shape[0])
            a0 = np.linalg.norm(Vm.T @ x0)
            for t in (0.5, 2.0, 8.0):
                at = np.linalg.norm(Vm.T @ (expm(M * t) @ x0))
                assert at <= a0 * np.exp(-c.contraction_rate * t) + 1e-9


# ── the non-normal transient lives in the coupling ───────────────────────────────────────

@pytest.mark.parametrize("K", [10.0, 1000.0])
def test_coupling_transient_is_reported(K):
    M = np.array([[-1.0, K], [0.0, 0.0]])
    d = dichotomy_certificate(torch.tensor(M))
    actual = _sup_flow(M)
    assert actual == pytest.approx(K, rel=0.02)
    assert d.transient_bound == pytest.approx(1.0)              # the active block alone says 1
    assert d.coupling_norm == pytest.approx(K, rel=0.01)
    assert d.full_transient_bound >= actual


def test_full_transient_bound_holds_on_random_flows():
    rng = np.random.default_rng(20261105)
    checked = 0
    for _ in range(120):
        n = int(rng.integers(2, 6))
        M = rng.standard_normal((n, n))
        M = M - (max(np.linalg.eigvals(M).real) + rng.uniform(0.05, 1.0)) * np.eye(n)   # Hurwitz
        d = dichotomy_certificate(torch.tensor(M), delta=float(rng.uniform(0.0, 0.5)))
        if not np.isfinite(d.full_transient_bound):
            continue
        assert _sup_flow(M, t_max=30.0, n=200) <= d.full_transient_bound * (1 + 1e-6)
        checked += 1
    assert checked >= 100


def test_full_transient_bound_holds_on_random_maps():
    rng = np.random.default_rng(20261106)
    checked = 0
    for _ in range(120):
        n = int(rng.integers(2, 6))
        M = rng.standard_normal((n, n))
        M = M / max(abs(np.linalg.eigvals(M))) * rng.uniform(0.3, 0.97)
        d = discrete_dichotomy_certificate(torch.tensor(M), delta=float(rng.uniform(0.0, 0.2)))
        if not np.isfinite(d.full_transient_bound):
            continue
        assert _sup_power(M, 200) <= d.full_transient_bound * (1 + 1e-6)
        checked += 1
    assert checked >= 100


def test_divergent_flow_has_no_finite_transient_bound():
    d = dichotomy_certificate(T([[-1.0, 1.0], [0.0, 0.3]]))
    assert d.fate == "DIVERGE" and d.full_transient_bound == float("inf")


# ── the flagship example, corrected ──────────────────────────────────────────────────────

def test_flagship_example_has_no_euclidean_transient():
    """[[−1,3],[−3,0]] has ω=0, so ‖e^{tA}‖₂ ≤ 1 for all t. It was documented as a transient
    growth example. What grew was the projection ½x₁², not the state."""
    M = np.array([[-1.0, 3.0], [-3.0, 0.0]])
    assert _sup_flow(M, t_max=20.0, n=2000) == pytest.approx(1.0, abs=1e-9)
    g = stability_gates(torch.tensor(M))
    assert g.monotone_transient_bound == 1.0
    assert g.gate_numerical_range is False                      # not STRICT contraction, ω=0
    assert g.gate_lyapunov is True


def test_monotone_bound_absent_when_numerical_range_leaves_the_lhp():
    assert np.isnan(stability_gates(T([[-1.0, 10.0], [0.0, -1.0]])).monotone_transient_bound)


# ── a batch certifies only if every member does ──────────────────────────────────────────

def _heterogeneous_discrete():
    return torch.stack([T([[1.5, 0.0], [0.0, 0.1]]), T([[0.1, 0.0], [0.0, 1.5]])])


def _heterogeneous_continuous():
    return torch.stack([T([[2.0, 0.0], [0.0, -4.0]]), T([[-4.0, 0.0], [0.0, 2.0]])])


def test_batch_mean_cannot_launder_an_unstable_member():
    j = jsrr_certificate(_heterogeneous_discrete())
    assert j.spectral_radius == pytest.approx(1.5) and j.stable is False
    dd = discrete_dichotomy_certificate(_heterogeneous_discrete())
    assert dd.fate == "DIVERGE" and dd.collapses is False

    A = _heterogeneous_continuous()                             # mean = −I, which contracts
    assert dichotomy_certificate(A).fate == "DIVERGE"
    assert collapse_certificate(A).guaranteed is False
    g = stability_gates(A)
    assert g.gate_lyapunov is False and g.gate_numerical_range is False
    assert g.spectral_abscissa == pytest.approx(2.0)


def test_identical_batch_matches_a_single_jacobian():
    A = T([[-0.8, 0.0], [0.0, -0.8]])
    batch = A.unsqueeze(0).repeat(4, 1, 1)
    assert collapse_certificate(batch).contraction_rate == pytest.approx(0.8)
    assert jsrr_certificate(batch).spectral_radius == pytest.approx(0.8)
    assert dichotomy_certificate(batch).fate == "COLLAPSE"
