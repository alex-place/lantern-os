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
    A[0, 0, 1] = 1.0  # A=e1 e2ᵀ: non-normal, rank one.
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
