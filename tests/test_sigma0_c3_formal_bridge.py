"""Bridge tests: the shipped engine satisfies the hypotheses of docs/formal/C3EngineLift.lean.

The Lean file proves Theorem C3 in an abstract real inner-product space with an element I,
⟪I, I⟫ = d. For symmetric matrices with the Frobenius inner product, I is the identity and the
proof applies to the engine exactly when these hold, which is what this file checks:

  * `_anisotropy_per_sample` is the abstract cv, ‖Σ − μI‖_F / (√(d−1)·μ)
  * each per-sample projector P is projector-like: ⟪P, P⟫_F = ⟪P, I⟫_F = m
  * `_cov_floor` is the floor in the Lean hypothesis `hb`, at ε' = LIFT_MARGIN·ε_a
  * for X ⪰ eps·I, `project_preserving_shape(X)` is X itself, or c·X + D with tr(c·X) ≥ σ_max and
    ‖D‖_F² ≤ eps·tr D (D raises eigenvalues by amounts in [0, eps])
  * the constants in the code are the constants in the proof

The theorem's conclusion is then checked through the real `forward_step` under fuzzing, including
the scale-down-and-clamp branch, and its hypothesis ρ = d·eps/σ_max ≤ RHO_MAX is enforced.
These identities are standard linear algebra; they are tested here, not formalized in Lean.
"""
import math
import pathlib

import pytest

torch = pytest.importorskip("torch")

from src.cio_sde import (
    CIO_SDE, LinearDynamics, SemanticCollapseOperator, AntiCollapseOperator, InterventionPolicy,
)
from src.cio_sde.engine import CovarianceField

LEAN = pathlib.Path(__file__).resolve().parents[1] / "docs" / "formal" / "C3EngineLift.lean"
ARMED = dict(observe_only=False, max_interventions=10 ** 9)


def _zero_policy(m):
    for p in m.pcsf.parameters():
        torch.nn.init.zeros_(p)
    return m


class _DiagonalNoise(LinearDynamics):
    """LinearDynamics with a per-dimension diffusion gain, so Q can differ across modes."""

    def __init__(self, A, gain, ctrl_dim=2):
        super().__init__(A, B=torch.zeros(A.shape[0], ctrl_dim, dtype=A.dtype), noise=0.0)
        self.register_buffer("gain", gain)

    def diffusion(self, x):
        return self.gain.to(dtype=x.dtype).expand_as(x)


class _RecordingCov(CovarianceField):
    """Records which branch of project_preserving_shape each call took."""

    def __init__(self, dim, **kw):
        super().__init__(dim, **kw)
        self.branches = []          # every call, including the split mode's shape transport
        self.lift_branches = []     # only the projection that follows a C3 lift

    def project_preserving_shape(self, sigma):
        ev = torch.linalg.eigvalsh(0.5 * (sigma + sigma.transpose(-1, -2)))
        top = ev.max(dim=-1).values
        scale = (self.sigma_max / top).clamp_max(1.0)
        scaled_min = (ev.min(dim=-1).values * scale)
        for t, s in zip(top.tolist(), scaled_min.tolist()):
            self.branches.append(
                "clamp" if s < self.eps else ("scale" if t > self.sigma_max else "identity"))
        return super().project_preserving_shape(sigma)


def _frobenius_cv(sigma):
    d = sigma.shape[-1]
    eye = torch.eye(d, dtype=sigma.dtype)
    mu = torch.diagonal(sigma, dim1=-2, dim2=-1).sum(-1) / d
    cent = sigma - mu[..., None, None] * eye
    return torch.linalg.matrix_norm(cent, ord="fro") / (math.sqrt(d - 1) * mu)


def _random_spd(d, gen, lo=-3.0, hi=3.0, batch=1):
    q, _ = torch.linalg.qr(torch.randn(batch, d, d, generator=gen, dtype=torch.float64))
    ev = 10 ** (lo + (hi - lo) * torch.rand(batch, d, generator=gen, dtype=torch.float64))
    return (q * ev.unsqueeze(-2)) @ q.transpose(-1, -2)


def _low_rank(d, r, gen, scale=1.0):
    """A non-normal Jacobian of rank r."""
    u = torch.randn(d, r, generator=gen, dtype=torch.float64)
    v = torch.randn(r, d, generator=gen, dtype=torch.float64)
    return scale * (u @ v) / math.sqrt(d)


# ── the bridge identities ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("d", [2, 3, 4, 17, 64])
def test_anisotropy_is_the_frobenius_cv(d):
    gen = torch.Generator().manual_seed(100 + d)
    sigma = _random_spd(d, gen, batch=8)
    det = SemanticCollapseOperator()
    assert torch.allclose(det._anisotropy_per_sample(sigma), _frobenius_cv(sigma), rtol=1e-9)


@pytest.mark.parametrize("d", [2, 4, 9, 40])
def test_projector_is_projector_like_in_frobenius(d):
    gen = torch.Generator().manual_seed(200 + d)
    op = AntiCollapseOperator()
    A = torch.stack([_low_rank(d, max(1, d // 3), gen) for _ in range(5)])
    P, m = op._near_null_projector_per_sample(A, batch_size=5)
    eye = torch.eye(d, dtype=P.dtype)
    pp = (P * P).sum(dim=(-2, -1))                       # ⟪P, P⟫_F
    pi = (P * eye).sum(dim=(-2, -1))                     # ⟪P, I⟫_F = tr P
    assert torch.allclose(pp, m.to(pp.dtype), atol=1e-9)
    assert torch.allclose(pi, m.to(pi.dtype), atol=1e-9)
    assert bool(((m >= 1) & (m <= d - 1)).all())


@pytest.mark.parametrize("d", [2, 4, 16, 400, 512])
def test_cov_floor_is_the_lean_hypothesis_hb(d):
    gen = torch.Generator().manual_seed(300 + d)
    op = AntiCollapseOperator()
    eps_t = op.detector.anisotropy_eps * op.LIFT_MARGIN
    sigma = _random_spd(d, gen, lo=-1.0, hi=1.0, batch=3)
    m = op._max_lift_rank(d)
    b = op._cov_floor(sigma, d, m)
    a = _frobenius_cv(sigma)
    mu = torch.diagonal(sigma, dim1=-2, dim2=-1).sum(-1) / d
    lhs = (eps_t + a) * mu * d
    rhs = b * (math.sqrt(m * (d - m)) - eps_t * m)
    assert torch.allclose(lhs, rhs, rtol=1e-9)
    # rank feasibility (Lean `rank_feasible`): the denominator is at least half its root.
    assert math.sqrt(m * (d - m)) - eps_t * m >= 0.5 * math.sqrt(m * (d - m)) - 1e-12


@pytest.mark.parametrize("d", [2, 3, 4, 8, 32])
def test_shape_projection_is_identity_or_scaled_plus_floor_correction(d):
    gen = torch.Generator().manual_seed(400 + d)
    cov = CovarianceField(d)
    seen = set()
    for trial in range(40):
        lo, hi = (-4.0, 4.0) if trial % 2 else (-1.0, 2.9)
        X = _random_spd(d, gen, lo=lo, hi=hi)[0]
        X = X + cov.eps * torch.eye(d, dtype=X.dtype)    # the engine's X is ⪰ eps·I
        out = cov.project_preserving_shape(X.unsqueeze(0))[0]
        top = float(torch.linalg.eigvalsh(X).max())
        if top <= cov.sigma_max:
            assert torch.allclose(out, X, rtol=1e-9, atol=1e-12)
            seen.add("identity")
            continue
        c = cov.sigma_max / top
        D = out - c * X
        D = 0.5 * (D + D.T)
        ev_d = torch.linalg.eigvalsh(D)
        assert float(ev_d.min()) >= -1e-9 and float(ev_d.max()) <= cov.eps * (1 + 1e-6)
        tr_d = float(torch.trace(D))
        assert float((D * D).sum()) <= cov.eps * tr_d + 1e-15
        assert float(torch.trace(c * X)) >= cov.sigma_max * (1 - 1e-12)
        seen.add("clamp" if tr_d > 0 else "scale")
    assert {"identity", "scale"} <= seen


def test_code_constants_are_the_proof_constants():
    text = LEAN.read_text(encoding="utf-8")
    assert "102 / 100" in text and "1 / 20" in text and "9 / 10000" in text
    assert AntiCollapseOperator.LIFT_MARGIN == pytest.approx(102 / 100)
    assert SemanticCollapseOperator().anisotropy_eps == pytest.approx(1 / 20)
    assert AntiCollapseOperator.RHO_MAX == pytest.approx(9 / 10000)
    cov = CovarianceField(4)
    assert 9000 * cov.eps / cov.sigma_max <= AntiCollapseOperator.RHO_MAX + 1e-15
    assert 9001 * cov.eps / cov.sigma_max > AntiCollapseOperator.RHO_MAX


# ── the hypothesis, enforced ─────────────────────────────────────────────────────────────

def _gate_case(d=4, sigma_max=1e3, policy=ARMED):
    m = _zero_policy(CIO_SDE(dim=d, ctrl_dim=2, hidden=4)).double()
    A = torch.zeros(d, d, dtype=torch.float64)
    A[0, 0] = 0.8
    m.graph.active = LinearDynamics(A, B=torch.zeros(d, 2, dtype=torch.float64), noise=0.0)
    m.cov = CovarianceField(d, sigma_max=sigma_max)
    m.intervention_policy = InterventionPolicy(**policy)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    x = torch.zeros(1, d, dtype=torch.float64)
    sigma = 0.05 * torch.eye(d, dtype=torch.float64).unsqueeze(0)
    return m, x, sigma


def test_armed_step_refuses_when_rho_exceeds_the_theorem():
    m, x, sigma = _gate_case(sigma_max=0.1)              # ρ = 4·1e-4/0.1 = 4e-3 > 9e-4
    with pytest.raises(ValueError, match="Theorem C3"):
        m.forward_step(x, sigma, 0.05, torch.zeros_like(x), step=0)


def test_observe_only_never_refuses():
    m, x, sigma = _gate_case(sigma_max=0.1, policy=dict(observe_only=True, max_interventions=0))
    _, _, info = m.forward_step(x, sigma, 0.05, torch.zeros_like(x), step=0)
    assert info["sigma0_proximity"] > 0.0
    assert info["intervention_receipt"].kind == "observe"


def test_default_covariance_field_is_inside_the_hypothesis():
    m, x, sigma = _gate_case()                           # ρ = 4e-7
    _, sigma_next, info = m.forward_step(x, sigma, 0.05, torch.zeros_like(x), step=0)
    assert info["anti_collapse_p"] > 0.0
    det = m.anti_collapse_op.detector
    assert float(det._anisotropy_per_sample(sigma_next)[0]) >= det.anisotropy_eps


# ── the conclusion, through the real engine ──────────────────────────────────────────────

def _check_c3_once(m, x, sigma, dt, noise, split=False):
    """Run one step; if the gate fired and the operator acted, C3 must hold for every sample.

    Unsplit, the gate reads Σ and the lift goes to Σ. Split (`shape_covariance` supplied), the gate
    reads the shape covariance and the lift goes there; the theorem applies to it unchanged."""
    det = m.anti_collapse_op.detector
    if split:
        _, sigma_belief, info = m.forward_step(x, sigma, dt, noise, step=0,
                                               shape_covariance=sigma.clone())
        read_next = info["shape_covariance"]
    else:
        _, read_next, info = m.forward_step(x, sigma, dt, noise, step=0)
    if info["anti_collapse_p"] <= 0.0 or info["sigma0_proximity"] <= 0.0:
        return False
    if isinstance(m.cov, _RecordingCov):
        m.cov.lift_branches.append(m.cov.branches[-1])   # the lift's projection is the step's last call
    a_next = det._anisotropy_per_sample(read_next)
    assert bool((a_next >= det.anisotropy_eps).all()), a_next
    # the next evaluation reads exactly that covariance; the gate must be off for every member
    if split:
        _, _, info2 = m.forward_step(x, sigma_belief, dt, torch.zeros_like(x), step=1,
                                     shape_covariance=read_next)
    else:
        _, _, info2 = m.forward_step(x, read_next, dt, torch.zeros_like(x), step=1)
    assert info2["sigma0_proximity"] == 0.0
    return True


def test_c3_holds_on_the_scale_down_and_clamp_branch():
    """Built to reach every branch: A = diag(−500,0,0,0) drives the active mode to eps, a large Q
    drives the null modes to σ_max, so the bump exceeds σ_max and the scale-down pushes the active
    eigenvalue below eps, where the floor correction raises it. C3 must still hold."""
    d = 4
    for dtype in (torch.float64, torch.float32):
        m = _zero_policy(CIO_SDE(dim=d, ctrl_dim=2, hidden=4)).to(dtype)
        A = torch.diag(torch.tensor([-500.0, 0.0, 0.0, 0.0], dtype=dtype))
        m.graph.active = _DiagonalNoise(A, torch.tensor([0.0, 2.0, 2.0, 2.0], dtype=dtype)).to(dtype)
        m.cov = _RecordingCov(d)
        m.intervention_policy = InterventionPolicy(**ARMED)
        m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
        x = torch.zeros(1, d, dtype=dtype)
        sigma = 1000.0 * torch.eye(d, dtype=dtype).unsqueeze(0)
        assert _check_c3_once(m, x, sigma, 0.05, torch.zeros_like(x))
        assert m.cov.lift_branches == ["clamp"], m.cov.lift_branches


def test_c3_holds_on_the_clamp_branch_in_split_mode():
    """Split mode: the gate reads the shape covariance, which has no process noise. F = I + A·dt
    with A₁₁ = −1/dt sends e₁ to the floor while the null modes stay at σ_max, so the lift's
    projection scales down and clamps e₁ again. C3 must hold on the shape covariance."""
    d, dt = 4, 0.05
    for dtype in (torch.float64, torch.float32):
        m = _zero_policy(CIO_SDE(dim=d, ctrl_dim=2, hidden=4)).to(dtype)
        A = torch.diag(torch.tensor([-1.0 / dt, 0.0, 0.0, 0.0], dtype=dtype))
        m.graph.active = LinearDynamics(A, B=torch.zeros(d, 2, dtype=dtype), noise=0.0).to(dtype)
        m.cov = _RecordingCov(d)
        m.intervention_policy = InterventionPolicy(**ARMED)
        m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
        x = torch.zeros(1, d, dtype=dtype)
        sigma = 1000.0 * torch.eye(d, dtype=dtype).unsqueeze(0)
        assert _check_c3_once(m, x, sigma, dt, torch.zeros_like(x), split=True)
        assert m.cov.lift_branches == ["clamp"], m.cov.lift_branches


@pytest.mark.parametrize("split", [False, True])
def test_c3_fuzz_through_forward_step(split):
    """Random rank-deficient non-normal A, per-mode noise, flat Σ at every scale up to the cap,
    random dt, float64 and float32, with and without the split shape covariance. Every firing
    must satisfy C3; every projection branch must be visited."""
    gen = torch.Generator().manual_seed(20261105)
    fired, branches = 0, set()
    for trial in range(240):
        dtype = torch.float64 if trial % 3 else torch.float32
        d = [2, 3, 4, 6, 8][trial % 5]
        dt = [0.01, 0.05, 0.2][trial % 3]
        r = max(1, (d - 1) // 2)                         # eff_rank < d/2, so the rank gate can fire
        scale = float(10 ** (-1 + 3.5 * torch.rand(1, generator=gen)))
        A = _low_rank(d, r, gen, scale=scale)
        if trial % 4 == 0:
            A[0] = 0.0
            A[0, 0] = -float(10 ** (1 + 2 * torch.rand(1, generator=gen)))
        elif trial % 4 == 2:
            # F = I + A·dt sends e₁ to zero: the deterministic shape transport then has one
            # eigenvalue at the floor beside others at full scale, the case that reaches the clamp.
            A[0] = 0.0
            A[0, 0] = -1.0 / dt
        gains = torch.rand(d, generator=gen, dtype=torch.float64) * float(10 ** (2 * torch.rand(1, generator=gen) - 1))
        m = _zero_policy(CIO_SDE(dim=d, ctrl_dim=2, hidden=4)).to(dtype)
        m.graph.active = _DiagonalNoise(A.to(dtype), gains.to(dtype)).to(dtype)
        m.cov = _RecordingCov(d)
        m.intervention_policy = InterventionPolicy(**ARMED)
        m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
        s = [1e-3, 0.3, 1.0, 50.0, 990.0, 1000.0][trial % 6]
        wobble = 1.0 + 0.02 * (torch.rand(d, generator=gen, dtype=torch.float64) - 0.5)
        sigma = torch.diag(s * wobble).unsqueeze(0).to(dtype)
        x = (1e-4 * torch.randn(1, d, generator=gen, dtype=torch.float64)).to(dtype)
        noise = torch.randn(1, d, generator=gen, dtype=torch.float64).to(dtype)
        fired += int(_check_c3_once(m, x, sigma, dt, noise, split=split))
        branches.update(m.cov.lift_branches)
    assert fired >= 100, fired
    assert {"identity", "scale", "clamp"} <= branches, branches
