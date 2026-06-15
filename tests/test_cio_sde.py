"""Tests for the CIO Neural SDE engine — issue #392."""
import pytest

torch = pytest.importorskip("torch")

from src.cio_sde import (
    CIO_SDE, Dynamics, LinearDynamics, rollout, analyze_trajectory,
    free_energy, gaussian_kl,
    SemanticCollapseOperator, CollapseOutcome,
    collapse_certificate, lyapunov_value, AntiCollapseOperator,
    SurpriseMonitor,
)


def _model(dim=4, ctrl=2, hidden=16, seed=0):
    torch.manual_seed(seed)
    return CIO_SDE(dim=dim, ctrl_dim=ctrl, hidden=hidden)


def _init_state(b=8, dim=4, scale=1.0):
    x0 = scale * torch.randn(b, dim)
    s0 = torch.eye(dim).expand(b, dim, dim).clone()
    return x0, s0


# ── SDE rollout ──────────────────────────────────────────────────────────────

def test_rollout_shapes():
    m = _model()
    x0, s0 = _init_state()
    xf, sf, tr = rollout(m, x0, s0, steps=10)
    assert xf.shape == x0.shape
    assert sf.shape == s0.shape
    assert len(tr.steps) == 10


def test_sde_bounded_under_noise():
    """Success criterion: SDE does not explode under bounded noise."""
    m = _model()
    x0, s0 = _init_state()
    _, _, tr = rollout(m, x0, s0, steps=80, dt=0.05)
    rep = analyze_trajectory(tr)
    assert not rep.diverged
    assert all(v == v for v in tr.x_norms())  # no NaN


def test_covariance_stays_psd_and_bounded():
    """Kalman-Bucy Riccati keeps Σ symmetric, PSD, and bounded."""
    m = _model()
    x0, s0 = _init_state()
    _, sf, tr = rollout(m, x0, s0, steps=60)
    sym = 0.5 * (sf + sf.transpose(-1, -2))
    assert torch.allclose(sf, sym, atol=1e-4)              # symmetric
    ev = torch.linalg.eigvalsh(sym)
    assert (ev > -1e-3).all()                              # PSD
    assert analyze_trajectory(tr).sigma_bounded


# ── Replay (invariant 2) ─────────────────────────────────────────────────────

def test_rollout_is_replayable():
    m = _model()
    x0, s0 = _init_state()
    xf1, sf1, _ = rollout(m, x0, s0, steps=40, base_seed=123)
    xf2, sf2, _ = rollout(m, x0, s0, steps=40, base_seed=123)
    assert torch.allclose(xf1, xf2, atol=1e-6)
    assert torch.allclose(sf1, sf2, atol=1e-6)


def test_different_seed_different_trajectory():
    m = _model()
    x0, s0 = _init_state()
    xf1, _, _ = rollout(m, x0, s0, steps=40, base_seed=1)
    xf2, _, _ = rollout(m, x0, s0, steps=40, base_seed=2)
    assert not torch.allclose(xf1, xf2, atol=1e-4)


# ── Free energy ──────────────────────────────────────────────────────────────

def test_gaussian_kl_zero_for_identical():
    mu = torch.zeros(4, 4)
    sig = torch.eye(4).expand(4, 4, 4).clone()
    kl = gaussian_kl(mu, sig, mu, sig)
    assert torch.allclose(kl, torch.zeros(4), atol=1e-5)


def test_gaussian_kl_nonnegative():
    mu_q = torch.randn(4, 4)
    sig_q = torch.eye(4).expand(4, 4, 4).clone() * 0.5
    mu_p = torch.zeros(4, 4)
    sig_p = torch.eye(4).expand(4, 4, 4).clone()
    assert (gaussian_kl(mu_q, sig_q, mu_p, sig_p) >= -1e-5).all()


def test_free_energy_finite_and_differentiable():
    m = _model()
    x0, s0 = _init_state()
    u = m.pcsf(x0, s0)
    F = free_energy(m, x0, u, s0).mean()
    assert torch.isfinite(F)
    F.backward()
    grads = [p.grad for p in m.parameters() if p.grad is not None]
    assert len(grads) > 0


# ── PCSF control ─────────────────────────────────────────────────────────────

def test_pcsf_respects_hard_clamp():
    """Invariant 1: control can never exceed the NAP hard bound."""
    m = CIO_SDE(dim=4, ctrl_dim=2, hidden=16)
    m.pcsf.u_max = 1.0
    x = 100.0 * torch.randn(8, 4)
    s = torch.eye(4).expand(8, 4, 4).clone()
    u = m.pcsf(x, s)
    assert u.abs().max() <= 1.0 + 1e-5


# ── Hot-swap (invariant 3) ───────────────────────────────────────────────────

def test_hot_swap_accepts_equivalent_node():
    m = _model()
    x0, s0 = _init_state()
    twin = Dynamics(4, 2, 16)
    twin.load_state_dict(m.graph.active.state_dict())   # behaviourally identical
    u = m.pcsf(x0, s0)
    rec = m.graph.hot_swap(twin, x0, u, step=0)
    assert rec.accepted
    assert rec.drift_delta < 1e-5
    assert m.graph.active is twin


def test_hot_swap_rejects_divergent_node():
    m = _model()
    x0, s0 = _init_state()
    torch.manual_seed(999)
    stranger = Dynamics(4, 2, 16)                        # unrelated weights
    u = m.pcsf(x0, s0)
    original = m.graph.active
    rec = m.graph.hot_swap(stranger, x0, u, step=0)
    assert not rec.accepted
    assert m.graph.active is original                    # unchanged on reject


# ── Σ₀ Semantic Collapse Operator ────────────────────────────────────────────

def test_collapse_dormant_in_structured_regime():
    m = _model()
    m.collapse_op = SemanticCollapseOperator()
    x0, s0 = _init_state(scale=1.0)
    _, _, tr = rollout(m, x0, s0, steps=40, base_seed=1)
    assert len(tr.collapses) == 0


def test_collapse_fires_in_degenerate_regime():
    """Zero drift Jacobian + near-origin + isotropic Σ ⇒ Σ₀ triggers."""
    m = _model()
    for p in m.graph.active.drift_net.parameters():
        torch.nn.init.zeros_(p)
    m.collapse_op = SemanticCollapseOperator()
    x0, s0 = _init_state(scale=0.01)
    _, _, tr = rollout(m, x0, s0, steps=20, base_seed=1)
    assert len(tr.collapses) > 0
    assert tr.collapses[0]["result"].outcome in (
        CollapseOutcome.ATTRACTOR, CollapseOutcome.NULL)


def test_collapse_freezes_state():
    """When Σ₀ fires, dx→0: the collapsed state stops moving."""
    m = _model()
    for p in m.graph.active.drift_net.parameters():
        torch.nn.init.zeros_(p)
    m.collapse_op = SemanticCollapseOperator()
    x0, s0 = _init_state(scale=0.01)
    xf, _, tr = rollout(m, x0, s0, steps=20, base_seed=1)
    # last few x-norms should be essentially constant (frozen attractor)
    norms = tr.x_norms()
    assert abs(norms[-1] - norms[-2]) < 1e-3


# ── Lyapunov collapse certificate ────────────────────────────────────────────

def test_certificate_guaranteed_for_negative_definite():
    A = -0.8 * torch.eye(4)
    cert = collapse_certificate(A.unsqueeze(0))
    assert cert.guaranteed
    assert cert.contraction_rate == pytest.approx(0.8, abs=1e-4)
    assert cert.null_dim == 0


def test_certificate_null_manifold_dim():
    A = torch.diag(torch.tensor([0.0, 0.0, -0.9, -0.9]))
    cert = collapse_certificate(A.unsqueeze(0))
    assert cert.guaranteed
    assert cert.null_dim == 2
    assert cert.active_dim == 2


def test_certificate_not_guaranteed_with_positive_eig():
    A = torch.diag(torch.tensor([0.5, -0.9, -0.9, -0.9]))
    cert = collapse_certificate(A.unsqueeze(0))
    assert not cert.guaranteed
    assert cert.alpha == pytest.approx(0.5, abs=1e-4)


def test_certificate_predicts_actual_contraction():
    """Guaranteed certificate ⇒ rollout Lyapunov V actually decays."""
    A = -0.8 * torch.eye(4)
    node = LinearDynamics(A, B=torch.zeros(4, 2))
    m = CIO_SDE(dim=4, ctrl_dim=2, hidden=8)
    m.graph.active = node
    m.pcsf.u_max = 1e-6                  # control off — test the drift spectrum
    x0, s0 = _init_state(b=64, scale=1.0)
    xf, _, tr = rollout(m, x0, s0, steps=100, dt=0.05, base_seed=0)
    v0 = lyapunov_value(x0, A.unsqueeze(0))
    vf = lyapunov_value(xf, A.unsqueeze(0))
    assert vf < 0.1 * v0                 # decayed by >10x
    assert analyze_trajectory(tr).lyapunov_decreasing


# ── Σ₀⁻¹ Anti-Collapse Operator ──────────────────────────────────────────────

def test_anti_collapse_suppresses_collapse():
    """With Σ₀⁻¹ attached, a previously-collapsing system no longer freezes."""
    m = _model()
    for p in m.graph.active.drift_net.parameters():
        torch.nn.init.zeros_(p)
    m.collapse_op = SemanticCollapseOperator()
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    x0, s0 = _init_state(scale=0.01)
    _, _, tr = rollout(m, x0, s0, steps=30, base_seed=1)
    assert len(tr.collapses) == 0                    # Σ₀ suppressed
    norms = tr.x_norms()
    assert norms[-1] > norms[0] * 5                  # re-excited, escaped


def test_anti_collapse_dormant_when_safe():
    """Σ₀⁻¹ costs nothing in a structured regime (proximity 0)."""
    m = _model()
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    x0, s0 = _init_state(scale=1.0)
    p = m.anti_collapse_op.proximity(
        m, x0, m.pcsf(x0, s0),
        s0, torch.eye(4).expand(8, 4, 4).clone())
    assert p == 0.0


# ── Surprise Monitor Integration ───────────────────────────────────────────────

def test_surprise_monitor_integration():
    """Surprise monitor fires NIS canary and triggers anti-collapse excitation."""
    m = _model()
    # Create a system that will drift toward collapse
    for p in m.graph.active.drift_net.parameters():
        torch.nn.init.zeros_(p)
    
    # Wire surprise monitor to anti-collapse
    m.surprise_monitor = SurpriseMonitor(spook_sigmas=3.0, anti_collapse_trigger=True)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    m.collapse_op = SemanticCollapseOperator()
    
    x0, s0 = _init_state(scale=0.01)
    _, _, tr = rollout(m, x0, s0, steps=30, base_seed=1)
    
    # Check that surprise spook fired at least once
    spook_steps = [s["step"] for s in tr.steps if s.get("surprise_spook", False)]
    assert len(spook_steps) > 0, "Surprise canary should fire during collapse approach"
    
    # Check that anti-collapse was triggered (proximity > 0)
    anti_collapse_steps = [s for s in tr.steps if s.get("anti_collapse_p", 0) > 0]
    assert len(anti_collapse_steps) > 0, "Anti-collapse should be triggered by surprise"
    
    # Check that system did not freeze (Σ₀ suppressed)
    assert len(tr.collapses) == 0, "Σ₀ should be suppressed by anti-collapse"
    
    # Check that system re-excited (state norm increased)
    norms = tr.x_norms()
    assert norms[-1] > norms[0] * 2, "System should re-excite after surprise trigger"


def test_sigma0_proximity_exposed():
    """Σ₀ proximity signal is exposed in rollout trace."""
    m = _model()
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    x0, s0 = _init_state(scale=1.0)
    _, _, tr = rollout(m, x0, s0, steps=20, base_seed=1)
    
    # Check that sigma0_proximity is recorded in trace
    for step in tr.steps:
        assert "sigma0_proximity" in step
        assert 0.0 <= step["sigma0_proximity"] <= 1.0
