"""The serve-loop acceptance signal must read the loop's dynamics, not the size of its state.

Pinned failure: the old proxy (mean of Δh/‖h‖ ⊗ h, taken across tokens) scaled linearly with
‖h‖, so a stable loop with a large hidden state was rejected and an unstable one with a small
hidden state was accepted. Trajectories here have an analytically known per-step factor.
"""
import os
import sys

import numpy as np
import pytest

torch = pytest.importorskip("torch")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from cio_sde.collapse import (  # noqa: E402
    depth_contraction_stats, loop_contraction_certificate, jsrr_certificate,
)
from sigma0.loop_lm import (  # noqa: E402
    _accept_stability, _empirical_transition, _stability_gates, assemble_reason_verdict,
)


def _depth_trajectory(J, h_star, e0, steps=6):
    """h^{k+1} = h* + J(h^k − h*), the local form of the recurrent map at its fixed point."""
    e = e0.copy()
    out = [torch.tensor(h_star + e)]
    for _ in range(steps - 1):
        e = J @ e
        out.append(torch.tensor(h_star + e))
    return out


def _orthogonal(d, seed):
    Q, _ = np.linalg.qr(np.random.default_rng(seed).standard_normal((d, d)))
    return Q


@pytest.mark.parametrize("scale", [0.01, 1.0, 100.0, 1e4])
@pytest.mark.parametrize("c,expect", [(0.5, True), (0.9, True), (1.1, False), (1.5, False)])
def test_verdict_follows_the_dynamics_at_every_state_scale(c, expect, scale):
    d = 64
    Q = _orthogonal(d, 0)
    rng = np.random.default_rng(1)
    stats = []
    for _ in range(12):
        h_star = scale * rng.standard_normal(d)
        e0 = 0.1 * scale * rng.standard_normal(d)
        stats.append(depth_contraction_stats(_depth_trajectory(c * Q, h_star, e0)))
    cert = loop_contraction_certificate(stats)
    assert cert.factor == pytest.approx(c, rel=1e-6)
    assert cert.stable is expect


def test_transient_growth_is_rejected_even_with_rho_below_one():
    """The spectrum-only gate accepted this with 37,000× growth. ρ=0.9 here."""
    J = np.array([[0.9, 1000.0], [0.0, 0.9]])
    assert jsrr_certificate(torch.tensor(J)).stable is True      # the spectrum alone passes it
    # Build from the residual: rₖ₊₁ = J·rₖ, starting along the direction J amplifies.
    r, h, trajectory = np.array([0.0, 1.0]), np.zeros(2), []
    for _ in range(40):                                          # deep enough to be past the peak
        trajectory.append(torch.tensor(h.copy()))
        h, r = h + r, J @ r
    cert = loop_contraction_certificate([depth_contraction_stats(trajectory)])
    assert cert.transient > 10.0
    assert cert.stable is False and cert.regime == "transient"


def test_residual_still_growing_at_exit_is_not_contraction():
    """At depth 6 the same J is still on its way up: the residual grew on the last step, so this
    generation did not contract, whatever the spectrum says about step 400."""
    J = np.array([[0.9, 1000.0], [0.0, 0.9]])
    r, h, trajectory = np.array([0.0, 1.0]), np.zeros(2), []
    for _ in range(6):
        trajectory.append(torch.tensor(h.copy()))
        h, r = h + r, J @ r
    cert = loop_contraction_certificate([depth_contraction_stats(trajectory)])
    assert cert.factor > 1.0 and cert.regime == "divergent" and cert.stable is False


def test_converged_token_counts_as_contracting():
    h = [torch.tensor([1.0, 2.0]) for _ in range(4)]
    ratio, amp = depth_contraction_stats(h)
    assert ratio == 0.0 and amp == 1.0


def test_half_precision_noise_is_not_read_as_a_verdict():
    """float16 is the serve path's dtype. A residual at rounding level must count as converged,
    not as a ratio of noise to noise, which would read near 1 and reject a converged token."""
    h = np.random.default_rng(4).standard_normal(64) * 30.0
    noisy = [torch.tensor(h + 1e-3 * 30.0 * np.random.default_rng(i).standard_normal(64),
                          dtype=torch.float16) for i in range(5)]
    ratio, _ = depth_contraction_stats(noisy)
    assert ratio == 0.0


def test_half_precision_keeps_a_real_contraction():
    d = 64
    Q = _orthogonal(d, 5)
    rng = np.random.default_rng(6)
    h_star = 30.0 * rng.standard_normal(d)
    e0 = 3.0 * rng.standard_normal(d)
    trajectory = [t.to(torch.float16) for t in _depth_trajectory(0.6 * Q, h_star, e0, steps=4)]
    ratio, amp = depth_contraction_stats(trajectory)
    assert ratio == pytest.approx(0.6, abs=0.05)
    assert amp == pytest.approx(1.0, abs=0.05)


def test_too_few_depths_is_unknown_not_a_verdict():
    assert depth_contraction_stats([torch.zeros(2), torch.ones(2)]) is None
    assert loop_contraction_certificate([None, None]) is None


def test_outlier_token_does_not_decide_but_a_pattern_does():
    good = (0.5, 1.0)
    bad = (3.0, 3.0)
    assert loop_contraction_certificate([good] * 19 + [bad]).stable is True
    assert loop_contraction_certificate([good] * 15 + [bad] * 5).stable is False


# ── the token-transition telemetry is now scale-invariant ────────────────────────────────

@pytest.mark.parametrize("c", [0.5, 0.9, 1.1, 1.5])
def test_token_transition_operator_ignores_state_scale(c):
    d, n = 64, 16
    Q = _orthogonal(d, 2)
    h = np.random.default_rng(3).standard_normal(d)
    tr = [h]
    for _ in range(n - 1):
        tr.append(c * Q @ tr[-1])
    H = torch.tensor(np.stack(tr))
    rhos = []
    for scale in (0.01, 1.0, 100.0):
        _, reduced = _empirical_transition(scale * H)
        rhos.append(jsrr_certificate(reduced).spectral_radius)
    assert rhos[0] == pytest.approx(rhos[1], rel=1e-6)
    assert rhos[2] == pytest.approx(rhos[1], rel=1e-6)
    assert rhos[1] == pytest.approx(c, rel=0.15)                # a Ritz estimate on the Krylov space


def test_token_transition_recovers_the_operator_when_fully_observed():
    J = np.array([[0.6, 0.2, 0.0], [0.0, 0.5, 0.1], [0.0, 0.0, 0.7]])
    h = np.array([1.0, -1.0, 0.5])
    tr = [h]
    for _ in range(5):
        tr.append(J @ tr[-1])
    full, reduced = _empirical_transition(torch.tensor(np.stack(tr)))
    assert np.allclose(full.numpy(), J, atol=1e-6)
    assert jsrr_certificate(reduced).spectral_radius == pytest.approx(0.7, rel=1e-6)


def test_full_operator_is_skipped_above_the_diagnostic_cap():
    H = torch.randn(5, 16)
    full, reduced = _empirical_transition(H, max_full_dim=8)
    assert full is None and reduced.shape == (4, 4)


# ── wiring ───────────────────────────────────────────────────────────────────────────────

def test_loop_contraction_is_the_primary_verdict():
    stable_stats = [(0.5, 1.0)] * 4
    unstable_stats = [(1.4, 3.0)] * 4
    rho_says_stable = torch.diag(torch.tensor([0.5, 0.5], dtype=torch.float64))

    cert = _stability_gates(rho_says_stable, depth_stats=unstable_stats)
    assert cert["jsrr"]["stable"] is True
    assert cert["loop_contraction"]["stable"] is False
    assert _accept_stability(cert) is False
    verdict = assemble_reason_verdict({"stability_gates": cert, "stability_accepted": False})
    assert verdict["stable"] == "diverge"

    cert = _stability_gates(rho_says_stable, depth_stats=stable_stats)
    assert _accept_stability(cert) is True
    assert assemble_reason_verdict({"stability_gates": cert})["stable"] == "contract"


def test_transient_rejection_reads_as_spiral_not_divergence():
    cert = _stability_gates(torch.eye(2, dtype=torch.float64) * 0.5, depth_stats=[(0.5, 40.0)] * 4)
    assert cert["loop_contraction"]["regime"] == "transient"
    assert assemble_reason_verdict({"stability_gates": cert})["stable"] == "spiral"


def test_jsrr_remains_the_fallback_without_depth_stats():
    cert = _stability_gates(torch.diag(torch.tensor([0.5, 0.5], dtype=torch.float64)))
    assert "loop_contraction" not in cert
    assert _accept_stability(cert) is True


def test_transition_matrix_alone_can_run_the_gates_when_too_large_to_materialise():
    cert = _stability_gates(None, jsrr_matrix=torch.eye(3, dtype=torch.float64) * 0.5,
                            depth_stats=[(0.5, 1.0)] * 3)
    assert cert["jsrr"]["stable"] is True and cert["loop_contraction"]["stable"] is True
    assert "gate_lyapunov" not in cert
