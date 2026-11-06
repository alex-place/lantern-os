"""Engine-level tests for the Σ₀⁻¹ anti-collapse claims (Theorem C3 + Lemma S1).

The older C3 tests evaluate Σ+bP before the engine's final PSD projection, so they could not
see the failures pinned here. Every test in this file drives the shipped operator, and where
it matters the shipped `forward_step`, rather than an idealised update:

  - the covariance cap could erase the bump (Σ_pred = σ_max·I)
  - one batch-wide floor left high-scale samples flat
  - clipping `a` at ε_a let a large strength·p bump FLATTEN an anisotropic Σ_pred
  - above d≈400 no rank-(d−1) bump can reach ε_a, and the floor silently returned 0
  - the state kick had no floor, so it vanished at the gate boundary (the p→0 defect)
  - ‖∇ₓL‖ and ‖∂H/∂u‖ were divided by the batch size, so the gate depended on B
  - x* was not an equilibrium of the real flow for non-normal A
  - the gate was one decision for the batch, on mean signals and the mean Jacobian, so a collapsed
    member could hide among healthy ones; it now decides each trajectory, and a batch run equals
    its rows run alone, bit for bit where its matrix products are exact (Tensor.std used to stop that)
  - the kick's subspace came from A_s, partly along directions the drift moves; it is now each
    sample's own null(A)

Also pinned: why "zero collapses" is not evidence for the operator (a placebo scores the same),
what IS evidence (the gate clears for the real operator and stays latched for the placebo), and
the documented limit (the state may rest once the gate has cleared).
"""
import math

import pytest

torch = pytest.importorskip("torch")

from src.cio_sde import (
    CIO_SDE, LinearDynamics, rollout,
    SemanticCollapseOperator, AntiCollapseOperator, InterventionPolicy,
)
from src.cio_sde.engine import CovarianceField, Dynamics


ARMED = dict(observe_only=False, max_interventions=10 ** 9)


def _zero_policy(m):
    for p in m.pcsf.parameters():
        torch.nn.init.zeros_(p)
    return m


class _DiagonalNoise(LinearDynamics):
    """LinearDynamics with a per-dimension diffusion gain (needed for an exact Riccati
    fixed point at the covariance cap)."""

    def __init__(self, A, gain, ctrl_dim=2):
        super().__init__(A, B=torch.zeros(A.shape[0], ctrl_dim), noise=0.0)
        self.register_buffer("gain", gain)

    def diffusion(self, x):
        return self.gain.expand_as(x)


def _per_sample_a(detector, sigma):
    return detector._anisotropy_per_sample(sigma)


# ── the covariance cap (research audit, 2026-11-05) ──────────────────────────────────────

def _cap_fixed_point_model():
    """A=diag(500,0,0,0), Σ=1000·I, Q=diag(0,1e6,1e6,1e6): an exact Riccati fixed point
    sitting on the σ_max cap, so Σ_pred = σ_max·I and the bump has no headroom."""
    A = torch.diag(torch.tensor([500.0, 0.0, 0.0, 0.0], dtype=torch.float64))
    gain = torch.tensor([0.0, 1000.0, 1000.0, 1000.0], dtype=torch.float64)
    m = CIO_SDE(dim=4, ctrl_dim=2, hidden=8).double()
    m.graph.active = _DiagonalNoise(A, gain).double()
    _zero_policy(m)
    m.intervention_policy = InterventionPolicy(**ARMED)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    return m


def test_cap_cannot_erase_the_lift_in_forward_step():
    m = _cap_fixed_point_model()
    sigma = 1000.0 * torch.eye(4, dtype=torch.float64).unsqueeze(0)
    # x has no component on the active mode, so the drift cannot move it.
    x = torch.tensor([[0.0, 1e-3, 0.0, 0.0]], dtype=torch.float64)
    noise = torch.zeros_like(x)

    _, sigma_next, info = m.forward_step(x, sigma, 0.05, noise, step=0)

    assert info["sigma0_proximity"] > 0.0, "setup must sit inside the gate"
    op = m.anti_collapse_op
    assert op.detector._anisotropy(sigma_next) >= op.detector.anisotropy_eps
    assert float(torch.linalg.eigvalsh(sigma_next).max()) <= m.cov.sigma_max * (1 + 1e-9)
    # The gate cannot fire again on the very next evaluation.
    x2, sigma2, info2 = m.forward_step(x, sigma_next, 0.05, noise, step=1)
    assert info2["sigma0_proximity"] == 0.0


def test_shape_preserving_projection_keeps_anisotropy_and_bounds():
    cov = CovarianceField(4)
    det = SemanticCollapseOperator()
    g = torch.Generator().manual_seed(11)
    for _ in range(50):
        Q, _ = torch.linalg.qr(torch.randn(4, 4, generator=g, dtype=torch.float64))
        ev = torch.tensor([1.0, 40.0, 500.0, 5000.0], dtype=torch.float64)
        raw = ((Q * ev) @ Q.T).unsqueeze(0)
        out = cov.project_preserving_shape(raw)
        vals = torch.linalg.eigvalsh(out)
        assert float(vals.max()) <= cov.sigma_max * (1 + 1e-9)
        assert float(vals.min()) >= cov.eps * (1 - 1e-9)
        assert det._anisotropy(out) == pytest.approx(det._anisotropy(raw), rel=1e-9)


def test_shape_preserving_projection_is_identity_when_in_range():
    cov = CovarianceField(3)
    s = torch.diag(torch.tensor([1.0, 2.0, 3.0], dtype=torch.float64)).unsqueeze(0)
    assert torch.allclose(cov.project_preserving_shape(s), s)


# ── batch scope (research audit §9) ──────────────────────────────────────────────────────

def test_floor_is_per_sample_not_batch_average():
    det = SemanticCollapseOperator()
    op = AntiCollapseOperator(detector=det, strength=0.5)
    eye = torch.eye(4, dtype=torch.float64)
    sigma = torch.stack([1000.0 * eye, eye])
    A = torch.diag(torch.tensor([0.8, 0.0, 0.0, 0.0], dtype=torch.float64)).unsqueeze(0)
    x, noise = torch.zeros(2, 4, dtype=torch.float64), torch.zeros(2, 4, dtype=torch.float64)

    _, extra = op.excite(x, sigma, A, 0.01, noise)
    a = _per_sample_a(det, sigma + extra)
    assert bool((a >= det.anisotropy_eps).all()), a
    # Each sample's bump scales with its own covariance; the low-scale one is not overdosed.
    assert float(torch.linalg.norm(extra[0])) > 100 * float(torch.linalg.norm(extra[1]))


# ── `a` must not be clipped: a bump can FLATTEN an anisotropic Σ_pred ─────────────────────

def test_bump_cannot_flatten_an_anisotropic_prediction():
    """Σ_pred=diag(1,.5,.5,.5), bump of exactly 0.5 on the last three modes would give Σ=I.
    Reachable: `excite` reads the Riccati-propagated Σ, which can be anisotropic even though
    the trigger read a flat Σ. strength·p = 0.5 is what made the bump land on the flat point."""
    det = SemanticCollapseOperator()
    op = AntiCollapseOperator(detector=det, strength=1.0)
    sigma = torch.diag(torch.tensor([1.0, 0.5, 0.5, 0.5], dtype=torch.float64)).unsqueeze(0)
    A = torch.diag(torch.tensor([0.8, 0.0, 0.0, 0.0], dtype=torch.float64)).unsqueeze(0)
    x, noise = torch.zeros(1, 4, dtype=torch.float64), torch.zeros(1, 4, dtype=torch.float64)
    _, extra = op.excite(x, sigma, A, 0.5, noise)
    assert det._anisotropy(sigma + extra) >= det.anisotropy_eps


# ── dimension: rank-(d−1) cannot reach ε_a above d≈400 ───────────────────────────────────

@pytest.mark.parametrize("d", [4, 64, 400, 401, 512, 2048])
def test_lift_holds_in_every_dimension(d):
    det = SemanticCollapseOperator()
    op = AntiCollapseOperator(detector=det, strength=0.5)
    m = CIO_SDE(dim=d, ctrl_dim=2, hidden=4)
    x = torch.full((1, d), 1e-3 / math.sqrt(d))
    u = torch.zeros(1, 2)
    A = torch.zeros(1, d, d)
    A[0, 0, 0] = 1.0                                        # rank 1: the hardest case
    pattern = torch.tensor([1.0 if i % 2 else -1.0 for i in range(d)])
    sigma = torch.diag(1.0 + 0.5 * det.anisotropy_eps * pattern).unsqueeze(0)
    assert det.evaluate(m, x, u, sigma, A).triggered

    p = op.proximity(m, x, u, sigma, A)
    _, extra = op.excite(x, sigma, A, p, torch.zeros(1, d))
    plus = sigma + extra
    assert det._anisotropy(plus) >= det.anisotropy_eps
    assert not det.evaluate(m, x, u, plus, A).triggered


def test_cov_floor_refuses_an_infeasible_rank():
    """It used to return 0.0 silently, i.e. 'no floor needed' exactly when no floor can work."""
    op = AntiCollapseOperator()
    with pytest.raises(ValueError):
        op._cov_floor(torch.eye(512).unsqueeze(0), 512, 511)


# ── Lemma S1: the state kick ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("gain", [0.0, 0.002])
@pytest.mark.parametrize("c_scale", [0.0, 0.004])
def test_kick_escapes_the_gradient_ball_with_probability_one_half(gain, c_scale):
    """Lemma S1 (Anderson + Weyl): for x_next = c + (D + κP)ξ with D ⪰ 0, any c, and
    κ ≥ r/median(χ₁), P(‖x_next‖ ≥ r) ≥ ½. So even at p→0 the kick cannot pin the state
    inside {‖∇ₓL‖ < ε_g}. Monte-Carlo over 20,000 draws of the shipped operator's kick."""
    det = SemanticCollapseOperator()
    op = AntiCollapseOperator(detector=det, strength=0.5)
    d, n = 4, 20000
    g = torch.Generator().manual_seed(5)
    A = torch.diag(torch.tensor([0.8, 0.0, 0.0, 0.0])).unsqueeze(0)
    xi = torch.randn(n, d, generator=g)
    sigma = torch.eye(d).expand(n, d, d)
    dx, _ = op.excite(torch.zeros(n, d), sigma, A, 1e-6, xi)    # p→0: the floor carries it

    c = c_scale * torch.tensor([1.0, -1.0, 0.5, 0.0])           # any offset, inside the ball
    x_next = c + gain * xi + dx
    r = det.grad_eps / 2.0
    escaped = float((x_next.norm(dim=-1) >= r).float().mean())
    assert escaped >= 0.5 - 0.01, escaped


def test_kick_floor_respects_a_disabled_state_leg():
    op = AntiCollapseOperator(strength=0.0)
    A = torch.diag(torch.tensor([0.8, 0.0, 0.0, 0.0])).unsqueeze(0)
    dx, extra = op.excite(torch.zeros(1, 4), torch.eye(4).unsqueeze(0), A, 0.5, torch.ones(1, 4))
    assert float(dx.abs().sum()) == 0.0
    assert float(extra.abs().sum()) > 0.0                       # covariance leg still acts


# ── gate signals must not depend on batch size ───────────────────────────────────────────

def test_gate_signals_do_not_depend_on_batch_size():
    det = SemanticCollapseOperator()
    m = _zero_policy(CIO_SDE(dim=3, ctrl_dim=2, hidden=4))
    m.graph.active = LinearDynamics(torch.eye(3), B=torch.eye(3)[:, :2], noise=0.0)
    x = torch.tensor([[0.2, 0.0, 0.0]])
    u = torch.tensor([[0.1, 0.0]])
    for signal in (det._grad_norm, det._ctrl_sensitivity):        # one value per sample now
        single, many = signal(m, x, u), signal(m, x.repeat(8, 1), u.repeat(8, 1))
        assert single.shape == (1,) and many.shape == (8,)
        assert torch.allclose(many, single.expand(8), rtol=1e-5)


def test_ctrl_signal_is_the_hamiltonian_gradient_not_just_stage_cost():
    """‖∂H/∂u‖ with H = L + λᵀf. At u=0 the stage cost alone gives 0 however much leverage the
    control has, so the gate used to report that control cannot distinguish actions while the
    state was far from target and B was large."""
    det = SemanticCollapseOperator()
    d = 2
    m = _zero_policy(CIO_SDE(dim=d, ctrl_dim=d, hidden=4))
    m.graph.active = LinearDynamics(torch.zeros(d, d), B=5.0 * torch.eye(d), noise=0.0)
    x = torch.tensor([[0.3, 0.4]])                              # ∇ₓL = 2x, ‖x‖ = 0.5
    u = torch.zeros(1, d)
    assert float(det._ctrl_sensitivity(m, x, u)) == pytest.approx(5.0, rel=1e-5)   # ‖Bᵀ·2x‖

    m.graph.active = LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, d), noise=0.0)
    assert float(det._ctrl_sensitivity(m, x, u)) == pytest.approx(0.0, abs=1e-8)   # no leverage


# ── x* must be an equilibrium ────────────────────────────────────────────────────────────

def test_collapse_target_is_a_true_equilibrium_for_any_A():
    """A rotation block has A_s=0, so the old A_s-null projector kept x unchanged and ‖Ax*‖
    stayed large, even though A is NORMAL. x* now projects onto null(A), the actual fixed
    points of the linearised flow."""
    det = SemanticCollapseOperator()
    normal_rotation = torch.tensor([[0.0, 3.0, 0.0], [-3.0, 0.0, 0.0], [0.0, 0.0, 0.0]])
    jordan = torch.tensor([[0.0, 3.0, 1.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]])
    for A in (normal_rotation, jordan):
        x = torch.tensor([[1.0, 2.0, 3.0]])
        x_star, outcome = det._collapse_state(x, A.unsqueeze(0))
        assert outcome.value == "attractor"
        assert float((x_star @ A.T).norm()) < 1e-5              # f(x*) = 0
        assert float(x_star.norm()) <= float(x.norm()) + 1e-6   # still non-expansive


# ── C3 on the real engine, adversarial grid ──────────────────────────────────────────────

@pytest.mark.parametrize("A_rows", [
    [[-0.5, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    [[0, 3.0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],       # non-normal, rank 1
    [[-0.5, 2.0, 1.0, 1.0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],  # non-normal, rank 1
])
def test_gate_never_true_on_consecutive_steps_in_the_engine(A_rows):
    """Theorem C3 through forward_step: includes the post-bump projection, the Riccati step,
    per-sample floors and non-normal A."""
    A = torch.tensor(A_rows, dtype=torch.float32)
    g = torch.Generator().manual_seed(3)
    for scale in (1.0, 900.0):                                  # far from, and near, the cap
        m = _zero_policy(CIO_SDE(dim=4, ctrl_dim=2, hidden=4))
        m.graph.active = LinearDynamics(A, B=torch.zeros(4, 2), noise=0.0)
        m.intervention_policy = InterventionPolicy(**ARMED)
        m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
        m.collapse_op = SemanticCollapseOperator()
        x = 1e-4 * torch.randn(1, 4, generator=g)
        sigma = scale * torch.eye(4).unsqueeze(0)
        prev, fired = False, 0
        for t in range(60):
            x, sigma, info = m.forward_step(x, sigma, 0.05, torch.randn_like(x), step=t)
            now = info["sigma0_proximity"] > 0.0
            assert not (prev and now), f"gate true twice at step {t}"
            assert info["collapse"] is None                      # guard: no overwrite
            fired += int(now)
            prev = now
        assert fired >= 1, "the case must actually enter the gate"


# ── what the 900/900 sweep did and did not measure ───────────────────────────────────────

class _Placebo(AntiCollapseOperator):
    """Does nothing when it fires: no state kick, no covariance bump."""

    def excite(self, x, sigma, A, p, noise):
        return torch.zeros_like(x), torch.zeros_like(sigma)


def _sweep_like_trial(op_factory, seed=20260619, steps=30):
    """A=0 and no noise: Σ stays isotropic and x stays put, so nothing but the operator can
    clear the gate. Any nonzero A or noise would clear it unaided, and hide the difference."""
    torch.manual_seed(seed)
    m = _zero_policy(CIO_SDE(dim=4, ctrl_dim=2, hidden=16))
    m.graph.active = LinearDynamics(torch.zeros(4, 4), B=torch.zeros(4, 2), noise=0.0)
    m.collapse_op = SemanticCollapseOperator()
    m.intervention_policy = InterventionPolicy(**ARMED)
    if op_factory is not None:
        m.anti_collapse_op = op_factory()
    x0 = 1e-3 * torch.randn(8, 4)
    s0 = torch.eye(4).expand(8, 4, 4).clone()
    _, _, tr = rollout(m, x0, s0, steps=steps, dt=0.05, base_seed=seed)
    gate = sum(1 for s in tr.steps if s.get("sigma0_proximity", 0.0) > 0.0)
    return len(tr.collapses), gate


def test_zero_collapses_is_structural_and_proves_nothing_about_the_operator():
    """engine.forward_step skips the freeze check whenever the operator fired, and
    proximity>0 ⟺ triggered. So ANY attached operator records zero collapses, including one
    that does nothing. This is why the old 'prevented' metric could not fail."""
    baseline_collapses, _ = _sweep_like_trial(None)
    placebo_collapses, _ = _sweep_like_trial(_Placebo)
    real_collapses, _ = _sweep_like_trial(lambda: AntiCollapseOperator(strength=0.5))
    assert baseline_collapses > 0                                # the arm can collapse
    assert placebo_collapses == 0 and real_collapses == 0        # identical by construction


def test_real_operator_clears_the_gate_and_the_placebo_does_not():
    """The placebo-controlled signal: how long the system stays inside the gate."""
    _, placebo_gate = _sweep_like_trial(_Placebo)
    _, real_gate = _sweep_like_trial(lambda: AntiCollapseOperator(strength=0.5))
    assert placebo_gate > 3 * max(real_gate, 1), (placebo_gate, real_gate)


# ── the documented limit ─────────────────────────────────────────────────────────────────

def test_c3_does_not_promise_perpetual_motion():
    """Scope pin: with no drift on the null modes, no noise and no grounding, the state rests
    at an equilibrium once the gate has cleared. C3 and S1 hold throughout. Nothing inside the
    loop can make this system move again; that is what 'grounding is the safety mechanism'
    means, and the docs must not read C3 as saying otherwise."""
    torch.manual_seed(1)
    m = _zero_policy(CIO_SDE(dim=4, ctrl_dim=2, hidden=4))
    A = torch.diag(torch.tensor([-0.5, 0.0, 0.0, 0.0]))
    m.graph.active = LinearDynamics(A, B=torch.zeros(4, 2), noise=0.0)
    m.intervention_policy = InterventionPolicy(**ARMED)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    x, s = 1e-3 * torch.randn(1, 4), torch.eye(4).unsqueeze(0)
    fired, tail = 0, []
    for t in range(1500):
        xn, s, info = m.forward_step(x, s, 0.05, torch.randn_like(x), step=t)
        fired += int(info["sigma0_proximity"] > 0.0)
        if t >= 1400:
            tail.append(float((xn - x).detach().norm()))
        x = xn
    assert fired >= 1
    assert max(tail) < 1e-6                                      # the state has stopped


def test_a_switching_jacobian_can_erase_the_kick():
    """The boundary of C3 and S1, on the engine itself: both are statements about one step under one
    A, and they do not imply state retention when A changes (lantern-os-research PR #14). Here the
    kick lands in null(A₁), the gate clears as C3 says, and the next regime's Euler map, also
    non-expansive, removes exactly that subspace: F₂F₁ = 0. A retention theorem would need a lower
    bound on the switched product restricted to the kicked subspace, which this rules out in general."""
    d, dt = 4, 0.05
    a1 = torch.diag(torch.tensor([0.0, 0.0, 0.0, -1.0 / dt]))
    a2 = torch.diag(torch.tensor([-1.0 / dt, -1.0 / dt, -1.0 / dt, 0.0]))
    m = CIO_SDE(dim=d, ctrl_dim=2, hidden=4)
    for p in m.pcsf.parameters():
        torch.nn.init.zeros_(p)
    m.intervention_policy = InterventionPolicy(observe_only=False, max_interventions=10)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)

    torch.manual_seed(0)
    m.graph.active = LinearDynamics(a1, B=torch.zeros(d, 2), noise=0.0)
    x1, sigma1, first = m.forward_step(torch.zeros(1, d), torch.eye(d).unsqueeze(0), dt,
                                       torch.randn(1, d), step=0)
    assert first["anti_collapse_p"] > 0.0 and float(x1.norm()) > 0.0   # the kick really moved the state

    m.graph.active = LinearDynamics(a2, B=torch.zeros(d, 2), noise=0.0)
    x2, _, second = m.forward_step(x1, sigma1, dt, torch.randn(1, d), step=1)
    assert second["anti_collapse_p"] == 0.0                            # the gate cleared: no second kick
    assert float(x2.norm()) < 1e-5 * float(x1.norm())                  # and the kick is gone


# ── S1's hypothesis, enforced (lantern-os-research PR #14) ───────────────────────────────────────

def test_s1_fails_without_its_hypothesis():
    """dW and the kick share ξ. With D = −(κ/2)·I and a rank-1 kick, D + κP = diag(κ/2, −κ/2), so the
    escape probability is P(χ₂ ≥ 2·median χ₁) = exp(−2·median²) ≈ 0.40, not the ½ that S1 gives for D ⪰ 0."""
    median = 0.6744897501960817
    xi = torch.randn(400000, 2, generator=torch.Generator().manual_seed(0))
    escape = lambda gains: float(((xi * torch.tensor(gains)).norm(dim=-1) >= median).float().mean())
    assert escape([0.5, -0.5]) == pytest.approx(math.exp(-2 * median ** 2), abs=0.005)
    assert escape([0.5, -0.5]) < 0.45
    assert escape([1.0, 0.0]) == pytest.approx(0.5, abs=0.005)    # D = 0, the lemma's tight case
    assert escape([1.5, 0.5]) > 0.5                               # D = +(κ/2)·I


def test_negative_noise_is_rejected_at_construction():
    with pytest.raises(ValueError, match="noise"):
        LinearDynamics(torch.zeros(2, 2), noise=-0.01)
    assert LinearDynamics(torch.zeros(2, 2), noise=0.0).diffusion(torch.zeros(1, 2)).sum() == 0.0


class _NegativeGain(LinearDynamics):
    """A subclass the constructor check cannot see."""

    def diffusion(self, x):
        return torch.full_like(x, -0.01)


def _armed_on(node, d=4):
    m = CIO_SDE(dim=d, ctrl_dim=2, hidden=4)
    _zero_policy(m)
    m.graph.active = node
    m.intervention_policy = InterventionPolicy(**ARMED)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    return m


def test_an_armed_step_refuses_a_negative_gain_from_any_dynamics():
    d = 4
    m = _armed_on(_NegativeGain(torch.diag(torch.tensor([1.0, 0.0, 0.0, 0.0])), B=torch.zeros(d, 2), noise=0.0))
    with pytest.raises(ValueError, match="non-negative diffusion gain"):
        m.forward_step(torch.zeros(1, d), torch.eye(d).unsqueeze(0), 0.05, torch.randn(1, d), step=0)


class _SharedGain(LinearDynamics):
    """One diffusion gain for every row, shape (d,): it broadcasts everywhere in forward_step."""

    def diffusion(self, x):
        return torch.tensor([0.1, -0.1, 0.1, 0.1])


def test_a_negative_gain_shared_by_all_rows_is_refused():
    """The guard used to index a (d,) gain by row number, so it read entries of the gain vector instead of
    the kicked row's gain, and let a negative one through (independent review of the per-row change)."""
    A = torch.diag(torch.tensor([-0.5, 0.0, 0.0, 0.0]))
    m = _armed_on(_SharedGain(A, B=torch.zeros(4, 2), noise=0.0))
    for x in (1e-4 * torch.tensor([[1.0, -1.0, 0.5, 1.0]]),
              torch.cat([torch.full((2, 4), 0.5), 1e-4 * torch.ones(1, 4)])):   # only row 2 fires
        with pytest.raises(ValueError, match="non-negative diffusion gain"):
            m.forward_step(x, torch.eye(4).expand(len(x), 4, 4).clone(), 0.05, torch.ones_like(x), step=0)


def test_a_negative_gain_is_only_refused_when_the_kick_would_use_it():
    """Away from the gate the sign does nothing: the noise is symmetric and nothing shares it."""
    d = 4
    m = _armed_on(_NegativeGain(-torch.eye(d), B=torch.zeros(d, 2), noise=0.0))
    _, _, info = m.forward_step(torch.ones(1, d), torch.eye(d).unsqueeze(0), 0.05, torch.randn(1, d), step=0)
    assert info["anti_collapse_p"] == 0.0


# ── the gate decides per trajectory (lantern-os-research PR #14, design limit 1) ─────────────────

def test_the_gate_decides_each_trajectory_on_its_own_jacobian():
    """e₁e₁ᵀ and e₂e₂ᵀ each have rank 1, and each triggers alone. The gate used to read the batch-mean
    Jacobian, which has rank 2, so together neither triggered. Each now triggers on its own Jacobian."""
    d = 4
    e = torch.eye(d)
    a1, a2 = torch.outer(e[0], e[0]), torch.outer(e[1], e[1])
    m = _armed_on(LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 2), noise=0.0))
    gate = SemanticCollapseOperator()

    def mask(As):
        n = As.shape[0]
        return gate.evaluate(m, torch.zeros(n, d), torch.zeros(n, 2),
                             torch.eye(d).expand(n, d, d).clone(), As).mask.tolist()

    assert mask(a1.unsqueeze(0)) == [True] and mask(a2.unsqueeze(0)) == [True]
    assert mask(torch.stack([a1, a2])) == [True, True]
    assert int(torch.linalg.matrix_rank(torch.stack([a1, a2]).mean(0))) == 2   # what the old gate read


def _mixed_batch(d=4, collapse_op=False):
    """Row 0 is collapsed: at the target, flat Σ, rank-1 A, no control leverage. Row 1 differs only in
    being far from the target (‖∇ₓL‖ = 2), so it is healthy. The batch-mean ‖∇ₓL‖ is about 1, a hundred
    times ε_g, so a gate on mean signals sees no collapse in this batch at all."""
    A = torch.zeros(d, d, dtype=torch.float64)
    A[0, 0] = -0.5
    m = CIO_SDE(dim=d, ctrl_dim=2, hidden=4).double()
    _zero_policy(m)
    m.graph.active = LinearDynamics(A, B=torch.zeros(d, 2, dtype=torch.float64), noise=0.0).double()
    m.intervention_policy = InterventionPolicy(**ARMED)
    if collapse_op:
        m.collapse_op = SemanticCollapseOperator()
    else:
        m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    x = torch.zeros(2, d, dtype=torch.float64)
    x[0] = 1e-4 * torch.tensor([1.0, -1.0, 0.5, 2.0], dtype=torch.float64)
    x[1] = 0.5
    sigma = torch.eye(d, dtype=torch.float64).expand(2, d, d).clone()
    noise = torch.tensor([[0.3, -1.2, 0.8, 0.5], [1.0, 0.4, -0.7, 0.2]], dtype=torch.float64)
    return m, x, sigma, noise


def _plain_step(m, x, sigma, noise):
    """The same step with no Σ₀ operator attached."""
    ops = (m.anti_collapse_op, m.collapse_op)
    m.anti_collapse_op = m.collapse_op = None
    try:
        return m.forward_step(x, sigma, 0.05, noise, step=0)
    finally:
        m.anti_collapse_op, m.collapse_op = ops


def test_a_mixed_batch_gates_the_collapsed_member_only():
    m, x, sigma, noise = _mixed_batch()
    det = m.anti_collapse_op.detector
    u = torch.zeros(2, 2, dtype=torch.float64)
    A = torch.zeros(2, 4, 4, dtype=torch.float64)
    A[:, 0, 0] = -0.5
    signals = det._signals(m, x, u, sigma, A)
    assert float(signals["grad_norm"].mean()) > 50 * det.grad_eps          # a mean-signal gate stays shut
    assert det.evaluate(m, x, u, sigma, A).mask.tolist() == [True, False]
    p = m.anti_collapse_op.proximity(m, x, u, sigma, A)
    assert float(p[0]) > 0.0 and float(p[1]) == 0.0


def test_forward_step_kicks_only_the_collapsed_member():
    m, x, sigma, noise = _mixed_batch()
    plain_x, plain_sigma, _ = _plain_step(m, x, sigma, noise)
    x_next, sigma_next, info = m.forward_step(x, sigma, 0.05, noise, step=0)

    assert info["anti_collapse_fired"].tolist() == [True, False]
    assert [(r.sample, r.kind) for r in info["intervention_receipts"]] == [(0, "excite")]
    assert info["intervention_receipt"] is info["intervention_receipts"][0]
    # the healthy member is exactly what the plain SDE step made
    assert torch.equal(x_next[1], plain_x[1]) and torch.equal(sigma_next[1], plain_sigma[1])
    # the collapsed member was kicked and lifted (C3), and its receipt is its own
    det = m.anti_collapse_op.detector
    assert float((x_next[0] - plain_x[0]).detach().norm()) > 0.0
    assert float(det._anisotropy_per_sample(sigma_next)[0]) >= det.anisotropy_eps
    r = info["intervention_receipts"][0]
    assert r.pre_x_norm == pytest.approx(float(x[0].norm()))
    assert r.post_x_norm == pytest.approx(float(x_next[0].detach().norm()))
    assert r.to_dict()["sample"] == 0


def test_forward_step_overwrites_only_the_collapsed_member():
    m, x, sigma, noise = _mixed_batch(collapse_op=True)
    plain_x, plain_sigma, _ = _plain_step(m, x, sigma, noise)
    x_next, sigma_next, info = m.forward_step(x, sigma, 0.05, noise, step=0)

    assert info["collapse_mask"].tolist() == [True, False]
    assert [(r.sample, r.kind) for r in info["intervention_receipts"]] == [(0, "project_to_attractor")]
    assert torch.equal(x_next[1], plain_x[1]) and torch.equal(sigma_next[1], plain_sigma[1])
    # row 0 sits on null(A) = span{e₂, e₃, e₄}, and keeps its pre-step Σ
    assert torch.allclose(x_next[0], torch.cat([torch.zeros(1, dtype=x.dtype), x[0, 1:]]), atol=1e-12)
    assert torch.equal(sigma_next[0], sigma[0])

    _, _, trace = rollout(m, x, sigma, steps=3, dt=0.05, base_seed=0)
    assert trace.collapses and all(c["samples"] == [0] for c in trace.collapses)


class _Hot:
    """A stand-in anti-collapse operator: every row listed in `hot` is in the gate."""

    def __init__(self, hot):
        self.hot = list(hot)

    def proximity(self, model, x, u, sigma, A):
        return torch.tensor(self.hot, dtype=x.dtype)

    def excite(self, x, sigma, A, p, noise):
        return 0.01 * torch.ones_like(x), torch.zeros_like(sigma)


def test_each_trajectory_spends_its_own_budget():
    d = 4
    m = _armed_on(LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 2), noise=0.0))
    m.intervention_policy = InterventionPolicy(observe_only=False, max_interventions=2)
    m.anti_collapse_op = _Hot([1.0, 0.0])
    x, sigma = torch.zeros(2, d), torch.eye(d).expand(2, d, d).clone()
    kinds = []
    for t in range(3):
        x, sigma, info = m.forward_step(x, sigma, 0.05, torch.zeros(2, d), step=t)
        kinds.append([(r.sample, r.kind) for r in info["intervention_receipts"]])
    assert kinds == [[(0, "excite")], [(0, "excite")], [(0, "blocked")]]
    assert "budget exhausted (2/2)" in info["intervention_receipt"].policy_reason
    # row 1 never fired, so its budget is untouched: one row's history does not spend another's
    m.anti_collapse_op = _Hot([1.0, 1.0])
    _, _, info = m.forward_step(x, sigma, 0.05, torch.zeros(2, d), step=3)
    assert [(r.sample, r.kind) for r in info["intervention_receipts"]] == [(0, "blocked"), (1, "excite")]
    # the counts belong to this batch: a new batch size after spending them needs a reset
    m.anti_collapse_op = _Hot([1.0])
    with pytest.raises(ValueError, match="reset_intervention_count"):
        m.forward_step(x[:1], sigma[:1], 0.05, torch.zeros(1, d), step=4)
    m.reset_intervention_count()
    _, _, info = m.forward_step(x[:1], sigma[:1], 0.05, torch.zeros(1, d), step=4)
    assert info["intervention_receipt"].kind == "excite"


class _BatchWide:
    """A stand-in operator with one proximity for the batch, whose kick is p in every coordinate and whose
    outputs broadcast, as an operator written for the batch-wide gate may do."""

    def __init__(self, p, dx_shape=None):
        self.p, self.dx_shape = p, dx_shape

    def proximity(self, model, x, u, sigma, A):
        return self.p

    def excite(self, x, sigma, A, p, noise):
        assert isinstance(p, float)                      # one number, as the operator gave one
        dx = p if self.dx_shape == () else p * torch.ones(self.dx_shape or x.shape)
        return dx, 0.0


@pytest.mark.parametrize("dx_shape", [None, (4,), (1, 4), ()])
def test_a_batch_wide_operator_output_may_broadcast(dx_shape):
    """index_add needs the exact shape; the batch-wide engine added a broadcasting dx to every row."""
    d = 4
    m = _armed_on(LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 2), noise=0.0))
    m.anti_collapse_op = _BatchWide(0.25, dx_shape)
    x, sigma = torch.zeros(2, d), torch.eye(d).expand(2, d, d).clone()
    plain_x, _, _ = _plain_step(m, x, sigma, torch.zeros(2, d))
    x_next, _, info = m.forward_step(x, sigma, 0.05, torch.zeros(2, d), step=0)
    assert torch.allclose((x_next - plain_x).detach(), torch.full((2, d), 0.25))
    assert [r.kind for r in info["intervention_receipts"]] == ["excite", "excite"]


def test_a_spook_does_not_change_another_rows_kick_under_a_batch_wide_operator():
    """With one proximity for the batch, excite used to get the largest effective proximity of the rows
    that fired, so a spook on row 0 also raised row 1's kick from 0.3 to 1.0."""
    d = 4
    m = _armed_on(LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 2), noise=0.0))
    m.anti_collapse_op = _BatchWide(0.3)
    m.surprise_monitor = _SpookRows([True, False])
    x, sigma = torch.zeros(2, d), torch.eye(d).expand(2, d, d).clone()
    m._surprise_pred_mean, m._surprise_pred_cov = x.clone(), sigma.clone()
    plain_x, _, _ = _plain_step(m, x, sigma, torch.zeros(2, d))
    m._surprise_pred_mean, m._surprise_pred_cov = x.clone(), sigma.clone()
    x_next, _, info = m.forward_step(x, sigma, 0.05, torch.zeros(2, d), step=0)
    kick = (x_next - plain_x).detach()
    assert torch.allclose(kick[0], torch.full((d,), 1.0)) and torch.allclose(kick[1], torch.full((d,), 0.3))
    assert [(r.sample, r.trigger_source) for r in info["intervention_receipts"]] == [
        (0, "both"), (1, "structural")]


def test_signals_are_compared_with_the_thresholds_as_given():
    """In float32, ‖∇ₓL‖ = 2·float32(0.005) is exactly float32(0.01). It is below ε_g = 0.01, and the
    batch-wide gate, which compared Python floats, fired here. A float32 comparison rounds ε_g first."""
    d = 4
    m = _armed_on(LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 2), noise=0.0))
    det = SemanticCollapseOperator()
    x = torch.tensor([[0.005, 0.0, 0.0, 0.0]])
    g = det._grad_norm(m, x, torch.zeros(1, 2))
    assert g.dtype == torch.float32 and float(g) < det.grad_eps
    assert det.evaluate(m, x, torch.zeros(1, 2), torch.eye(d).unsqueeze(0),
                        torch.zeros(1, d, d)).mask.tolist() == [True]
    assert float(m.anti_collapse_op.proximity(m, x, torch.zeros(1, 2), torch.eye(d).unsqueeze(0),
                                              torch.zeros(1, d, d))[0]) > 0.0


class _SpookRows:
    """A stand-in surprise monitor whose spook flags are given, one per row."""
    anti_collapse_trigger = True

    def __init__(self, rows):
        self.rows = rows

    def evaluate(self, x_pred, sigma, y, C, R):
        return {"spook": torch.tensor(self.rows), "nis": torch.zeros(len(self.rows))}

    def update(self, x_pred, sigma, y, C, R):
        return y.detach(), sigma


def test_a_spook_excites_only_its_own_trajectory():
    d = 4
    m = _armed_on(LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 2), noise=0.0))
    m.surprise_monitor = _SpookRows([True, False])
    x = torch.full((2, d), 0.5)                    # both far from target: no structural trigger
    sigma = torch.eye(d).expand(2, d, d).clone()
    m._surprise_pred_mean, m._surprise_pred_cov = x.clone(), sigma.clone()
    noise = torch.randn(2, d, generator=torch.Generator().manual_seed(2))
    plain_x, plain_sigma, _ = _plain_step(m, x, sigma, noise)
    m._surprise_pred_mean, m._surprise_pred_cov = x.clone(), sigma.clone()
    x_next, sigma_next, info = m.forward_step(x, sigma, 0.05, noise, step=0)
    assert info["surprise_spook"] is True
    assert [(r.sample, r.kind, r.trigger_source) for r in info["intervention_receipts"]] == [
        (0, "excite", "surprise")]
    assert torch.equal(x_next[1], plain_x[1]) and torch.equal(sigma_next[1], plain_sigma[1])


@pytest.mark.parametrize("case,scale", [("kick", 5.0), ("kick", 3.0), ("kick", 2.0), ("budget", 5.0)])
def test_a_batch_is_independent_trajectories(case, scale):
    """Row i of a batched run is the same run on row i alone: the gate, the kick, the bump, the budget and
    the receipts all belong to the trajectory. Both operators attached, three interventions each. Bit for bit:
    this A's products are exact (−½ and 1 against zeros), so nothing else here rounds a row differently in a
    batch. At Σ0[1] = 3·I and 2·I row 1 used to differ from its lone run, since Tensor.std rounded the anisotropy
    and the C3 floor of a lone row differently; both now come from _unbiased_std.
    "kick": the real operator on a non-normal rank-1 A, with noise. "budget": the covariance leg alone on
    A = 0, which clears the gate without moving the state, so it re-fires as Σ relaxes and the two
    near-target rows, at different Σ scales, fire at different steps and run out at different times."""
    d, steps, dt = 4, 60, 0.05
    A = torch.zeros(d, d, dtype=torch.float64)
    if case == "kick":
        A[0, 0], A[0, 1] = -0.5, 1.0                           # rank 1, non-normal

    def model():
        m = CIO_SDE(dim=d, ctrl_dim=2, hidden=4).double()
        _zero_policy(m)
        m.graph.active = LinearDynamics(A, B=torch.zeros(d, 2, dtype=torch.float64),
                                        noise=0.002 if case == "kick" else 0.0).double()
        m.intervention_policy = InterventionPolicy(observe_only=False, max_interventions=3)
        m.anti_collapse_op = AntiCollapseOperator(strength=0.5 if case == "kick" else 0.0)
        m.collapse_op = SemanticCollapseOperator()
        return m

    g = torch.Generator().manual_seed(9)
    x0 = torch.cat([1e-4 * torch.randn(2, d, generator=g, dtype=torch.float64),
                    torch.full((1, d), 0.5, dtype=torch.float64)])        # rows 0, 1 near target; row 2 not
    eye = torch.eye(d, dtype=torch.float64)
    s0 = torch.stack([eye, scale * eye, eye])
    noise = torch.randn(steps, 3, d, generator=g, dtype=torch.float64)

    def run(rows):
        m, x, s, log = model(), x0[rows], s0[rows], []
        for t in range(steps):
            x, s, info = m.forward_step(x, s, dt, noise[t, rows], step=t)
            log += [(t, rows[r.sample], r.kind) for r in info["intervention_receipts"]]
        return x.detach(), s, log

    xb, sb, logb = run([0, 1, 2])
    for i in range(3):
        xi, si, logi = run([i])
        assert torch.equal(xb[i], xi[0]) and torch.equal(sb[i], si[0]), i
        assert [e for e in logb if e[1] == i] == logi, i
    fired = {i: [t for t, j, k in logb if j == i and k == "excite"] for i in range(3)}
    assert fired[0] and fired[1] and not fired[2]
    if case == "budget":
        assert fired[0] != fired[1]                             # decided apart, not as one batch
        assert len(fired[0]) == len(fired[1]) == 3
        assert any(k == "blocked" for _, _, k in logb)          # a trajectory's own budget ran out


@pytest.mark.parametrize("d", [2, 3, 4, 8, 17])
def test_the_anisotropy_and_the_c3_floor_read_a_row_the_same_alone_and_in_a_batch(d):
    """Tensor.std reduced a batch of one in two passes and a row of a larger batch by Welford's update, so one Σ
    read a different a(Σ), and a different C3 floor, alone than in a batch (260 of 500 random float64 rows at
    d = 4). Every row now reads the same bits alone, beside a copy of itself and in the batch of 500. In float32
    std accumulated in float64 and agreed with itself, and the values are still the ones it gave. Σ is diagonal,
    so eigvalsh returns its diagonal exactly, sorted, on any LAPACK, and only the reduction is under test."""
    g = torch.Generator().manual_seed(d)
    ev = (1.0 + 0.05 * torch.randn(500, d, generator=g, dtype=torch.float64)).clamp_min(0.5)   # a near ε_a
    sigma = torch.diag_embed(ev)
    op = AntiCollapseOperator()
    det, m = op.detector, op._max_lift_rank(d)
    a, floor = det._anisotropy_per_sample(sigma), op._cov_floor(sigma, d, m)
    for i in range(500):
        one, two = sigma[i:i + 1], sigma[i:i + 1].expand(2, d, d).clone()
        assert torch.equal(det._anisotropy_per_sample(one), a[i:i + 1]), i
        assert torch.equal(det._anisotropy_per_sample(two), a[i].expand(2)), i
        assert torch.equal(op._cov_floor(one, d, m), floor[i:i + 1]), i
        assert torch.equal(op._cov_floor(two, d, m), floor[i].expand(2)), i
    s32 = sigma.float()
    ev32 = torch.linalg.eigvalsh(0.5 * (s32 + s32.transpose(-1, -2))).clamp_min(1e-12)
    a32 = det._anisotropy_per_sample(s32)
    assert torch.equal(a32, ev32.std(dim=-1) / ev32.mean(dim=-1))       # float32: what std gave
    assert all(torch.equal(det._anisotropy_per_sample(s32[i:i + 1]), a32[i:i + 1]) for i in range(500))


def test_a_sigma_at_the_flatness_threshold_reads_the_same_alone_and_beside_a_copy():
    """With Tensor.std this Σ read a = 0.05000000000000005 alone and 0.049999999999999996 beside a copy of itself,
    either side of ε_a = 0.05, so its flatness signal held in a batch and not alone."""
    sigma = torch.diag(torch.tensor([0.9419052498068875, 0.9806350832689616, 1.019364916731036,
                                     1.05809475019311], dtype=torch.float64)).unsqueeze(0)
    det = SemanticCollapseOperator()
    alone = det._anisotropy_per_sample(sigma)
    assert abs(float(alone[0]) - det.anisotropy_eps) < 1e-15             # it does sit on the threshold
    for b in (2, 3, 8):
        assert torch.equal(det._anisotropy_per_sample(sigma.expand(b, 4, 4).clone()), alone.expand(b))


# ── the kick lies in null(A) (lantern-os-research PR #14, design limit 2) ─────────────────────────

def test_the_kick_lies_in_null_A_for_a_non_normal_A():
    """A = e₁e₂ᵀ: null(A) = span{e₁, e₃, e₄}. The kick basis used to be the three smallest-|λ(A_s)|
    eigenvectors, and one of them, (e₁ ± e₂)/√2, has ‖Av‖ = 1/√2. It is now the right singular vectors
    of A for its small singular values. L2′ and S1 allow any projector, so neither theorem changes."""
    A = torch.zeros(4, 4)
    A[0, 1] = 1.0
    basis = AntiCollapseOperator()._near_null_basis(A.unsqueeze(0))
    assert basis.shape[1] == 3
    assert float(torch.linalg.norm(A @ basis, ord=2)) < 1e-6
    evals, evecs = torch.linalg.eigh(0.5 * (A + A.T))           # the old subspace, for contrast
    old = evecs[:, torch.argsort(evals.abs())[:3]]
    assert float(torch.linalg.norm(A @ old, ord=2)) == pytest.approx(2 ** -0.5, abs=1e-5)


@pytest.mark.parametrize("d,r", [(4, 1), (8, 3), (16, 7), (64, 20)])
def test_each_sample_kick_lies_in_its_own_null_A(d, r):
    """A batch of different non-normal rank-r Jacobians, r < d/2 so the gate can fire: each sample's kick
    projector satisfies A·P = 0 for ITS OWN A, with rank min(d−r, cap), and not for another sample's.
    The covariance leg still lifts Σ when Σ's smallest eigendirections are put on that kick basis."""
    g = torch.Generator().manual_seed(d)
    As = torch.stack([torch.randn(d, r, generator=g, dtype=torch.float64)
                      @ torch.randn(r, d, generator=g, dtype=torch.float64) for _ in range(3)])
    assert all(float(torch.linalg.norm(a @ a.T - a.T @ a)) > 1e-6 for a in As)   # non-normal
    op = AntiCollapseOperator(strength=0.5)
    P, m = op._kick_projector(As)
    assert m.tolist() == [min(d - r, op._max_lift_rank(d))] * 3
    for i, a in enumerate(As):
        assert float(torch.linalg.norm(a @ P[i], ord=2)) < 1e-9 * float(torch.linalg.norm(a, ord=2))
        assert float(torch.linalg.norm(As[(i + 1) % 3] @ P[i], ord=2)) > 1e-3   # not one basis for all
    # the kick and the bump from excite live there too
    xi = torch.randn(3, d, generator=g, dtype=torch.float64)
    det = op.detector
    eps_a = det.anisotropy_eps
    sigmas = []
    for i in range(3):                                          # adversarial: Σ's smallest λ on the kick basis
        V = torch.linalg.eigh(P[i]).eigenvectors.flip(-1)       # kick basis first
        ev = 1.0 + 0.4 * eps_a * torch.linspace(-1.0, 1.0, d, dtype=torch.float64)
        sigmas.append((V * ev) @ V.T)
    sigma = torch.stack(sigmas)
    assert bool((det._anisotropy_per_sample(sigma) < eps_a).all())
    dx, extra = op.excite(torch.zeros(3, d, dtype=torch.float64), sigma, As, 1e-3, xi)
    for i, a in enumerate(As):
        assert float((a @ dx[i]).norm()) < 1e-9 * float(dx[i].norm())
        assert float(torch.linalg.norm(a @ extra[i], ord=2)) < 1e-9 * float(torch.linalg.norm(extra[i], ord=2))
    assert bool((det._anisotropy_per_sample(sigma + extra) >= eps_a).all())


def test_rows_with_different_kick_ranks_each_get_their_own_floor():
    """Ranks 1, 2 and 3 at d = 8 give kick ranks 7, 6 and 5 in one call, and each row's bump is floored
    for its own rank: the same Δ for all of them under-lifts the highest one."""
    d = 8
    g = torch.Generator().manual_seed(4)
    As = torch.stack([torch.randn(d, r, generator=g, dtype=torch.float64)
                      @ torch.randn(r, d, generator=g, dtype=torch.float64) for r in (1, 2, 3)])
    op = AntiCollapseOperator(strength=0.5)
    det = op.detector
    _, m = op._kick_projector(As)
    assert m.tolist() == [7, 6, 5]
    ev = 1.0 + 0.3 * det.anisotropy_eps * torch.linspace(-1.0, 1.0, d, dtype=torch.float64)
    sigma = torch.diag(ev).expand(3, d, d).clone()
    _, extra = op.excite(torch.zeros(3, d, dtype=torch.float64), sigma, As, 1e-3,
                         torch.zeros(3, d, dtype=torch.float64))
    assert bool((det._anisotropy_per_sample(sigma + extra) >= det.anisotropy_eps).all())
    floors = op._cov_floor(sigma, d, m)
    assert floors[0] > floors[1] > floors[2]                     # Δ grows with the kick rank here
    assert torch.allclose(torch.linalg.matrix_norm(extra, ord=2), floors)   # b·P with b = Δ: ‖·‖₂ = Δ


class _TwoRegimes(LinearDynamics):
    """f(x) = A₁x where x₄ ≥ 0 and A₂x where x₄ < 0, so the rows of one batch have different Jacobians."""

    def __init__(self, a1, a2):
        super().__init__(a1, B=torch.zeros(a1.shape[0], 2), noise=0.0)
        self.register_buffer("A2", a2.clone())

    def drift(self, x, u):
        return torch.where(x[..., -1:] >= 0, x @ self.A.T, x @ self.A2.T) + u @ self.B.T


def test_gate_never_true_on_consecutive_steps_for_any_trajectory_of_a_batch():
    """C3 per trajectory, through forward_step, on a batch whose rows have different Jacobians (a
    non-normal rank-1 e₁e₂ᵀ and diag(0, 0, −0.5, 0)) and covariance scales far from and near the cap.
    Their mean Jacobian has rank 2, so the batch-wide gate never fired here at all."""
    d = 4
    a1 = torch.zeros(d, d)
    a1[0, 1] = 1.0
    a2 = torch.diag(torch.tensor([0.0, 0.0, -0.5, 0.0]))
    m = _zero_policy(CIO_SDE(dim=d, ctrl_dim=2, hidden=4))
    m.graph.active = _TwoRegimes(a1, a2)
    m.intervention_policy = InterventionPolicy(**ARMED)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    m.collapse_op = SemanticCollapseOperator()
    g = torch.Generator().manual_seed(12)
    x = 1e-4 * torch.randn(4, d, generator=g)
    x[:, -1] = 1e-4 * torch.tensor([1.0, -1.0, 1.0, -1.0])
    sigma = torch.tensor([1.0, 1.0, 900.0, 900.0]).view(4, 1, 1) * torch.eye(d)
    from src.cio_sde.engine import drift_jacobian
    first = drift_jacobian(m.graph.active, x, torch.zeros(4, 2))
    assert torch.equal(first[0], a1) and torch.equal(first[1], a2)
    assert int(torch.linalg.matrix_rank(first.mean(0))) == 2

    prev = torch.zeros(4, dtype=torch.bool)
    fired = torch.zeros(4, dtype=torch.long)
    for t in range(60):
        x, sigma, info = m.forward_step(x, sigma, 0.05, torch.randn(4, d, generator=g), step=t)
        now = info["sigma0_proximity_per_sample"] > 0.0
        assert not bool((prev & now).any()), f"a trajectory's gate was true twice at step {t}"
        assert info["collapse"] is None
        fired += now.long()
        prev = now
    assert bool((fired >= 1).all()), fired


def test_forward_step_kicks_inside_null_A():
    """Through the engine, with no diffusion: x_next − (x + f·dt) is the kick, and A sends it to 0."""
    d = 4
    A = torch.zeros(d, d, dtype=torch.float64)
    A[0, 1] = 1.0
    m = CIO_SDE(dim=d, ctrl_dim=2, hidden=4).double()
    _zero_policy(m)
    m.graph.active = LinearDynamics(A, B=torch.zeros(d, 2, dtype=torch.float64), noise=0.0).double()
    m.intervention_policy = InterventionPolicy(**ARMED)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    x = 1e-4 * torch.tensor([[1.0, 2.0, -1.0, 0.5]], dtype=torch.float64)
    noise = torch.tensor([[0.7, -1.1, 0.4, 1.3]], dtype=torch.float64)
    x_next, _, info = m.forward_step(x, torch.eye(d, dtype=torch.float64).unsqueeze(0), 0.05, noise, step=0)
    assert info["anti_collapse_p"] > 0.0
    kick = (x_next - (x + 0.05 * x @ A.T)).detach()
    assert float(kick.norm()) > 1e-3
    assert float((kick @ A.T).norm()) < 1e-12


def test_armed_step_refuses_negative_effective_diffusion_from_initial_sigma():
    """A positive g is insufficient if caller-supplied Sigma makes dilation negative."""
    d = 4
    m = _armed_on(LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 2), noise=0.5))
    x = torch.zeros(1, d)
    sigma = -2.0 * torch.eye(d).unsqueeze(0)  # dilation = 1 + tr(Sigma)/d = -1
    with pytest.raises(ValueError, match="non-negative diffusion gain after dilation"):
        m.forward_step(x, sigma, 0.05, torch.randn_like(x), step=0)


def test_zero_strength_state_leg_does_not_require_psd_effective_diffusion():
    """The covariance shape-lift remains active, but the S1 state kick is disabled."""
    d = 4
    m = _armed_on(LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 2), noise=0.5))
    m.anti_collapse_op = AntiCollapseOperator(strength=0.0)
    x = torch.zeros(1, d)
    sigma = -2.0 * torch.eye(d).unsqueeze(0)
    x_next, sigma_next, info = m.forward_step(x, sigma, 0.05, torch.randn_like(x), step=0)
    assert bool(torch.isfinite(x_next).all())
    assert bool(torch.isfinite(sigma_next).all())
    assert info["anti_collapse_p"] > 0.0


# ── switched stability and retained-excitation verification ─────────────────────────────

def test_common_quadratic_verifier_checks_every_mode():
    from src.cio_sde.stability import verify_common_quadratic
    dtype = torch.float64
    H = torch.eye(2, dtype=dtype)
    F1 = 0.8 * torch.eye(2, dtype=dtype)
    F2 = torch.tensor([[0.0, -0.6], [0.6, 0.0]], dtype=dtype)
    result = verify_common_quadratic([F1, F2], H, rho=0.81)
    assert result["valid"]
    assert result["minimum_lyapunov_margin"] > 0.0
    N1 = torch.tensor([[0.0, 2.0], [0.0, 0.0]], dtype=dtype)
    N2 = torch.tensor([[0.0, 0.0], [2.0, 0.0]], dtype=dtype)
    failed = verify_common_quadratic([N1, N2], H, rho=0.99)
    assert not failed["valid"]
    assert torch.linalg.matrix_norm(N2 @ N1, ord=2).item() == pytest.approx(4.0)


def test_finite_horizon_gramian_proves_cyclic_kicks_are_retained():
    from src.cio_sde.stability import finite_horizon_excitation_gramian
    dtype = torch.float64
    F = 0.8 * torch.eye(2, dtype=dtype)
    e1 = torch.tensor([[1.0], [0.0]], dtype=dtype)
    e2 = torch.tensor([[0.0], [1.0]], dtype=dtype)
    W = finite_horizon_excitation_gramian([F, F], [0.1 * e1, 0.1 * e2])
    assert torch.allclose(W, torch.diag(torch.tensor([0.0064, 0.01], dtype=dtype)))
    assert torch.linalg.eigvalsh(W).min().item() >= 0.0064 - 1e-12


def test_finite_horizon_gramian_detects_erased_kick():
    from src.cio_sde.stability import finite_horizon_excitation_gramian
    dtype = torch.float64
    erase_first = torch.tensor([[0.0, 0.0], [0.0, 1.0]], dtype=dtype)
    M = torch.tensor([[0.1], [0.0]], dtype=dtype)
    zero = torch.zeros((2, 1), dtype=dtype)
    W = finite_horizon_excitation_gramian([torch.eye(2, dtype=dtype), erase_first], [M, zero])
    assert torch.allclose(W, torch.zeros((2, 2), dtype=dtype))


def test_augmented_jacobian_includes_covariance_feedback():
    from src.cio_sde.stability import augmented_transition_jacobian
    z = torch.tensor([2.0, 0.4], dtype=torch.float64)
    def transition(state):
        x, p = state.unbind()
        return torch.stack((x + p, 0.5 * p))
    J = augmented_transition_jacobian(transition, z)
    expected = torch.tensor([[1.0, 1.0], [0.0, 0.5]], dtype=torch.float64)
    assert torch.allclose(J, expected)


def test_common_quadratic_covariance_energy_bound():
    from src.cio_sde.stability import covariance_energy_bound
    dtype = torch.float64
    P0 = torch.eye(2, dtype=dtype)
    H = torch.eye(2, dtype=dtype)
    bound = covariance_energy_bound(P0, H, rho=0.8, q=0.02, steps=10)
    expected = 0.8 ** 20 * 2.0 + 0.02 * (1.0 - 0.8 ** 20) / (1.0 - 0.8 ** 2)
    assert bound == pytest.approx(expected)


def test_switched_mode_diagnostics_reports_certificate_and_gramian():
    from src.cio_sde.diagnostics import analyze_switched_modes
    dtype = torch.float64
    F = 0.8 * torch.eye(2, dtype=dtype)
    M1 = torch.tensor([[0.1], [0.0]], dtype=dtype)
    M2 = torch.tensor([[0.0], [0.1]], dtype=dtype)
    report = analyze_switched_modes(
        [F, F], torch.eye(2, dtype=dtype), rho=0.81, noise_maps=[M1, M2]
    )
    assert report["stability_certificate"]["valid"]
    assert report["excitation_positive_definite"]
    assert report["excitation_min_eigenvalue"] == pytest.approx(0.0064)


# ── a trajectory that is not finite (independent review of #3814) ────────────────────────────────

class _Kinked(LinearDynamics):
    """f(x) = c·b(x₄)·e₁ with b = ∛x₄ ("inf") or √(x₄²) ("nan"). The drift is finite on x₄ ≥ 0, but at x₄ = 0
    the derivative is +inf, or (1/0)·0 = NaN. vmap takes each sample's derivative on its own, so a trajectory
    sitting exactly on x₄ = 0 has a non-finite Jacobian while every other one's is finite."""

    def __init__(self, kind, c=1e-3, d=4):
        super().__init__(torch.zeros(d, d, dtype=torch.float64), B=torch.zeros(d, 2, dtype=torch.float64),
                         noise=0.002)
        self.kind, self.c = kind, c

    def drift(self, x, u):
        x4 = x[..., 3:]
        bend = x4.pow(1.0 / 3.0) if self.kind == "inf" else torch.sqrt(x4 * x4)
        return x @ self.A.T + u @ self.B.T + self.c * torch.nn.functional.pad(bend, (0, x.shape[-1] - 1))


@pytest.mark.parametrize("kind", ["inf", "nan"])
def test_a_trajectory_with_a_non_finite_jacobian_fails_no_other(kind):
    """Row 0 is collapsed, row 1 sits on the kink, row 2 is far from target. One batched decomposition used to
    fail all three: the covariance step's eigh raised first, and behind it the gate's SVDs raised on a NaN, and
    read an inf's NaN singular values as rank 0, i.e. collapsed. Now row 1 is never acted on, and each row of the
    batch, row 1 included, is the step it gets alone, bit for bit."""
    from src.cio_sde.engine import drift_jacobian
    m = CIO_SDE(dim=4, ctrl_dim=2, hidden=4).double()
    _zero_policy(m)
    m.graph.active = _Kinked(kind).double()
    m.intervention_policy = InterventionPolicy(**ARMED)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    m.collapse_op = SemanticCollapseOperator()
    x = torch.tensor([[1e-4, -1e-4, 5e-5, 1e-4], [1e-4, 1e-4, -5e-5, 0.0], [0.5, 0.5, 0.5, 0.5]],
                     dtype=torch.float64)
    sigma = torch.eye(4, dtype=torch.float64).expand(3, 4, 4).clone()
    noise = torch.tensor([[0.3, -1.2, 0.8, 0.5], [1.0, 0.4, -0.7, 0.2], [-0.4, 0.9, 0.1, -1.5]],
                         dtype=torch.float64)
    A = drift_jacobian(m.graph.active, x, torch.zeros(3, 2, dtype=torch.float64))
    broken = torch.isinf(A) if kind == "inf" else torch.isnan(A)
    assert broken.flatten(1).any(-1).tolist() == [False, True, False]
    assert torch.isfinite(A).flatten(1).all(-1).tolist() == [True, False, True]

    x_next, sigma_next, info = m.forward_step(x, sigma, 0.05, noise, step=0)
    assert [(r.sample, r.kind) for r in info["intervention_receipts"]] == [(0, "excite")]
    assert info["sigma0_proximity_per_sample"][1] == 0.0
    signals = m.anti_collapse_op.detector._signals(m, x, info["u"], sigma, A)
    assert all(math.isnan(float(v[1])) for v in signals.values())     # none reads below its threshold
    assert not bool(torch.isfinite(sigma_next[1]).all())               # its Σ is passed on, not made up
    for i in range(3):
        m.reset_intervention_count()
        xi, si, alone = m.forward_step(x[i:i + 1], sigma[i:i + 1], 0.05, noise[i:i + 1], step=0)
        torch.testing.assert_close(xi[0], x_next[i], rtol=0, atol=0, equal_nan=True)
        torch.testing.assert_close(si[0], sigma_next[i], rtol=0, atol=0, equal_nan=True)
        assert [r.kind for r in alone["intervention_receipts"]] == (["excite"] if i == 0 else [])


_HADAMARD = torch.tensor([[1.0, 1, 1, 1], [1, -1, 1, -1], [1, 1, -1, -1], [1, -1, -1, 1]])


@pytest.mark.parametrize("broken", ["jacobian inf", "jacobian nan", "jacobian overflow", "covariance nan"])
def test_a_row_that_is_not_finite_reads_nan_and_never_fires(broken):
    """The trap: _numerical_rank counts NaN or inf singular values as rank 0. The SVD of an inf Jacobian returns
    NaN singular values without raising, so that row read as collapsed and, with its other signals at rest,
    fired. So did a FINITE full-rank Jacobian, 0.6·max·H₄ in float32, whose singular values overflow to inf. A
    NaN Jacobian made the SVD raise for the whole batch, and an all-NaN Σ made the gate's eigvalsh raise. Now
    every signal of such a row is NaN, it never fires, and the other rows are decided as they are alone."""
    d = 4
    m = _armed_on(LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 2), noise=0.0))
    det, op = m.anti_collapse_op.detector, m.anti_collapse_op
    A = torch.zeros(3, d, d)
    A[0, 0, 0] = 1.0                          # rank 1: collapsed
    A[1, 0, 0] = 1.0                          # row 1 is broken below, with every other signal of it at rest
    A[2] = torch.eye(d)                       # full rank: healthy
    x, u = torch.full((3, d), 1e-4), torch.zeros(3, 2)   # every row near target
    sigma = torch.eye(d).expand(3, d, d).clone()
    if broken == "jacobian overflow":
        A[1] = 0.6 * torch.finfo(torch.float32).max * _HADAMARD
        assert bool(torch.isfinite(A[1]).all()) and not bool(torch.isfinite(torch.linalg.svdvals(A[1])).all())
    elif broken == "covariance nan":
        sigma[1] = float("nan")
    else:
        A[1, 0, 0] = float(broken.split()[1])
    res = det.evaluate(m, x, u, sigma, A)
    assert res.mask.tolist() == [True, False, False]
    for name in ("grad_norm", "eff_rank", "anisotropy", "ctrl_sens"):
        assert math.isnan(float(res.metrics[name][1])), name
    assert res.metrics["eff_rank"][0] == 1.0 and res.metrics["eff_rank"][2] == d
    assert torch.equal(res.x_star[1], x[1])
    p = op.proximity(m, x, u, sigma, A)
    assert float(p[0]) > 0.0 and p[1:].tolist() == [0.0, 0.0]
    for i in (0, 2):
        alone = det.evaluate(m, x[i:i + 1], u[i:i + 1], sigma[i:i + 1], A[i:i + 1])
        assert alone.mask.tolist() == [bool(res.mask[i])] and torch.equal(alone.x_star[0], res.x_star[i])
        assert torch.equal(op.proximity(m, x[i:i + 1], u[i:i + 1], sigma[i:i + 1], A[i:i + 1])[0], p[i])


@pytest.mark.parametrize("bad", [float("inf"), float("nan")])
def test_an_operator_asked_to_act_on_a_non_finite_row_refuses_and_names_it(bad):
    """Asked directly to project or excite a broken row, the operators refuse with an error naming that row,
    instead of LAPACK's error for the whole batch (NaN) or a kick basis built from NaN singular values (inf).
    Outside the mask a broken row is not decomposed, so it fails nothing."""
    d = 4
    A = torch.zeros(2, d, d)
    A[:, 0, 0] = 1.0
    A[1, 0, 1] = bad
    det, op = SemanticCollapseOperator(), AntiCollapseOperator(strength=0.5)
    x, sigma = torch.zeros(2, d), torch.eye(d).expand(2, d, d).clone()
    with pytest.raises(ValueError, match="sample 1: the Jacobian holds a NaN or inf"):
        det._collapse_state(x, A)
    with pytest.raises(ValueError, match="sample 1: the Jacobian holds a NaN or inf"):
        op.excite(x, sigma, A, 0.5, torch.ones(2, d))
    x_star, _ = det._collapse_state(x + 1.0, A, mask=torch.tensor([True, False]))
    assert torch.allclose(x_star[0], torch.tensor([0.0, 1.0, 1.0, 1.0]), atol=1e-6)   # onto null(e₁e₁ᵀ)
    assert torch.equal(x_star[1], x[1] + 1.0)                                         # untouched
    sick = sigma.clone()
    sick[1, 2, 2] = bad
    with pytest.raises(ValueError, match="sample 1: the covariance holds a NaN or inf"):
        op.excite(x, sick, A[:1].expand(2, d, d), 0.5, torch.ones(2, d))
    huge = A.clone()
    huge[1] = 0.6 * torch.finfo(torch.float32).max * _HADAMARD     # finite, but its singular values overflow
    with pytest.raises(ValueError, match="sample 1: the Jacobian's singular values overflow"):
        op.excite(x, sigma, huge, 0.5, torch.ones(2, d))


def test_the_covariance_projections_pass_a_non_finite_sample_through():
    """Both projections decomposed every Σ of the batch at once, so one Σ holding an inf came back as NaN or
    raised, and could take the others with it. A finite Σ is now projected as it is alone, and one that is not
    finite comes back unprojected: there is nothing to project it onto."""
    cov = CovarianceField(4)
    good = torch.diag(torch.tensor([2000.0, 1.0, 1e-9, 3.0], dtype=torch.float64))   # clipped to [eps, σ_max]
    batch = torch.stack([good, good.clone()])
    batch[1, 0, 1] = batch[1, 1, 0] = float("inf")
    for project in (cov._project_psd, cov.project_preserving_shape):
        out = project(batch)
        assert torch.equal(out[0], project(good.unsqueeze(0))[0]), project.__name__
        torch.testing.assert_close(out[1], batch[1], rtol=0, atol=0, equal_nan=True)


class _LoudRow(LinearDynamics):
    """Diffusion gain 1e20 on rows with x₄ < 0 and 0.002 elsewhere. In float32 g² overflows, so such a row's
    covariance step returns inf from finite inputs, and the gate, which reads the inputs, still fires on it."""

    def diffusion(self, x):
        loud = x[..., 3:] < 0
        return torch.where(loud, torch.full_like(x[..., 3:], 1e20), torch.full_like(x[..., 3:], 0.002)).expand_as(x)


def test_a_row_whose_covariance_step_overflows_is_not_excited_and_fails_no_other():
    """Both rows are collapsed and finite, so the gate fires on both; row 1's covariance step overflows. The
    kick's floor then refused, or LAPACK raised, for the whole batch, and named row 1 by its place among the
    fired rows. Row 1 is now blocked, with a receipt saying why, after the gain guard checked it; row 0 is kicked."""
    d = 4
    m = _armed_on(_LoudRow(torch.diag(torch.tensor([-0.5, 0.0, 0.0, 0.0])), B=torch.zeros(d, 2), noise=0.0))
    x = 1e-4 * torch.tensor([[1.0, -1.0, 0.5, 1.0], [1.0, 1.0, -0.5, -1.0]])
    sigma = torch.eye(d).expand(2, d, d).clone()
    plain_x, plain_sigma, _ = _plain_step(m, x, sigma, torch.zeros(2, d))
    assert bool(torch.isfinite(plain_sigma[0]).all()) and not bool(torch.isfinite(plain_sigma[1]).all())
    x_next, _, info = m.forward_step(x, sigma, 0.05, torch.zeros(2, d), step=0)
    receipts = info["intervention_receipts"]
    assert [(r.sample, r.kind) for r in receipts] == [(0, "excite"), (1, "blocked")]
    assert "not finite after the step" in receipts[1].policy_reason
    assert torch.equal(x_next[1], plain_x[1])                  # row 1 is the plain step, not kicked
    assert m._intervention_counts.tolist() == [1, 0]           # and it spent nothing


def test_a_spook_on_a_row_that_is_not_finite_does_not_excite_it():
    """At d = 1 a row that has gone to +inf has an infinite innovation, NIS = inf spooks, and the anti-collapse
    trigger kicked that row and spent its budget; from a gain computed on the broken state, the gain guard
    raised for the batch instead. A row that is not finite is now never selected, by a spook or otherwise."""
    from src.cio_sde import SurpriseMonitor
    d = 1
    m = CIO_SDE(dim=d, ctrl_dim=1, hidden=4)
    _zero_policy(m)
    m.graph.active = LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 1), noise=0.0)
    m.intervention_policy = InterventionPolicy(**ARMED)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    m.surprise_monitor = SurpriseMonitor(anti_collapse_trigger=True)
    x = torch.tensor([[0.5], [float("inf")]])                  # row 0 far from target, row 1 broken
    sigma = torch.eye(d).expand(2, d, d).clone()
    m._surprise_pred_mean, m._surprise_pred_cov = torch.zeros(2, d), sigma.clone()
    _, _, info = m.forward_step(x, sigma, 0.05, torch.zeros(2, d), step=0)
    assert info["surprise_spook"] is True                      # the monitor did spook, on row 1
    assert info["intervention_receipts"] == [] and not bool(info["anti_collapse_fired"].any())


def test_a_batch_wide_operator_cannot_select_a_row_that_is_not_finite():
    """A batch-wide proximity names every row, including one whose Σ is NaN, so its dilation and gain are NaN,
    and the gain guard raised for the batch. That row is now left alone, and the other one is kicked."""
    d = 4
    m = _armed_on(LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 2), noise=0.0))
    m.anti_collapse_op = _BatchWide(0.25)
    x = torch.zeros(2, d)
    sigma = torch.eye(d).expand(2, d, d).clone()
    sigma[1] = float("nan")
    plain_x, _, _ = _plain_step(m, x, sigma, torch.zeros(2, d))
    x_next, _, info = m.forward_step(x, sigma, 0.05, torch.zeros(2, d), step=0)
    assert [(r.sample, r.kind) for r in info["intervention_receipts"]] == [(0, "excite")]
    assert torch.allclose((x_next[0] - plain_x[0]).detach(), torch.full((d,), 0.25))
    torch.testing.assert_close(x_next[1], plain_x[1], rtol=0, atol=0, equal_nan=True)


# ── the post-merge review of #3814 ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("shape", ["(1,d,d)", "(d,d)"])
def test_a_covariance_shared_by_the_batch_gives_each_row_its_receipt(shape):
    """_signals reads a Σ given once for the batch as every row's, but the receipts indexed Σ by row, so any
    receipt for a row past the first raised IndexError. Only a rollout's first step can see such a Σ, since
    the covariance step returns one per row."""
    d = 4
    m = CIO_SDE(dim=d, ctrl_dim=2, hidden=4).double()
    _zero_policy(m)
    m.graph.active = LinearDynamics(torch.diag(torch.tensor([-0.5, 0.0, 0.0, 0.0], dtype=torch.float64)),
                                    B=torch.zeros(d, 2, dtype=torch.float64), noise=0.0).double()
    m.intervention_policy = InterventionPolicy(observe_only=False, max_interventions=10)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    x = 1e-4 * torch.tensor([[1.0, -1.0, 0.5, 2.0], [2.0, 1.0, -0.5, 1.0]], dtype=torch.float64)
    eye = torch.eye(d, dtype=torch.float64)
    sigma = eye.unsqueeze(0) if shape == "(1,d,d)" else eye
    x_next, sigma_next, info = m.forward_step(x, sigma, 0.05, torch.zeros_like(x), step=0)
    receipts = info["intervention_receipts"]
    assert [(r.sample, r.kind) for r in receipts] == [(0, "excite"), (1, "excite")]
    assert all(r.pre_sigma_tr == pytest.approx(d) for r in receipts)
    m.reset_intervention_count()                       # the same step with Σ given per row
    x_rows, sigma_rows, info_rows = m.forward_step(x, eye.expand(2, d, d).clone(), 0.05,
                                                   torch.zeros_like(x), step=0)
    assert torch.allclose(x_next, x_rows, rtol=0, atol=1e-15)
    assert torch.allclose(sigma_next, sigma_rows, rtol=0, atol=1e-12)
    assert [r.to_dict() for r in receipts] == [r.to_dict() for r in info_rows["intervention_receipts"]]


def test_the_neural_node_matches_its_lone_runs_to_rounding():
    """A regression pin, not a gap. The operators' reductions read a row the same alone as in a batch, but the
    neural node's matrix products round a row differently in a batch, about 1e-15 in float64, so its batch run
    agrees with its rows run alone only to rounding. This pins that agreement for the default node with both operators armed.
    It does not ask the rows to differ: whether they do depends on the library."""
    torch.manual_seed(0)
    m = CIO_SDE(dim=4, ctrl_dim=2, hidden=64).double()
    m.graph.active.double()                            # the graph node is not a registered submodule
    m.intervention_policy = InterventionPolicy(**ARMED)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    m.collapse_op = SemanticCollapseOperator()
    g = torch.Generator().manual_seed(1)
    x0 = torch.randn(8, 4, generator=g, dtype=torch.float64)
    s0 = torch.eye(4, dtype=torch.float64).expand(8, 4, 4).clone()
    noise = torch.randn(30, 8, 4, generator=g, dtype=torch.float64)

    def run(rows):
        m.reset_intervention_count()
        x, s = x0[rows], s0[rows]
        for t in range(30):
            x, s, _ = m.forward_step(x, s, 0.05, noise[t, rows], step=t)
        return x.detach(), s.detach()

    xb, sb = run(list(range(8)))
    for i in range(8):
        xi, si = run([i])
        torch.testing.assert_close(xi[0], xb[i], rtol=0, atol=1e-12)
        torch.testing.assert_close(si[0], sb[i], rtol=0, atol=1e-12)
