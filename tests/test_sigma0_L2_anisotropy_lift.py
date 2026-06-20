"""
L2 — the one-step anisotropy-lift lemma for Σ₀⁻¹ (regression-locks the proof + the gap).

L2: at a near-flat Σ (cond_flat holds), the bump Σ → Σ + b·P_N raises `_anisotropy`
above anisotropy_eps so the collapse AND-gate cannot fire. Verified in
experiments/sigma0_L2_check.py; these tests pin the load-bearing facts:

  * the closed-form CoV equals the REAL `_anisotropy` (the algebra matches the code),
  * the bump clears eps_a at full strength (L2 holds for p >= p*),
  * the bump does NOT clear eps_a in the L4 dead-zone (p < p*) — the honest open gap.
"""
import math
import pytest

torch = pytest.importorskip("torch")

from src.cio_sde.collapse import SemanticCollapseOperator

DET = SemanticCollapseOperator()
EPS_A = DET.anisotropy_eps
ANISO = DET._anisotropy
D, K = 4, 3                      # k=3 > d/2=2 → the non-monotone regime L2 must survive


def _cov_closed_form(c, b, k=K, d=D):
    mu = c + (k / d) * b
    std_u = b * math.sqrt(k * (d - k) / ((d - 1) * d))
    return std_u / mu


def _aligned_sigma(c, b, k=K, d=D, seed=0):
    torch.manual_seed(seed)
    Q, _ = torch.linalg.qr(torch.randn(d, d))
    V = Q[:, :k]
    return (c * torch.eye(d) + b * (V @ V.T)).unsqueeze(0)


def _b_star(c, k=K, d=D, eps=EPS_A):
    s = math.sqrt(k * (d - k) / ((d - 1) * d))
    return eps * c / (s - eps * (k / d))


@pytest.mark.synthetic
def test_closed_form_matches_real_anisotropy():
    """The CoV algebra in the proof equals the deployed `_anisotropy` (err < 1e-4)."""
    for seed in range(50):
        torch.manual_seed(seed)
        c = 0.2 + 1.8 * torch.rand(1).item()
        b = 2.0 * torch.rand(1).item()
        got = ANISO(_aligned_sigma(c, b, seed=seed))
        want = _cov_closed_form(c, b)
        assert abs(got - want) < 1e-4, f"closed form {want} != code {got}"


@pytest.mark.synthetic
def test_L2_holds_at_full_strength():
    """Bump at p=1 (b=strength=0.5) clears eps_a from a flat isotropic Σ — L2 holds."""
    strength = 0.5
    for c in (0.5, 1.0, 1.5):
        before = ANISO((c * torch.eye(D)).unsqueeze(0))
        assert before < EPS_A                      # cond_flat holds before
        after = ANISO(_aligned_sigma(c, strength))
        assert after >= EPS_A, f"L2 failed: c={c} after={after} < {EPS_A}"


@pytest.mark.synthetic
def test_L4_dead_zone_is_real():
    """Below p* the bump CANNOT clear eps_a — locks the honest gap (proximity floor)."""
    c = 1.0
    p_star = _b_star(c) / 0.5                       # b* / strength
    b_weak = 0.5 * (0.5 * p_star)                   # p = p*/2  → must FAIL
    after = ANISO(_aligned_sigma(c, b_weak))
    assert after < EPS_A, (
        f"expected dead-zone failure at p<p*, got after={after} >= {EPS_A}; "
        "if this passes, p* is mis-derived")
