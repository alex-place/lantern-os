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

from src.cio_sde import CIO_SDE, AntiCollapseOperator, InterventionPolicy, LinearDynamics
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


# ── the independent review's attacks: boundary rounding, tolerances, batches ───────────────────────

def _q(n, seed):
    g = torch.Generator().manual_seed(seed)
    q, _ = torch.linalg.qr(torch.randn(n, n, generator=g, dtype=torch.float64))
    return q


def _rotated(M, seed):
    M = torch.as_tensor(M, dtype=torch.float64)
    q = _q(M.shape[0], seed)
    return q @ M @ q.T


ROTATION = [[0.0, 2.0], [-2.0, 0.0]]
ROTATION_PLUS_STABLE = [[-1.0, 0.0, 0.0], [0.0, 0.0, 2.0], [0.0, -2.0, 0.0]]
JORDAN = [[0.0, 1.0], [0.0, 0.0]]
JORDAN_PLUS_STABLE = [[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]]


@pytest.mark.parametrize("seed", range(40))
@pytest.mark.parametrize("M", [ROTATION, ROTATION_PLUS_STABLE])
def test_a_rotation_survives_any_change_of_basis(M, seed):
    """Rounding put these eigenvalues at −1e-17 ± 2i, which counted as active, emptied the slow
    block, and reported COLLAPSE: on 75 of 200 seeds for the document's own example."""
    c = dichotomy_certificate(_rotated(M, seed))
    assert (c.fate, c.collapses, c.marginal_kind) == ("MARGINAL", False, "rotating")


@pytest.mark.parametrize("seed", range(40))
@pytest.mark.parametrize("M", [JORDAN, JORDAN_PLUS_STABLE])
def test_a_jordan_block_survives_any_change_of_basis(M, seed):
    c = dichotomy_certificate(_rotated(M, seed))
    assert (c.fate, c.collapses, c.marginal_kind) == ("DIVERGE", False, "defective")


@pytest.mark.parametrize("seed", range(40))
@pytest.mark.parametrize("n", [2, 4, 8])
@pytest.mark.parametrize("dtype", [torch.float64, torch.float32])
def test_an_orthogonal_map_never_collapses(n, seed, dtype):
    q = _q(n, seed)
    if torch.det(q) < 0:
        q[:, 0] = -q[:, 0]
    c = discrete_dichotomy_certificate(q.to(dtype))
    assert c.collapses is False and c.fate == "MARGINAL"


@pytest.mark.parametrize("seed", range(40))
def test_a_discrete_jordan_block_survives_any_change_of_basis(seed):
    c = discrete_dichotomy_certificate(_rotated([[1.0, 1.0], [0.0, 1.0]], seed))
    assert (c.fate, c.collapses, c.marginal_kind) == ("DIVERGE", False, "defective")


@pytest.mark.parametrize("seed", range(20))
@pytest.mark.parametrize("scale", [1.0, 100.0, 1000.0])
@pytest.mark.parametrize("dtype", [torch.float64, torch.float32])
def test_a_true_fixed_point_manifold_still_reads_frozen(scale, seed, dtype):
    """The other side of the same cut: the tolerance must not turn a frozen system into a false
    alarm, in the precision it arrived in."""
    A = _rotated(torch.diag(torch.tensor([-scale, 0.0, 0.0], dtype=torch.float64)), seed).to(dtype)
    c = dichotomy_certificate(A)
    assert (c.fate, c.collapses, c.marginal_kind) == ("MARGINAL", True, "frozen")
    g = collapse_certificate(A)
    assert g.guaranteed is True and g.null_kind == "frozen"


def test_the_discrete_split_reads_complex_eigenvalues_by_modulus():
    """Real Schur passes (Re λ, Im λ) to its sort. Given one argument the callback saw only Re λ, so
    this unstable pair, |λ|=1.2 with Re λ=0.6, was sorted into the "active" block and given a decay
    rate. The fate came from a different computation, which is why this stayed hidden."""
    re, im = 0.6, (1.2 ** 2 - 0.6 ** 2) ** 0.5
    A = torch.tensor([[re, im, 0.0], [-im, re, 0.0], [0.0, 0.0, 0.5]], dtype=torch.float64)
    c = discrete_dichotomy_certificate(A)
    assert c.fate == "DIVERGE"
    assert (c.active_dim, c.slow_dim) == (1, 2)
    assert c.active_decay_factor < 1.0 and c.transient_bound == pytest.approx(1.0)


def test_the_discrete_bound_covers_a_stable_rotation_with_coupling():
    th = 0.5
    M = np.array([[np.cos(th), np.sin(th), 1.0], [-np.sin(th), np.cos(th), 1.0], [0.0, 0.0, 0.5]])
    c = discrete_dichotomy_certificate(torch.tensor(M))
    assert (c.fate, c.marginal_kind) == ("MARGINAL", "rotating")
    assert (c.active_dim, c.slow_dim) == (1, 2)
    peak = max(np.linalg.norm(np.linalg.matrix_power(M, k), 2) for k in range(1, 400))
    assert c.full_transient_bound >= peak


@pytest.mark.parametrize("big", [1e3, 1e6, 1e9])
def test_a_large_active_mode_does_not_blur_the_boundary(big):
    """Scaling the tolerance by ‖M‖ merged a Jordan block at 0 next to a −1e6 mode into semisimple
    "frozen", and called it a collapse while the state grew without bound."""
    rot = dichotomy_certificate(torch.tensor([[-big, 0, 0], [0, 0, 0.5], [0, -0.5, 0]], dtype=torch.float64))
    assert (rot.collapses, rot.marginal_kind) == (False, "rotating")
    jordan = dichotomy_certificate(torch.tensor([[-big, 0, 0], [0, 0, 0.5], [0, 0, 0]], dtype=torch.float64))
    assert (jordan.fate, jordan.marginal_kind) == ("DIVERGE", "defective")


@pytest.mark.parametrize("big", [1e3, 3e6])
def test_a_large_nilpotent_block_does_not_blur_the_circle(big):
    def block(top):
        return torch.tensor(np.block([[np.asarray(top), np.zeros((2, 2))],
                                      [np.zeros((2, 2)), np.array([[0.0, big], [0.0, 0.0]])]]))
    th = 0.05
    rot = discrete_dichotomy_certificate(block([[np.cos(th), np.sin(th)], [-np.sin(th), np.cos(th)]]))
    assert (rot.collapses, rot.marginal_kind) == (False, "rotating")
    jordan = discrete_dichotomy_certificate(block([[1.0, 0.05], [0.0, 1.0]]))
    assert (jordan.fate, jordan.marginal_kind) == ("DIVERGE", "defective")
    flip = discrete_dichotomy_certificate(torch.tensor(
        [[-1.0, 0.0, 0.0], [0.0, 0.0, big], [0.0, 0.0, 0.0]], dtype=torch.float64))
    assert (flip.collapses, flip.marginal_kind) == (False, "rotating")


@pytest.mark.parametrize("A,kind", [
    (torch.diag(torch.tensor([-1e4, 0.009], dtype=torch.float32)), "growing"),
    (torch.diag(torch.tensor([-1e8, 0.009], dtype=torch.float64)), "growing"),
    (torch.tensor([[-1e5, 0, 0], [0, 0, 2.0], [0, -2.0, 0]], dtype=torch.float32), "rotating"),
    (torch.tensor([[-1e9, 0, 0], [0, 0, 2.0], [0, -2.0, 0]], dtype=torch.float64), "rotating"),
])
def test_collapse_guarantee_is_not_widened_by_one_large_mode(A, kind):
    c = collapse_certificate(A)
    assert c.guaranteed is False and c.null_kind == kind


@pytest.mark.parametrize("A", [
    torch.tensor([[-1e6, 0, 0], [0, -1.0, 2.0], [0, -2.0, 0]], dtype=torch.float32),
    torch.tensor([[-1e10, 0, 0], [0, -1.0, 2.0], [0, -2.0, 0]], dtype=torch.float64),
])
def test_collapse_guarantee_sees_a_cross_term_next_to_a_large_mode(A):
    c = collapse_certificate(A)
    assert c.cross_term == pytest.approx(2.0)
    assert c.guaranteed is False


def test_a_normal_matrix_keeps_its_guarantee_at_large_scale():
    """The tolerance is tight but must stay above rounding. Measured: 9·eps·‖A‖ up to d=512. float32
    stops at 1e3 because at 1e6 its rounding is itself larger than the eig_eps null band."""
    for seed in range(20):
        for scale, dtype in ((1e6, torch.float64), (1e3, torch.float32)):
            d = torch.zeros(32, dtype=torch.float64)
            d[:16] = -scale
            assert collapse_certificate(_rotated(torch.diag(d), seed).to(dtype)).guaranteed is True


# ── a batch answers for every member ───────────────────────────────────────────────────────────

GOOD = np.array([[-1.0, 3.0], [-3.0, 0.0]])
BAD = np.eye(2)


@pytest.mark.parametrize("order", [(GOOD, BAD), (BAD, GOOD)])
def test_collapse_certificate_gates_cover_the_whole_batch(order):
    """The result came from one member, so proven_contracting read True while another diverged."""
    c = collapse_certificate(torch.tensor(np.stack(order)))
    assert c.guaranteed is False
    assert c.proven_contracting is False and c.full_contracting is False
    assert c.spectral_abscissa == pytest.approx(1.0)


@pytest.mark.parametrize("swap", [False, True])
def test_a_batch_bound_covers_every_member(swap):
    """All members collapse, so the fate cannot pick out the one with the 1000× transient."""
    sharp = np.array([[-1.0, 1000.0], [0.0, -1.0]])
    pair = [-0.5 * np.eye(2), sharp]
    c = dichotomy_certificate(torch.tensor(np.stack(pair[::-1] if swap else pair)))
    alone = dichotomy_certificate(torch.tensor(sharp))
    assert c.full_transient_bound == pytest.approx(alone.full_transient_bound)
    assert c.active_decay_rate == pytest.approx(alone.active_decay_rate)


@pytest.mark.parametrize("swap", [False, True])
def test_a_discrete_batch_bound_covers_every_member(swap):
    sharp = np.array([[0.5, 1000.0], [0.0, 0.5]])
    pair = [0.5 * np.eye(2), sharp]
    c = discrete_dichotomy_certificate(torch.tensor(np.stack(pair[::-1] if swap else pair)))
    alone = discrete_dichotomy_certificate(torch.tensor(sharp))
    assert c.full_transient_bound == pytest.approx(alone.full_transient_bound)
    assert c.active_decay_factor == pytest.approx(alone.active_decay_factor)
    assert c.kreiss_bound == pytest.approx(alone.kreiss_bound)


def test_nearly_identical_members_are_not_merged():
    """allclose merged these. One contracts and one grows, and the batch certified on the first."""
    batch = torch.stack([0.999995 * torch.eye(2, dtype=torch.float64),
                         1.000004 * torch.eye(2, dtype=torch.float64)])
    assert discrete_dichotomy_certificate(batch).fate == "DIVERGE"
    assert jsrr_certificate(batch).stable is False


# ── smaller findings ───────────────────────────────────────────────────────────────────────────

def test_rho_on_the_boundary_is_never_accepted():
    """Rounding reads 13 of 200 random orthogonal maps just under 1. On the boundary is not contraction."""
    for seed in range(200):
        c = jsrr_certificate(_q(4, seed))
        assert c.regime == "critical" and c.stable is False


def test_one_dimensional_state_has_no_shape_and_still_gets_its_kick():
    """L2′ needs d ≥ 2, so an armed step at d=1 raised ValueError from the covariance leg."""
    m = CIO_SDE(dim=1, ctrl_dim=2, hidden=4)
    for p in m.pcsf.parameters():
        torch.nn.init.zeros_(p)
    m.graph.active = LinearDynamics(torch.zeros(1, 1), B=torch.zeros(1, 2), noise=0.0)
    m.intervention_policy = InterventionPolicy(observe_only=False, max_interventions=10)
    op = AntiCollapseOperator(strength=0.5)
    m.anti_collapse_op = op
    assert op.detector._anisotropy(torch.ones(1, 1, 1)) == 0.0        # was NaN
    x = torch.tensor([[1e-4]])
    next_x, sigma, info = m.forward_step(x, torch.ones(1, 1, 1), 0.05, torch.ones(1, 1), step=0)
    assert info["anti_collapse_p"] > 0.0
    assert float((next_x - x).norm()) > 0.0
    assert sigma.shape == (1, 1, 1) and torch.isfinite(sigma).all()
