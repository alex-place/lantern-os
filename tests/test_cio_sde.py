"""Tests for the CIO Neural SDE engine — issue #392."""
import pytest

torch = pytest.importorskip("torch")

from src.cio_sde import (
    CIO_SDE, Dynamics, LinearDynamics, rollout, analyze_trajectory,
    free_energy, gaussian_kl,
    SemanticCollapseOperator, CollapseOutcome,
    collapse_certificate, lyapunov_value, AntiCollapseOperator,
    InterventionPolicy,
    SurpriseMonitor,
)


def _model(dim=4, ctrl=2, hidden=16, seed=0):
    torch.manual_seed(seed)
    return CIO_SDE(dim=dim, ctrl_dim=ctrl, hidden=hidden)


def _init_state(b=8, dim=4, scale=1.0):
    x0 = scale * torch.randn(b, dim)
    s0 = torch.eye(dim).expand(b, dim, dim).clone()
    return x0, s0


def _acting(m, budget=10_000):
    """Enable Σ₀ intervention. Observe-only is the production default (#1138), so a
    test that exercises what happens WHEN the operator ACTS (freeze, projection,
    the canary spiking on the snap/kick) must opt in — otherwise tr.collapses stays
    empty by policy and the behavior under test never runs."""
    m.intervention_policy = InterventionPolicy(observe_only=False, max_interventions=budget)
    return m


# ── SDE rollout ──────────────────────────────────────────────────────────────

@pytest.mark.synthetic
def test_rollout_shapes():
    m = _model()
    x0, s0 = _init_state()
    xf, sf, tr = rollout(m, x0, s0, steps=10)
    assert xf.shape == x0.shape
    assert sf.shape == s0.shape
    assert len(tr.steps) == 10


@pytest.mark.synthetic
def test_sde_bounded_under_noise():
    """Success criterion: SDE does not explode under bounded noise."""
    m = _model()
    x0, s0 = _init_state()
    _, _, tr = rollout(m, x0, s0, steps=80, dt=0.05)
    rep = analyze_trajectory(tr)
    assert not rep.diverged
    assert all(v == v for v in tr.x_norms())  # no NaN


@pytest.mark.synthetic
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
    _acting(m)
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
    _acting(m)
    x0, s0 = _init_state(scale=0.01)
    xf, _, tr = rollout(m, x0, s0, steps=20, base_seed=1)
    # last few x-norms should be essentially constant (frozen attractor)
    norms = tr.x_norms()
    assert abs(norms[-1] - norms[-2]) < 1e-3


def test_sigma_zero_freezes_sigma_positive_explores():
    """The σ-axis directly — grounds the Σ₀-collapse ↔ ML σ=0 (zero-noise) link.

    The SDE's diffusion gain g(x) IS the exploration noise σ (engine.forward_step:
    ``dW = g · dilation · noise · √dt`` — the "noise gain (exploration)"). With the
    drift zeroed (A=0) and the Σ₀ collapse operator OFF, this isolates the σ-axis:
      • σ = 0  → dW ≡ 0 → the state is FROZEN (the zero-noise limit; no exploration).
        This is the dynamical twin of the certificate's 42-state and of ML's σ=0
        (clean-data ICL / zero weight-perturbation continual learning).
      • σ > 0  → dW ≠ 0 → the state RANDOM-WALKS (explores / escapes the point) —
        the motion Σ₀⁻¹ relies on, and what external grounding steers.
    Refs (verified): ICL σ — arXiv:2306.04637, 2211.15661; continual-learning σ
    (weight-perturbation std) — arXiv:2404.00781, 2503.01595.
    """
    node = LinearDynamics(torch.zeros(4, 4), B=torch.zeros(4, 2), noise=0.0)
    m = CIO_SDE(dim=4, ctrl_dim=2, hidden=8)
    m.graph.active = node          # zero drift ⇒ ONLY the diffusion gain σ moves x
    m.collapse_op = None           # operators OFF: this is the σ-axis, not Σ₀
    m.anti_collapse_op = None
    m.pcsf.u_max = 1e-6            # control off (drift is already 0) — pure σ-axis
    x0, s0 = _init_state(scale=0.01)

    node._noise = 0.0              # σ = 0 — the zero-noise limit
    _, _, tr0 = rollout(m, x0.clone(), s0.clone(), steps=30, base_seed=1)
    n0 = tr0.x_norms()
    assert abs(n0[-1] - n0[0]) < 1e-5      # frozen: the state does not move at all

    node._noise = 0.5              # σ > 0 — exploration on (same noise seed)
    _, _, tr1 = rollout(m, x0.clone(), s0.clone(), steps=30, base_seed=1)
    n1 = tr1.x_norms()
    assert all(v == v for v in n1)         # finite (no NaN/divergence)
    assert n1[-1] > n0[-1] + 0.2           # explored: random-walked away from x0


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


# ── Real vs Synthetic Data Separation (issue #522) ───────────────────────────
#
# Data-type taxonomy (arXiv:2402.07043 change-of-scaling-laws; Shumailov et al. 2024):
#   synthetic (π=0) : the model is rolled out on its own outputs only.
#                     Recursive self-reference drives model collapse — the state
#                     freezes onto the Σ₀ null manifold (the parrot attractor).
#   real      (π=1) : every segment is re-anchored to a fresh EXTERNAL
#                     observation. External grounding prevents collapse.
#   mixed (0<π<1)   : real + synthetic blended; collapse is slowed in proportion
#                     to the real-data fraction π.
#
# Double-scaling-law prediction: collapse severity is monotone-decreasing in π,
# so   synthetic ≥ mixed ≥ real   in collapse score (real is the most stable).

def _collapse_prone_model(dim=4, seed=0):
    """A model wired to collapse under recursion: zeroed drift + Σ₀ operator.

    With the drift net zeroed the Jacobian is rank-deficient and, started near
    the origin, all four Σ₀ trigger conditions hold — the system freezes onto
    the null manifold unless it is re-grounded by an external observation.
    """
    m = _model(dim=dim, seed=seed)
    for p in m.graph.active.drift_net.parameters():
        torch.nn.init.zeros_(p)
    m.collapse_op = SemanticCollapseOperator()
    return _acting(m)


def _run_recursive_with_grounding(real_fraction, *, dim=4, segments=8,
                                   seg_steps=5, seed=1):
    """Roll the collapse-prone model out in segments, re-grounding the state to a
    fresh external ('real') observation between segments with weight π.

    Returns the collapse score = number of Σ₀ collapse events over the run.
    π=0 is pure synthetic recursion; π=1 re-anchors fully every segment; values
    in between blend the two (the mixed regime).
    """
    torch.manual_seed(seed)
    m = _collapse_prone_model(dim=dim, seed=seed)
    x, sigma = _init_state(b=16, dim=dim, scale=0.01)   # start near the attractor
    collapse_events = 0
    for seg in range(segments):
        x, sigma, tr = rollout(m, x, sigma, steps=seg_steps, base_seed=seed + seg)
        collapse_events += len(tr.collapses)
        if real_fraction > 0.0:
            # external grounding: a fresh, non-degenerate real observation
            real_obs = torch.randn(x.shape[0], dim)
            x = (1.0 - real_fraction) * x + real_fraction * real_obs
    return collapse_events


@pytest.fixture
def synthetic_collapse_score():
    """Pure synthetic recursion (real_fraction π=0)."""
    return _run_recursive_with_grounding(0.0)


@pytest.fixture
def real_collapse_score():
    """Fully externally-grounded data (real_fraction π=1)."""
    return _run_recursive_with_grounding(1.0)


@pytest.fixture
def mixed_collapse_score():
    """Mixed real+synthetic data (real_fraction π=0.5)."""
    return _run_recursive_with_grounding(0.5)


@pytest.mark.synthetic
def test_synthetic_collapses(synthetic_collapse_score):
    """π=0: pure synthetic recursion drives the system into Σ₀ collapse."""
    assert synthetic_collapse_score > 0


@pytest.mark.real
def test_real_grounding_prevents_collapse(real_collapse_score, synthetic_collapse_score):
    """π=1: external grounding yields strictly fewer collapses than synthetic."""
    assert real_collapse_score < synthetic_collapse_score


@pytest.mark.mixed
def test_collapse_scaling_monotone_in_real_fraction(
        synthetic_collapse_score, mixed_collapse_score, real_collapse_score):
    """Double-scaling law: collapse score is monotone-decreasing in π.

    synthetic (π=0) ≥ mixed (π=0.5) ≥ real (π=1), and synthetic strictly worse
    than real — the arXiv:2402.07043 'mix real data to prevent collapse' result.
    """
    assert synthetic_collapse_score >= mixed_collapse_score >= real_collapse_score
    assert synthetic_collapse_score > real_collapse_score


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
    """Surprise monitor fires NIS canary and triggers anti-collapse excitation.

    Closed #657 (the #506 residual). The engine no longer self-observes (y=x gave
    innovation ν≡0 so the canary never fired). It now runs a genuine Kalman
    predict/update cycle (engine.forward_step): it predicts the next state from the
    model's own drift+diffusion (process noise Q=(g·dilation)²·dt), then scores the
    realized state as an observation. Smooth exploration stays consistent (NIS≈m,
    silent — verified 0/30 spooks in a structured regime), while the collapse snap /
    Σ₀⁻¹ excitation kick spikes NIS past the χ² threshold (the spook).
    """
    m = _model()
    # Create a system that will drift toward collapse
    for p in m.graph.active.drift_net.parameters():
        torch.nn.init.zeros_(p)

    # Wire surprise monitor to anti-collapse
    m.surprise_monitor = SurpriseMonitor(spook_sigmas=3.0, anti_collapse_trigger=True)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    m.collapse_op = SemanticCollapseOperator()
    _acting(m)

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


# ── Non-Normal Jacobian Handling ───────────────────────────────────────────────

def test_certificate_with_non_normal_matrix():
    """Small-gain bound handles non-symmetric (non-normal) matrices."""
    # Create a non-normal matrix with significant cross-terms
    A = torch.tensor([[-0.5, 2.0], [0.0, -0.8]])
    cert = collapse_certificate(A.unsqueeze(0))
    # Should provide a bound even for non-normal case
    assert cert.alpha is not None
    assert cert.active_dim == 2  # both modes active


def test_certificate_cross_term_bound():
    """Cross-term norm is added to symmetric bound for non-normal case."""
    # Non-normal matrix: symmetric part has negative eigenvalues
    A = torch.tensor([[-0.3, 1.5], [-0.5, -0.6]])
    cert = collapse_certificate(A.unsqueeze(0))
    
    # Compute symmetric part separately
    A_s = 0.5 * (A + A.T)
    sym_evals = torch.linalg.eigvalsh(A_s)
    alpha_sym = float(sym_evals.max().item())
    
    # Cross-term norm should increase the bound
    cross_norm = torch.linalg.norm(A - A_s, ord=2).item()
    assert cert.alpha >= alpha_sym  # bound should be at least symmetric part
    assert cert.alpha <= alpha_sym + cross_norm + 1e-4  # should not exceed small-gain bound


def test_certificate_full_spectrum_abscissa():
    """Authoritative full-spectrum test (§1.2): exact max Re λ(A) on the full Jacobian,
    tighter than the conservative small-gain `alpha` bound."""
    # symmetric: both measures agree
    sym = collapse_certificate((-0.8 * torch.eye(3)).unsqueeze(0))
    assert sym.spectral_abscissa == pytest.approx(-0.8, abs=1e-4)
    assert sym.full_contracting is True

    # non-normal but genuinely contracting (Re λ ≈ −0.45): small-gain over-rejects,
    # full spectrum correctly certifies contraction.
    A = torch.tensor([[-0.3, 1.5], [-0.5, -0.6]])
    cert = collapse_certificate(A.unsqueeze(0))
    assert cert.spectral_abscissa < 0          # full spectrum: contracting
    assert cert.full_contracting is True
    assert cert.alpha > 0                       # small-gain bound: over-conservative
    assert cert.guaranteed is False             # ...so small-gain alone says not-guaranteed

    # marginal rotation: α(A_s) is negative but the full spectrum is a center (Re λ = 0)
    rot = torch.tensor([[-1.0, 0.0, 0.0], [0.0, 0.0, 2.0], [0.0, -2.0, 0.0]])
    rc = collapse_certificate(rot.unsqueeze(0))
    assert rc.spectral_abscissa == pytest.approx(0.0, abs=1e-4)
    assert rc.full_contracting is False


def test_collapse_is_nonexpansive_projection():
    """Collapse is an orthogonal projection onto the null manifold: ‖P x‖ ≤ ‖x‖.

    Regression for issue #661 — the former multiplicative "log-barrier" could
    flip sign and grow ‖x*‖ at strengths above ~0.217. A clean projector never
    increases the norm.
    """
    m = _model()
    m.collapse_op = SemanticCollapseOperator()

    # Create a collapsing regime
    for p in m.graph.active.drift_net.parameters():
        torch.nn.init.zeros_(p)

    _acting(m)
    x0, s0 = _init_state(scale=0.01)
    _, _, tr = rollout(m, x0, s0, steps=20, base_seed=1)

    # Should collapse, and projection is non-expansive (norm never blows up)
    assert len(tr.collapses) > 0
    norms = tr.x_norms()
    for i in range(1, len(norms)):
        assert abs(norms[i] - norms[i - 1]) < 10.0

    # Direct check: the collapse projection cannot increase the state norm.
    op = SemanticCollapseOperator()
    A = torch.zeros(4, 8, 8)              # all-null Jacobian → full projector
    x = torch.randn(4, 8)
    x_star, outcome = op._collapse_state(x, A)
    assert outcome == CollapseOutcome.ATTRACTOR
    assert torch.all(x_star.norm(dim=-1) <= x.norm(dim=-1) + 1e-5)


def test_non_symmetric_jacobian_in_rollout():
    """Rollout with non-symmetric Jacobian dynamics."""
    # Create a non-normal linear dynamics node
    A = torch.tensor([[-0.4, 1.0], [-0.3, -0.7]])
    B = torch.zeros(2, 2)
    node = LinearDynamics(A, B=B, noise=0.05)
    
    m = CIO_SDE(dim=2, ctrl_dim=2, hidden=8)
    m.graph.active = node
    m.pcsf.u_max = 1e-6  # disable control for pure drift test
    
    x0, s0 = _init_state(b=16, dim=2, scale=1.0)
    xf, _, tr = rollout(m, x0, s0, steps=50, dt=0.05, base_seed=0)
    
    # Should remain bounded even with non-normal dynamics
    assert not analyze_trajectory(tr).diverged
    assert all(v == v for v in tr.x_norms())  # no NaN


# ── Lemma L2: one-step anisotropy lift (proven; #768) ──────────────────────────

def test_l2_anisotropy_lift():
    """Σ₀⁻¹'s aligned covariance bump of magnitude b ≥ Δ lifts anisotropy above ε_a
    in one step (breaks the collapse trigger's flat leg). Proof + machine-check:
    docs/SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md, experiments/prove_l2_anisotropy_lift.py.

        Δ = (ε_a + a)·μ·d / (√(k(d-k)) − ε_a·k)   (a = population CoV of Σ < ε_a)
    """
    import math
    eps_a = 5e-2
    op = SemanticCollapseOperator(anisotropy_eps=eps_a)
    g = torch.Generator().manual_seed(20260619)
    dims = [4, 5, 8, 12]
    counterexamples = 0
    checked = 0
    for t in range(160):
        d = dims[t % len(dims)]
        k = 1 + (t % (d - 1))                          # 1..d-1
        mu = float(torch.empty(1, dtype=torch.float64).uniform_(0.05, 5.0, generator=g))
        a_t = float(torch.empty(1, dtype=torch.float64).uniform_(1e-3, 0.9 * eps_a, generator=g))
        z = torch.randn(d, generator=g, dtype=torch.float64); z = z - z.mean()
        ps = z.pow(2).mean().sqrt()
        if float(ps) < 1e-9:
            continue
        lam = (mu + (a_t * mu / ps) * z).clamp_min(1e-6)
        Q, _ = torch.linalg.qr(torch.randn(d, d, generator=g, dtype=torch.float64))
        Sigma = (Q * lam) @ Q.T
        ev = torch.linalg.eigvalsh(0.5 * (Sigma + Sigma.T))
        a = float((ev - ev.mean()).pow(2).mean().sqrt() / ev.mean())
        mu_real = float(ev.mean())
        if a >= eps_a:                                 # only the near-isotropic hypothesis
            continue
        denom = math.sqrt(k * (d - k)) - eps_a * k
        assert denom > 0
        b = (eps_a + a) * mu_real * d / denom          # Δ
        idx = torch.randperm(d, generator=g)[:k]
        V = Q[:, idx]
        Sigma_plus = (Sigma + b * (V @ V.T)).to(torch.float32)
        if op._anisotropy(Sigma_plus) < eps_a - 1e-6:  # L2 conclusion
            counterexamples += 1
        checked += 1
    assert checked > 100, f"too few near-isotropic cases sampled ({checked})"
    assert counterexamples == 0, f"L2 violated in {counterexamples}/{checked} cases"


# ── Theorem C3 (normal A): Σ₀⁻¹ floor + banded near-null prevent permanent freeze ──
# Proof: docs/SIGMA0-C3-NONCOLLAPSE-NORMAL.md
# Machine-check sweep: experiments/prove_c3_noncollapse.py
#
# L4 (Fix A): the μ-aware covariance floor delivers a bump b_cov ≥ Δ even when the
#   min-gate proximity p is tiny, so one bump lifts anisotropy above ε_a (L2).
# G13 (Fix B): banded near-null aiming clamped to 1≤m≤d−1 never injects a zero-rank
#   (blank) bump, and never bumps all d modes (a uniform shift that LOWERS anisotropy).
# L5: a freeze trigger at t forces ¬cond_flat at t+1 — no two consecutive freezes.

def _near_isotropic_diag(d, a_unbiased_target, mu=1.0, seed=7):
    """Diagonal Σ eigenvalues whose UNBIASED CoV (what _anisotropy measures) ≈ target.

    _anisotropy uses torch's Bessel-corrected std = √(d/(d−1))·pop_std, so we scale the
    population CoV down by that factor to hit the requested measured value.
    """
    import math
    z = torch.randn(d, generator=torch.Generator().manual_seed(seed))
    z = z - z.mean()
    z = z / z.pow(2).mean().sqrt()                      # unit population std
    pop_cov = a_unbiased_target / math.sqrt(d / (d - 1))
    return (mu + pop_cov * mu * z).clamp_min(1e-6)


def test_l4_floor_lifts_anisotropy():
    """Fix A — the μ-aware covariance floor lifts a flat Σ above ε_a in ONE bump even
    when strength·p ≪ Δ, exactly where the old scale-blind bump leaves it frozen."""
    op = AntiCollapseOperator(strength=0.5)
    eps_a = op.detector.anisotropy_eps
    d = 4
    sigma = torch.diag(_near_isotropic_diag(d, 0.5 * eps_a)).unsqueeze(0)
    assert op.detector._anisotropy(sigma) < eps_a               # flat: cond_flat holds
    # partially-degenerate A_s (one active mode, rest null) → proper null subspace,
    # diagonal so its eigenbasis aligns with the diagonal Σ (L1, normal A).
    A = torch.diag(torch.tensor([0.8, 0.0, 0.0, 0.0])).unsqueeze(0)
    x = torch.zeros(1, d)
    noise = torch.zeros(1, d)                                   # isolate the covariance leg
    p = 0.01                                                    # tiny gate → weak old bump

    _, sig_extra = op.excite(x, sigma, A, p, noise)
    assert op.detector._anisotropy(sigma + sig_extra) >= eps_a  # NEW: floor broke cond_flat

    # Same null modes, OLD scale-blind magnitude (strength·p): does NOT lift it.
    null = op._near_null_basis(A)
    old_bump = (op.strength * p) * (null @ null.T)
    assert op.detector._anisotropy(sigma + old_bump.unsqueeze(0)) < eps_a


def test_l4_floor_scale_equivariant():
    """Fix A — Δ ∝ μ: rescaling Σ↦cΣ (which leaves the trigger invariant) scales the
    floor by c, so the lift holds at every scale. A fixed floor would fail at large c."""
    op = AntiCollapseOperator(strength=0.5)
    eps_a = op.detector.anisotropy_eps
    d, m = 4, 3
    sigma = torch.diag(_near_isotropic_diag(d, 0.5 * eps_a)).unsqueeze(0)
    c = 100.0
    f1 = op._cov_floor(sigma, d, m)
    fc = op._cov_floor(c * sigma, d, m)
    assert fc == pytest.approx(c * f1, rel=1e-3)                # scale-equivariant
    A = torch.diag(torch.tensor([0.8, 0.0, 0.0, 0.0])).unsqueeze(0)
    x = torch.zeros(1, d); noise = torch.zeros(1, d)
    for scale in (1.0, c):
        _, sig_extra = op.excite(x, scale * sigma, A, 0.01, noise)
        assert op.detector._anisotropy(scale * sigma + sig_extra) >= eps_a


def test_g13_no_zero_rank_bump():
    """Fix B / G13 — a rank-deficient A whose near-null modes sit just ABOVE eig_eps no
    longer injects a blank bump. Old hard cutoff |λ|<eig_eps → rank-0 → zero injection."""
    op = AntiCollapseOperator(strength=0.5, eig_eps=1e-2)
    # one dominant mode (2.0) + three at 0.015: ABOVE eig_eps (0.01) absolute, but BELOW
    # eig_eps·max (0.02) relative → effective rank 1 (< d/2): genuinely rank-deficient.
    A = torch.diag(torch.tensor([2.0, 0.015, 0.015, 0.015])).unsqueeze(0)
    A_s_ev = torch.linalg.eigvalsh(0.5 * (A.mean(0) + A.mean(0).T))
    assert int((A_s_ev.abs() < op.eig_eps).sum()) == 0          # old cutoff: nothing to aim at
    assert op.detector._effective_rank(A) < 0.5 * 4            # but rank-deficient (cond_rank)
    basis = op._near_null_basis(A)
    assert basis.shape[1] >= 1                                  # NEW: non-empty aim
    assert basis.shape[1] <= 3                                  # …and never all d (k=d clamp)
    x = torch.zeros(1, 4); noise = torch.randn(1, 4)
    sigma = torch.eye(4).unsqueeze(0)
    _, sig_extra = op.excite(x, sigma, A, 0.5, noise)
    assert float(sig_extra.abs().sum()) > 0.0                   # non-blank covariance bump


def test_c3_no_consecutive_freeze():
    """Theorem C3 (normal A), L5 core step: a freeze trigger at t forces ¬cond_flat at
    t+1, so the four-condition gate cannot fire on two consecutive steps."""
    m = _model()
    for p in m.graph.active.drift_net.parameters():
        torch.nn.init.zeros_(p)                                # zero drift ⇒ A=0 (normal)
    detector = SemanticCollapseOperator()
    op = AntiCollapseOperator(detector=detector, strength=0.5)
    eps_a = detector.anisotropy_eps
    d = 4

    # State on the freeze boundary: ∇L≈0 (tiny x), ∂H/∂u≈0 (u=0), flat Σ, A≈0.
    x = torch.full((1, d), 1e-3)
    u = torch.zeros(1, m.ctrl_dim)
    A = torch.zeros(1, d, d)
    sigma = torch.diag(_near_isotropic_diag(d, 0.5 * eps_a)).unsqueeze(0)

    res_t = detector.evaluate(m, x, u, sigma, A)
    assert res_t.triggered, f"setup must trigger the freeze: {res_t.summary()}"

    # Σ₀⁻¹ fires (the engine gates excite on proximity>0, which holds here).
    p = op.proximity(m, x, u, sigma, A)
    assert p > 0.0
    _, sig_extra = op.excite(x, sigma, A, p, torch.zeros(1, d))
    sigma_plus = sigma + sig_extra                             # read-after-bump (engine ordering)

    res_t1 = detector.evaluate(m, x, u, sigma_plus, A)
    assert detector._anisotropy(sigma_plus) >= eps_a           # cond_flat broke…
    assert not res_t1.triggered                                # …so no consecutive freeze


def test_c3_nonnormal_covariance_lift():
    """Theorem C3 extends to NON-NORMAL A — the alignment hypothesis L1 is removable.

    The aligned L2 proof gets σ⁺ ≥ √(m(d−m))/d·b − aμ via the law of total variance.
    The SAME bound holds for ANY rank-m orthogonal projector via the reverse triangle
    inequality in Frobenius norm: ‖Σ⁺−μ⁺I‖_F ≥ b‖P−(m/d)I‖_F − ‖Σ−μI‖_F, with no
    alignment — the misalignment penalty tr((Σ−μI)P) ≤ ‖Σ−μI‖_F·‖P‖_F = a·μ·√(dm) is
    bounded by a(Σ), which cond_flat forces below ε_a. So the floored bump breaks
    cond_flat for non-normal A too, even when Σ's eigenbasis is ADVERSARIALLY
    misaligned (Σ's smallest eigendirections forced onto the bump basis — least
    Frobenius gain). This closes the covariance-leg half of [#768]."""
    detector = SemanticCollapseOperator()
    op = AntiCollapseOperator(detector=detector, strength=0.5)
    eps_a = detector.anisotropy_eps
    g = torch.Generator().manual_seed(20260626)

    for d in (4, 5, 6, 8):
        # genuinely non-normal A: rank-deficient symmetric part + nonzero skew part
        Q, _ = torch.linalg.qr(torch.randn(d, d, generator=g))
        lam = torch.zeros(d); lam[0] = 0.7                      # one active mode ⇒ null > d/2
        K = torch.randn(d, d, generator=g)
        A = ((Q * lam) @ Q.T + (K - K.T) / (K - K.T).norm()).unsqueeze(0)
        assert (A[0] @ A[0].T - A[0].T @ A[0]).norm() > 1e-6    # confirm A is non-normal

        # adversarial worst case: build Σ so its m SMALLEST eigendirections ARE the bump
        # basis (eig(A_s)), i.e. minimal tr(ΣP) — the hardest alignment for the lift.
        P_basis = op._near_null_basis(A)                        # (d, m), from A_s
        m_rank = P_basis.shape[1]
        full = torch.randn(d, d, generator=g)
        full[:, :m_rank] = P_basis
        Qs, _ = torch.linalg.qr(full)
        Qs[:, :m_rank] = P_basis                                # keep bump basis exact
        ev = torch.sort(_near_isotropic_diag(d, 0.5 * eps_a, mu=2.0)).values  # ascending
        sigma = ((Qs * ev) @ Qs.T).unsqueeze(0)                 # smallest λ on bump basis
        assert detector._anisotropy(sigma) < eps_a             # cond_flat holds pre-bump

        # tiny min-gate proximity — the regime where the floor (not strength·p) carries it
        _, sig_extra = op.excite(torch.zeros(1, d), sigma, A, 0.01, torch.zeros(1, d))
        assert detector._anisotropy(sigma + sig_extra) >= eps_a  # lifted — no alignment used


# ── Σ₀-K1 component 8: collapse certificate + NIS canary, end-to-end (#852) ──

def test_collapse_certificate_and_nis_canary_on_live_trajectory():
    """Both Σ₀ canaries fire on ONE live rollout — moving component 8 [coded]→[tested].

    (1) the surprise NIS χ² canary fires during the collapse approach (the #657
    wiring), and (2) the collapse certificate is GUARANTEED on the live per-step
    drift Jacobian pulled from the same trajectory.
    """
    from src.cio_sde.engine import drift_jacobian

    m = _model()
    for p in m.graph.active.drift_net.parameters():
        torch.nn.init.zeros_(p)
    m.surprise_monitor = SurpriseMonitor(spook_sigmas=3.0, anti_collapse_trigger=True)
    m.anti_collapse_op = AntiCollapseOperator(strength=0.5)
    m.collapse_op = SemanticCollapseOperator()
    _acting(m)

    x0, s0 = _init_state(scale=0.01)
    xf, sf, tr = rollout(m, x0, s0, steps=30, base_seed=1)

    # (1) NIS canary fired on the live trajectory.
    spook_steps = [s["step"] for s in tr.steps if s.get("surprise_spook", False)]
    assert len(spook_steps) > 0, "surprise NIS canary should fire during collapse approach"

    # (2) Collapse certificate is guaranteed on the live drift Jacobian.
    u = m.pcsf(xf, s0)
    A = drift_jacobian(m.graph.active, xf.detach(), u.detach())
    cert = collapse_certificate(A)
    assert cert.guaranteed, f"collapse certificate not guaranteed on live Jacobian: {cert}"


def test_collapse_certificate_contraction_rate_on_negdef_node():
    """A neg-definite execution node yields a guaranteed certificate with the expected
    contraction rate, read off a live rollout's drift Jacobian."""
    from src.cio_sde.engine import drift_jacobian

    m = _model()
    m.graph.active = LinearDynamics(-0.8 * torch.eye(4), B=torch.zeros(4, 2))
    x0, s0 = _init_state(scale=0.5)
    xf, sf, tr = rollout(m, x0, s0, steps=10, base_seed=2)
    u = m.pcsf(xf, s0)
    A = drift_jacobian(m.graph.active, xf.detach(), u.detach())
    cert = collapse_certificate(A)
    assert cert.guaranteed
    assert cert.contraction_rate == pytest.approx(0.8, abs=1e-3)
