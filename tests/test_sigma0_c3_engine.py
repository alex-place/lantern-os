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
    # The engine's actual diffusion gain is g*dilation, with dilation=1001 here.
    gain = torch.tensor([0.0, 1000.0 / 1001.0, 1000.0 / 1001.0,
                         1000.0 / 1001.0], dtype=torch.float64)
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
    single = (det._grad_norm(m, x, u), det._ctrl_sensitivity(m, x, u))
    many = (det._grad_norm(m, x.repeat(8, 1), u.repeat(8, 1)),
            det._ctrl_sensitivity(m, x.repeat(8, 1), u.repeat(8, 1)))
    assert many == pytest.approx(single, rel=1e-5)


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
    assert det._ctrl_sensitivity(m, x, u) == pytest.approx(5.0, rel=1e-5)   # ‖Bᵀ·2x‖

    m.graph.active = LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, d), noise=0.0)
    assert det._ctrl_sensitivity(m, x, u) == pytest.approx(0.0, abs=1e-8)   # no leverage


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


def test_a_negative_gain_is_only_refused_when_the_kick_would_use_it():
    """Away from the gate the sign does nothing: the noise is symmetric and nothing shares it."""
    d = 4
    m = _armed_on(_NegativeGain(-torch.eye(d), B=torch.zeros(d, 2), noise=0.0))
    _, _, info = m.forward_step(torch.ones(1, d), torch.eye(d).unsqueeze(0), 0.05, torch.randn(1, d), step=0)
    assert info["anti_collapse_p"] == 0.0


# ── two documented limits, pinned so that lifting them is a decision ────────────────────────────

def test_legacy_scalar_evaluate_remains_batch_aggregate_for_compatibility():
    """Each member alone triggers. Together they do not, because the mean of two rank-1 Jacobians has
    rank 2. A per-trajectory gate would change this, and this test should change with it."""
    d = 4
    e = torch.eye(d)
    a1, a2 = torch.outer(e[0], e[0]), torch.outer(e[1], e[1])
    m = _armed_on(LinearDynamics(torch.zeros(d, d), B=torch.zeros(d, 2), noise=0.0))
    gate = SemanticCollapseOperator()

    def fires(As):
        n = As.shape[0]
        return gate.evaluate(m, torch.zeros(n, d), torch.zeros(n, 2),
                             torch.eye(d).expand(n, d, d).clone(), As).triggered

    assert fires(a1.unsqueeze(0)) and fires(a2.unsqueeze(0))
    assert not fires(torch.stack([a1, a2]))


def test_legacy_near_null_basis_helper_still_uses_the_symmetric_part():
    """Compatibility helper only: the runtime excite() path now uses the per-sample right-kernel SVD.
    This old helper still reports the historical A_s basis for callers that use it directly."""
    A = torch.zeros(4, 4)
    A[0, 1] = 1.0
    basis = AntiCollapseOperator()._near_null_basis(A.unsqueeze(0))
    assert basis.shape[1] == 3
    assert float(torch.linalg.norm(A @ basis, ord=2)) == pytest.approx(2 ** -0.5, abs=1e-5)



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


# ── per-sample decisions and true right-kernel projectors ─────────────────────────────────

def test_per_sample_proximity_does_not_hide_one_collapsed_member():
    op = AntiCollapseOperator()
    d = 4
    A = torch.stack((
        torch.eye(d),
        torch.diag(torch.tensor([1.0, 0.0, 0.0, 0.0])),
    ))
    x = torch.zeros(2, d)
    u = torch.zeros(2, 2)
    sigma = torch.eye(d).expand(2, d, d).clone()
    model = _zero_policy(CIO_SDE(dim=d, ctrl_dim=2, hidden=4))
    proximity = op.proximity_per_sample(model, x, u, sigma, A)
    assert proximity.shape == (2,)
    assert proximity[0].item() == pytest.approx(0.0)
    assert proximity[1].item() > 0.0
    assert op.proximity(model, x, u, sigma, A) == pytest.approx(float(proximity.max()))


def test_per_sample_projectors_follow_each_members_actual_right_kernel():
    op = AntiCollapseOperator()
    d = 4
    A = torch.stack((
        torch.diag(torch.tensor([1.0, 0.0, 0.0, 0.0])),
        torch.diag(torch.tensor([0.0, 1.0, 0.0, 0.0])),
    ))
    projectors, ranks = op._near_null_projector_per_sample(A, batch_size=2)
    assert ranks.tolist() == [3, 3]
    assert torch.linalg.norm(A @ projectors) < 1e-5
    assert not torch.allclose(projectors[0], projectors[1])
    assert torch.allclose(projectors, projectors.transpose(-1, -2), atol=1e-6)
    assert torch.allclose(projectors @ projectors, projectors, atol=1e-5)


def test_nonnormal_right_kernel_projector_is_in_actual_kernel():
    op = AntiCollapseOperator()
    A = torch.zeros(1, 4, 4)
    A[0, 0, 1] = 1.0
    projectors, ranks = op._near_null_projector_per_sample(A, batch_size=1)
    assert ranks.item() == 3
    assert torch.linalg.norm(A @ projectors) < 1e-6


def test_excite_only_kicks_and_lifts_the_samples_that_trigger():
    op = AntiCollapseOperator(strength=0.5)
    d = 4
    A = torch.stack((
        torch.eye(d),
        torch.diag(torch.tensor([1.0, 0.0, 0.0, 0.0])),
    ))
    x = torch.zeros(2, d)
    sigma = torch.eye(d).expand(2, d, d).clone()
    noise = torch.ones(2, d)
    p = torch.tensor([0.0, 0.5])
    dx, dsigma = op.excite(x, sigma, A, p, noise)
    assert torch.allclose(dx[0], torch.zeros(d))
    assert torch.allclose(dsigma[0], torch.zeros(d, d))
    assert torch.linalg.norm(dx[1]) > 0.0
    assert torch.linalg.norm(dsigma[1]) > 0.0


class _BatchConditionalDynamics(Dynamics):
    """Different local Jacobians for members of the same batch."""

    def __init__(self, dim=4):
        super().__init__(dim, ctrl_dim=2, hidden=4)

    def drift(self, x, u):
        eye = torch.eye(self.dim, device=x.device, dtype=x.dtype).expand(x.shape[0], -1, -1)
        collapsed = torch.diag(torch.tensor([1.0, 0.0, 0.0, 0.0],
                                            device=x.device, dtype=x.dtype))
        A = torch.where((x[:, :1] > 0).unsqueeze(-1), eye,
                        collapsed.expand(x.shape[0], -1, -1))
        return torch.bmm(A, x.unsqueeze(-1)).squeeze(-1)

    def diffusion(self, x):
        return torch.zeros_like(x)


def test_forward_step_applies_anti_collapse_per_sample_not_to_healthy_members():
    m = _zero_policy(CIO_SDE(dim=4, ctrl_dim=2, hidden=4))
    m.graph.active = _BatchConditionalDynamics()
    m.intervention_policy = InterventionPolicy(**ARMED)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    x = torch.tensor([[1e-3, 0.0, 0.0, 0.0],
                      [-1e-3, 0.0, 0.0, 0.0]])
    sigma = torch.eye(4).expand(2, 4, 4).clone()
    noise = torch.ones_like(x)
    x_next, sigma_next, info = m.forward_step(x, sigma, 0.05, noise, step=0)
    assert info["sigma0_proximity"] > 0.0
    assert torch.allclose(sigma_next[0], torch.eye(4) * 1.05, atol=1e-5)
    assert torch.allclose(x_next[0], x[0] + 0.05 * x[0], atol=1e-5)
    assert torch.linalg.norm(sigma_next[1] - torch.eye(4)) > 0.0
    assert torch.linalg.norm(x_next[1] - (x[1] + 0.05 * x[1])) > 0.0


class _LegacyScalarProximityOverride(AntiCollapseOperator):
    def proximity(self, model, x, u, sigma, A):
        return 0.5


def test_legacy_scalar_proximity_override_keeps_scalar_excite_contract():
    m = _zero_policy(CIO_SDE(dim=4, ctrl_dim=2, hidden=4))
    m.graph.active = LinearDynamics(
        torch.zeros(4, 4), B=torch.zeros(4, 2), noise=0.0
    )
    m.intervention_policy = InterventionPolicy(**ARMED)
    m.anti_collapse_op = _LegacyScalarProximityOverride(strength=0.5)
    x = torch.zeros(2, 4)
    sigma = torch.eye(4).expand(2, 4, 4).clone()
    x_next, _, info = m.forward_step(x, sigma, 0.05, torch.ones_like(x), step=0)
    assert info["sigma0_proximity"] == pytest.approx(0.5)
    assert info["anti_collapse_p"] == pytest.approx(0.5)
    assert torch.linalg.norm(x_next - x) > 0.0


# Engine-level regression: a collapsed member must not freeze healthy batch peers.
def test_engine_freeze_projects_only_the_collapsed_member():
    m = _zero_policy(CIO_SDE(dim=4, ctrl_dim=2, hidden=4))
    m.graph.active = _BatchConditionalDynamics()
    m.collapse_op = SemanticCollapseOperator()
    m.intervention_policy = InterventionPolicy(**ARMED)
    x = torch.tensor([[1e-3, 0.0, 0.0, 0.0],
                      [-1e-3, 0.0, 0.0, 0.0]])
    sigma = torch.eye(4).expand(2, 4, 4).clone()
    x_next, sigma_next, info = m.forward_step(x, sigma, 0.05, torch.zeros_like(x), step=0)
    result = info["collapse"]
    assert result is not None and result.triggered
    assert result.triggered_mask.tolist() == [False, True]
    # Healthy member follows the ordinary step; collapsed member projects to its own null(A).
    assert torch.allclose(x_next[0], x[0] + 0.05 * x[0], atol=1e-6)
    assert torch.allclose(x_next[1], torch.zeros(4), atol=1e-6)
    # Only the frozen member reverts its covariance to the pre-step Sigma.
    assert torch.allclose(sigma_next[1], sigma[1], atol=1e-6)
    assert not torch.allclose(sigma_next[0], sigma[0])


def test_semantic_evaluate_legacy_batch_summary_remains_available():
    op = SemanticCollapseOperator()
    model = _zero_policy(CIO_SDE(dim=4, ctrl_dim=2, hidden=4))
    A = torch.stack((torch.eye(4), torch.diag(torch.tensor([1.0, 0.0, 0.0, 0.0]))))
    x = torch.zeros(2, 4)
    u = torch.zeros(2, 2)
    sigma = torch.eye(4).expand(2, 4, 4).clone()
    legacy = op.evaluate(model, x, u, sigma, A)
    per_sample = op.evaluate_per_sample(model, x, u, sigma, A)
    assert legacy.triggered is False
    assert per_sample.triggered is True
    assert per_sample.triggered_mask.tolist() == [False, True]


def test_riccati_process_noise_matches_the_state_diffusion_map():
    """With A=0 and Sigma=0, one Euler step must add (g*dilation)^2*dt."""
    dim = 3
    m = CIO_SDE(dim=dim, ctrl_dim=2, hidden=4)
    m.graph.active = LinearDynamics(
        torch.zeros(dim, dim),
        B=torch.zeros(dim, 2),
        noise=2.0,
    )
    _zero_policy(m)
    x = torch.zeros(1, dim)
    sigma = torch.zeros(1, dim, dim)
    dt = 0.2
    _, sigma_next, _ = m.forward_step(
        x, sigma, dt, torch.ones_like(x), step=0
    )
    expected = (2.0 ** 2) * dt
    assert torch.allclose(
        sigma_next,
        torch.eye(dim).unsqueeze(0) * expected,
        atol=1e-6,
    )


def test_covariance_step_includes_shared_noise_cross_terms():
    cov = CovarianceField(2)
    sigma = torch.zeros(1, 2, 2, dtype=torch.float64)
    A = torch.zeros(1, 2, 2, dtype=torch.float64)
    q_diag = torch.zeros(1, 2, dtype=torch.float64)
    # Base diffusion and kick are perfectly correlated: M = diag(1,0)+diag(1,0).
    # Covariance is (2ξ)^2=4, not 1+1=2.
    noise_map = torch.diag(torch.tensor([2.0, 0.0], dtype=torch.float64)).unsqueeze(0)
    out = cov.step(sigma, A, q_diag, dt=0.25, noise_map=noise_map)
    expected = torch.diag(torch.tensor([4.0, cov.eps], dtype=torch.float64)).unsqueeze(0)
    assert torch.allclose(out, expected, atol=1e-10)


def test_excitation_noise_map_matches_the_state_kick_map():
    op = AntiCollapseOperator(strength=0.5)
    d = 4
    A = torch.stack((
        torch.diag(torch.tensor([1.0, 0.0, 0.0, 0.0])),
        torch.diag(torch.tensor([0.0, 1.0, 0.0, 0.0])),
    ))
    p = torch.tensor([0.0, 0.5])
    M = op.excitation_noise_map(A, p, 2, torch.device("cpu"), torch.float32)
    noise = torch.tensor([[1.0, 2.0, 3.0, 4.0],
                          [4.0, 3.0, 2.0, 1.0]])
    dx, _ = op.excite(torch.zeros_like(noise),
                      torch.eye(d).expand(2, d, d).clone(), A, p, noise)
    expected = torch.bmm(M, noise.unsqueeze(-1)).squeeze(-1)
    assert torch.allclose(dx, expected, atol=1e-6)


def test_riccati_process_noise_scales_with_covariance_dilation():
    dim = 3
    m = CIO_SDE(dim=dim, ctrl_dim=2, hidden=4)
    m.graph.active = LinearDynamics(
        torch.zeros(dim, dim),
        B=torch.zeros(dim, 2),
        noise=2.0,
    )
    _zero_policy(m)
    sigma = 3.0 * torch.eye(dim).unsqueeze(0)
    x = torch.zeros(1, dim)
    dt = 0.2
    _, sigma_next, info = m.forward_step(
        x, sigma, dt, torch.zeros_like(x), step=0
    )
    # dilation = 1 + tr(Sigma)/d = 4; Q = (2*4)^2 I.
    # Riccati term is -Sigma^2, so Sigma+ = 3I + (-9I + 64I)*0.2 = 14I.
    assert torch.allclose(info["dilation"], torch.tensor([4.0]), atol=1e-6)
    assert torch.allclose(sigma_next, 14.0 * torch.eye(dim).unsqueeze(0), atol=1e-5)


class _CorrelatedKickOnly(AntiCollapseOperator):
    """Test operator with an explicit kick map and no artificial shape bump."""

    def proximity(self, model, x, u, sigma, A):
        return 0.5

    def excitation_noise_map(self, A, p, batch_size, device, dtype):
        return torch.diag(torch.tensor([1.0, 0.0], device=device, dtype=dtype)).expand(
            batch_size, -1, -1
        )

    def excite(self, x, sigma, A, p, noise):
        M = self.excitation_noise_map(A, p, x.shape[0], x.device, x.dtype)
        dx = torch.bmm(M, noise.unsqueeze(-1)).squeeze(-1)
        return dx, torch.zeros_like(sigma)


def test_engine_covariance_includes_the_actual_intervention_noise_map():
    dim = 2
    m = _zero_policy(CIO_SDE(dim=dim, ctrl_dim=2, hidden=4))
    m.graph.active = LinearDynamics(
        torch.zeros(dim, dim),
        B=torch.zeros(dim, 2),
        noise=0.0,
    )
    m.intervention_policy = InterventionPolicy(**ARMED)
    m.anti_collapse_op = _CorrelatedKickOnly(strength=0.0)
    x = torch.zeros(1, dim)
    sigma = torch.zeros(1, dim, dim)
    x_next, sigma_next, info = m.forward_step(
        x, sigma, 0.25, torch.ones_like(x), step=0
    )
    assert info["anti_collapse_p"] == pytest.approx(0.5)
    assert torch.allclose(x_next, torch.tensor([[1.0, 0.0]]), atol=1e-6)
    # The same xi drives the unit kick in e1, so predicted covariance gains e1e1^T.
    assert sigma_next[0, 0, 0].item() == pytest.approx(1.0, abs=1e-5)
    assert sigma_next[0, 1, 1].item() == pytest.approx(m.cov.eps, abs=1e-6)
