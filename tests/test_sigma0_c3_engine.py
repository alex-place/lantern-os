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
    its rows run alone
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


@pytest.mark.parametrize("case", ["kick", "budget"])
def test_a_batch_is_independent_trajectories(case):
    """Row i of a batched run is the same run on row i alone: the gate, the kick, the bump, the budget and
    the receipts all belong to the trajectory. Both operators attached, three interventions each.
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
    s0 = torch.stack([eye, 5.0 * eye, eye])
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
