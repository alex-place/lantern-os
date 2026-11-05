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
    _contraction_from_residuals, depth_contraction_stats, loop_contraction_certificate,
    jsrr_certificate,
)
import sigma0.loop_lm as loop_lm  # noqa: E402
from sigma0.loop_lm import (  # noqa: E402
    _accept_stability, _empirical_transition, _stability_gates, assemble_reason_verdict,
    sigma0_grounding_verdict,
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
    for _ in range(150):                                         # deep enough to end below where it began
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


# Residual norms from a real run, last token of 8 prompts, Ouro-1.4B-Thinking, trained depth 4,
# probed to depth 12 (lantern-os-research: data/sigma0/loop_jacobian_report.json).
REAL_OURO_RESIDUALS = [
    [27.823, 17.894, 9.792, 6.124, 5.216, 2.711, 2.648, 2.302, 2.211, 2.35, 2.066],
    [27.177, 14.189, 8.239, 4.626, 2.943, 2.667, 3.198, 5.647, 4.682, 2.26, 2.652],
    [27.313, 17.074, 11.223, 8.575, 6.451, 5.493, 5.492, 5.511, 5.644, 5.47, 5.799],
    [53.169, 21.275, 9.216, 5.907, 6.348, 5.536, 5.068, 10.048, 9.061, 5.486, 3.237],
    [21.093, 12.331, 6.68, 6.472, 6.264, 4.921, 4.118, 8.311, 7.538, 3.828, 3.272],
    [16.472, 23.204, 7.481, 4.566, 4.807, 3.205, 2.799, 2.871, 2.275, 2.482, 2.171],
    [21.146, 9.929, 6.938, 6.686, 5.922, 5.939, 5.053, 11.818, 10.016, 11.511, 11.144],
    [32.977, 9.933, 4.844, 3.763, 3.359, 3.279, 2.911, 2.617, 2.432, 2.731, 1.999],
]


def _real_ouro_at_depth(depth):
    """depth iterates give depth−1 residuals. No state norm was saved, so this assumes they sit above
    the floor: true for ‖h‖ below about 500 in float16 (see the doc)."""
    return loop_contraction_certificate(
        [_contraction_from_residuals(e[:depth - 1], 1e-6) for e in REAL_OURO_RESIDUALS])


@pytest.mark.parametrize("depth,factor", [(3, 0.873), (4, 0.750), (5, 0.670), (6, 0.753), (7, 0.938),
                                          (8, 0.917)])
def test_real_ouro_contracts_through_depth_8(depth, factor):
    """An accept here sits next to a true rho(J) of 8-11 at the same operating points, so it means
    the residual shrank on this generation. It does not mean the loop is locally stable. This table
    is in docs/SIGMA0-COLLAPSE-CERTIFICATE.md §1.2.3."""
    cert = _real_ouro_at_depth(depth)
    assert cert.factor == pytest.approx(factor, abs=0.001)
    assert cert.stable is True and cert.regime == "contraction"


@pytest.mark.parametrize("depth,factor", [(9, 1.179), (10, 1.131), (11, 1.140), (12, 1.028)])
def test_real_ouro_plateaus_from_depth_9_rather_than_diverging(depth, factor):
    """Half the tokens spike at step 8. Well below where they started, and it does not run away."""
    cert = _real_ouro_at_depth(depth)
    assert cert.factor == pytest.approx(factor, abs=0.001)
    assert cert.net_factor < 1.0
    assert cert.regime == "plateau" and cert.stable is False


def test_real_ouro_verdict_is_monotone_in_depth():
    """The single-step statistic flipped with depth: accept 3,4,5,7,10 and reject 6,8,9,11,12."""
    accepted = [d for d in range(3, 13) if _real_ouro_at_depth(d).stable]
    assert accepted == list(range(3, 9))


def test_plateau_is_unsettled_rather_than_collapsed_or_diverged():
    """Still ADR-0012's 'spiral', so the enum holds. But a plateau keeps moving: it did not freeze."""
    gates = _stability_gates(torch.eye(2, dtype=torch.float64) * 0.5, depth_stats=[(1.05, 0.9, 1.0)] * 4)
    assert gates["loop_contraction"]["regime"] == "plateau"
    verdict = assemble_reason_verdict({"stability_gates": gates})
    assert verdict["stable"] == "spiral" and verdict["reason"] == "max_depth"
    assert sigma0_grounding_verdict({"stability_gates": gates})["klass"] == "unsettled"


def test_transient_is_not_called_a_collapse():
    gates = _stability_gates(None, depth_stats=[(0.5, 0.5, 40.0)] * 4)
    verdict = assemble_reason_verdict({"stability_gates": gates})
    assert verdict["stable"] == "spiral" and verdict["reason"] == "divergence"
    assert sigma0_grounding_verdict({"stability_gates": gates})["klass"] == "unsettled"


# ── one step must not decide: pinned false accepts from the independent review ─────────────────────

def _regime(residuals, tokens=8):
    cert = loop_contraction_certificate([_contraction_from_residuals(residuals, 1e-9)] * tokens)
    return cert.regime, cert.stable


def _iterate(J, h0, steps):
    hs = [h0]
    for _ in range(steps - 1):
        hs.append(J @ hs[-1])
    return hs


@pytest.mark.parametrize("a", [2.0, 2.5, 3.0, 5.0])
@pytest.mark.parametrize("steps", [4, 5, 6, 7, 8, 11])
@pytest.mark.parametrize("h0", [(1.0, 1.0), (1.0, 0.3), (0.3, 1.0)])
def test_a_map_that_does_not_contract_is_rejected_whichever_step_the_loop_stops_on(a, steps, h0):
    """J² = (a/2)·I, so ρ(J) ≥ 1 for every a here. The residual alternates high and low, and a
    last-step ratio accepted whenever the loop stopped on a low step: at depth 4, a ratio of 0.56."""
    J = torch.tensor([[0.0, a], [0.5, 0.0]], dtype=torch.float64)
    trajectory = _iterate(J, torch.tensor(h0, dtype=torch.float64), steps)
    assert loop_contraction_certificate([depth_contraction_stats(trajectory)] * 8).stable is False


def _from_residual(J, e0, iterates):
    """A trajectory of h ↦ J·h whose first residual is e0 (fixed point at 0)."""
    h = torch.linalg.solve(J - torch.eye(2, dtype=J.dtype), e0)
    return _iterate(J, h, iterates)


@pytest.mark.parametrize("a,b", [(2.5, 0.5), (2.8, 0.5), (5.63, 0.3), (100.0, 0.1)])
@pytest.mark.parametrize("iterates", [4, 5, 6, 7, 11])
def test_a_period_2_map_cannot_hide_on_its_low_phase(a, b, iterates):
    """Starting on the high phase, a window over the raw residuals ends on a low one, and the first
    version of this statistic accepted ρ=1.118 at seven iterates. The pairwise envelope does not."""
    J = torch.tensor([[0.0, a], [b, 0.0]], dtype=torch.float64)
    stats = depth_contraction_stats(_from_residual(J, torch.tensor([1.0, 0.0], dtype=torch.float64), iterates))
    assert stats[0] >= 1.0
    assert loop_contraction_certificate([stats] * 8).stable is False


def test_at_three_iterates_one_ratio_still_decides():
    """The documented limit: two residuals leave no pair for the envelope, so ρ=3.16 passes."""
    J = torch.tensor([[0.0, 100.0], [0.1, 0.0]], dtype=torch.float64)
    stats = depth_contraction_stats(_from_residual(J, torch.tensor([1.0, 0.0], dtype=torch.float64), 3))
    assert loop_contraction_certificate([stats] * 8).stable is True


def test_a_dip_followed_by_growth_is_rejected():
    assert _regime([100.0, 0.01, 1.0, 10.0, 9.0]) == ("divergent", False)


def test_growth_after_a_drop_is_divergence_not_a_plateau():
    """The residual ends below where it began, which the old rule read as settled."""
    assert _regime([30.0, 3.0, 6.0, 12.0, 24.0]) == ("divergent", False)


@pytest.mark.parametrize("residuals", [[5.0] * 5, [30.0, 3.0, 3.0, 3.0, 3.0], [5.0, 5.1, 4.9, 5.1, 5.0]])
def test_a_flat_residual_is_a_plateau(residuals):
    assert _regime(residuals) == ("plateau", False)


def test_a_residual_drifting_down_slowly_needs_a_margin_to_be_refused():
    """Its envelope falls 0.3% per step. At margin 0, STARS' literal ρ<1, that reads as contraction;
    demanding a margin is how to refuse it."""
    stats = [_contraction_from_residuals([5.0, 5.1, 4.9, 5.05, 5.02], 1e-9)] * 8
    assert loop_contraction_certificate(stats).stable is True
    refused = loop_contraction_certificate(stats, margin=0.05)
    assert refused.stable is False and refused.regime == "critical"


def test_steady_slow_growth_is_divergence_not_a_plateau():
    assert _regime([1.1 ** k for k in range(6)]) == ("divergent", False)


# ── non-finite iterates ─────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("dtype", [torch.float64, torch.float32, torch.float16])
@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
@pytest.mark.parametrize("first_bad", [0, 2])
def test_non_finite_iterates_are_divergent_never_accepted(dtype, bad, first_bad):
    """These used to read (0.0, 1.0), or factor NaN, and both passed: stable=True on a blown-up loop."""
    h = torch.ones(16, dtype=dtype)
    trajectory = [h * (bad if k >= first_bad else 1.0 + 0.1 * k) for k in range(4)]
    stats = depth_contraction_stats(trajectory)
    assert stats == (float("inf"), float("inf"), float("inf"))
    cert = loop_contraction_certificate([stats])
    assert cert.regime == "divergent" and cert.stable is False


def test_one_non_finite_token_rejects_the_generation():
    """The 90th percentile lets one odd token through. An overflow is not an odd token."""
    good = (0.5, 0.5, 1.0)
    bad = (float("inf"), float("inf"), float("inf"))
    cert = loop_contraction_certificate([good] * 99 + [bad])
    assert cert.stable is False and cert.regime == "divergent"
    gates = _stability_gates(None, depth_stats=[good] * 99 + [bad])
    assert gates["loop_contraction"]["factor"] is None           # JSON-safe, like every other inf
    assert _accept_stability(gates) is False
    assert assemble_reason_verdict({"stability_gates": gates})["stable"] == "diverge"


# ── the numerical floor ─────────────────────────────────────────────────────────────────────────

def _along(residuals, h_norm, dtype, d=64):
    rng = np.random.default_rng(0)
    h = rng.standard_normal(d)
    h = h_norm * h / np.linalg.norm(h)
    v = rng.standard_normal(d)
    v = v / np.linalg.norm(v)
    out = [torch.tensor(h, dtype=dtype)]
    for r in residuals:
        h = h + r * v
        out.append(torch.tensor(h, dtype=dtype))
    return out


@pytest.mark.parametrize("residuals,h_norm", [([0.5, 1.0, 2.0, 4.0, 7.0], 900.0), ([1.0, 2.0, 3.5], 500.0)])
def test_growth_that_ends_near_the_old_floor_is_seen(residuals, h_norm):
    """At 8 machine epsilons these all sat under the float16 floor and read as converged."""
    assert loop_contraction_certificate(
        [depth_contraction_stats(_along(residuals, h_norm, torch.float16))]).stable is False


def test_growth_starting_below_the_noise_floor_is_seen():
    """The first residual is under float16's floor at this ‖h‖, which used to end the measurement
    and report a loop that grows 16× as converged."""
    stats = depth_contraction_stats(_along([0.5, 1.0, 2.0, 4.0, 8.0], 100.0, torch.float16))
    assert stats[0] > 1.0
    assert loop_contraction_certificate([stats]).regime == "divergent"


def test_a_float16_state_whose_norm_float16_cannot_represent_still_reads_correctly():
    """Every entry fits in float16. The norm, 80000, does not, and would read as infinite."""
    trajectory = _along([30000.0, 15000.0, 7500.0, 3750.0], 80000.0, torch.float16)
    assert torch.isfinite(trajectory[0]).all()
    assert float(trajectory[0].norm()) == float("inf")           # the trap this guards against
    ratio, net, rise = depth_contraction_stats(trajectory)
    assert ratio == pytest.approx(0.5, abs=0.05) and rise == pytest.approx(1.0, abs=0.05)


def test_converged_token_counts_as_contracting():
    h = [torch.tensor([1.0, 2.0]) for _ in range(4)]
    ratio, net, rise = depth_contraction_stats(h)
    assert ratio == 0.0 and net == 0.0 and rise == 1.0


def test_half_precision_noise_is_not_read_as_a_verdict():
    """float16 is the serve path's dtype. A residual at rounding level must count as converged,
    not as a ratio of noise to noise, which would read near 1 and reject a converged token."""
    h = np.random.default_rng(4).standard_normal(64) * 30.0
    noisy = [torch.tensor(h + 1e-3 * 30.0 * np.random.default_rng(i).standard_normal(64),
                          dtype=torch.float16) for i in range(5)]
    ratio, _, _ = depth_contraction_stats(noisy)
    assert ratio == 0.0


def test_half_precision_keeps_a_real_contraction():
    d = 64
    Q = _orthogonal(d, 5)
    rng = np.random.default_rng(6)
    h_star = 30.0 * rng.standard_normal(d)
    e0 = 3.0 * rng.standard_normal(d)
    trajectory = [t.to(torch.float16) for t in _depth_trajectory(0.6 * Q, h_star, e0, steps=4)]
    ratio, _, rise = depth_contraction_stats(trajectory)
    assert ratio == pytest.approx(0.6, abs=0.05)
    assert rise == pytest.approx(1.0, abs=0.05)


def test_too_few_depths_is_unknown_not_a_verdict():
    assert depth_contraction_stats([torch.zeros(2), torch.ones(2)]) is None
    assert loop_contraction_certificate([None, None]) is None


def test_outlier_token_does_not_decide_but_a_pattern_does():
    good = (0.5, 0.5, 1.0)
    bad = (3.0, 3.0, 3.0)
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
    stable_stats = [(0.5, 0.5, 1.0)] * 4
    unstable_stats = [(1.4, 1.4, 3.0)] * 4
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
    cert = _stability_gates(torch.eye(2, dtype=torch.float64) * 0.5, depth_stats=[(0.5, 0.5, 40.0)] * 4)
    assert cert["loop_contraction"]["regime"] == "transient"
    assert assemble_reason_verdict({"stability_gates": cert})["stable"] == "spiral"


def test_jsrr_remains_the_fallback_without_depth_stats():
    cert = _stability_gates(torch.diag(torch.tensor([0.5, 0.5], dtype=torch.float64)))
    assert "loop_contraction" not in cert
    assert _accept_stability(cert) is True


def test_transition_matrix_alone_can_run_the_gates_when_too_large_to_materialise():
    cert = _stability_gates(None, jsrr_matrix=torch.eye(3, dtype=torch.float64) * 0.5,
                            depth_stats=[(0.5, 0.5, 1.0)] * 3)
    assert cert["jsrr"]["stable"] is True and cert["loop_contraction"]["stable"] is True
    assert "gate_lyapunov" not in cert


def test_discrete_dichotomy_is_skipped_above_its_cap(monkeypatch):
    """It costs 5s at d=128 and 80s at d=512: a diagnostic must not take that on the serve path."""
    monkeypatch.setattr(loop_lm, "_DICHOTOMY_MAX_DIM", 2)
    cert = _stability_gates(torch.eye(4, dtype=torch.float64) * 0.5, depth_stats=[(0.5, 0.5, 1.0)])
    assert "dichotomy" not in cert and "gate_lyapunov" in cert
    monkeypatch.setattr(loop_lm, "_DICHOTOMY_MAX_DIM", 4)
    assert _stability_gates(torch.eye(4, dtype=torch.float64) * 0.5)["dichotomy"]["fate"] == "COLLAPSE"


# ── generate() end to end, on a stub backbone: the wiring, not a model ──────────────────────────

class _StubCore:
    """Yields a scripted list of per-depth hidden states for each token."""

    def __init__(self, depths, d=64, exit_logit=10.0):
        self.depths, self.d, self.exit_logit, self.t = depths, d, exit_logit, 0

    def __call__(self, input_ids=None, past_key_values=None, use_cache=False):
        seq = input_ids.shape[1]
        rng = torch.Generator().manual_seed(self.t)
        hs = self.depths(self.d, rng)
        self.t += 1
        hidden = []
        for h in hs:
            full = torch.zeros(1, seq, self.d, dtype=torch.float16)
            full[0, -1, :] = h.to(torch.float16)
            hidden.append(full)
        return type("Out", (), {"past_key_values": None})(), hidden, [
            torch.full((1, seq, 1), self.exit_logit) for _ in hs]


class _StubTok:
    eos_token_id = 0

    def __call__(self, text, return_tensors=None):
        return type("Ids", (), {"input_ids": torch.tensor([[5, 6, 7]])})()

    def decode(self, ids, skip_special_tokens=True):
        return "x" * int(ids.numel())


class _StubBackbone:
    device = "cpu"

    def __init__(self, core, vocab=32):
        self.model, self.vocab, self.calls = core, vocab, 0

    def lm_head(self, hidden):
        self.calls += 1
        logits = torch.zeros(1, 1, self.vocab)
        logits[0, 0, 1 + self.calls % (self.vocab - 1)] = 1.0     # never EOS
        return logits


def _point(d, rng, scale=30.0):
    v = torch.randn(d, generator=rng)
    return scale * v / v.norm()


def _contracting(d, rng):
    h, v = _point(d, rng), _point(d, rng, 1.0)
    return [h, h + 6.0 * v, h + 9.0 * v, h + 10.5 * v]


def _growing(d, rng):
    h, v = _point(d, rng), _point(d, rng, 1.0)
    return [h, h + 2.0 * v, h + 8.0 * v, h + 26.0 * v]


def _blows_up(value):
    def depths(d, rng):
        h = _point(d, rng)
        return [h, h + 1.0, h * value, h * value]
    return depths


def _too_deep_for_float16(d, rng):
    h, v = _point(d, rng), _point(d, rng, 1.0)
    return [h, h + 30.0 * v, h + 3000.0 * v, h + 300000.0 * v.clamp(-0.1, 0.1)]


def _run_generate(depths, monkeypatch, tokens=12, **kwargs):
    monkeypatch.setattr(loop_lm, "_lazy", lambda: (torch, None, None))
    lm = loop_lm.Sigma0LoopLM(model=_StubBackbone(_StubCore(depths)), tok=_StubTok(), max_steps=4)
    return lm.generate("hi", max_new_tokens=tokens, canary=False, mode="qexit", q=0.5, **kwargs)


def test_generate_accepts_a_contracting_loop(monkeypatch):
    out = _run_generate(_contracting, monkeypatch)
    assert out["stability_accepted"] is True
    assert out["stability_gates"]["loop_contraction"]["factor"] == pytest.approx(0.5, abs=0.02)
    assert out["reason_verdict"]["stable"] == "contract"


def test_generate_rejects_a_growing_loop(monkeypatch):
    out = _run_generate(_growing, monkeypatch)
    assert out["stability_accepted"] is False
    assert out["reason_verdict"]["stable"] == "diverge"


@pytest.mark.parametrize("depths", [_blows_up(float("inf")), _blows_up(float("nan")), _too_deep_for_float16])
def test_generate_rejects_a_loop_that_blew_up_even_if_it_exited_early(depths, monkeypatch):
    """Q-exit stops at depth 1 here, so the text came from a finite state. The deeper iterates still
    show what the loop was doing, and they all used to pass."""
    out = _run_generate(depths, monkeypatch)
    assert out["mean_depth"] == 1.0
    assert out["stability_accepted"] is False
    assert out["reason_verdict"]["stable"] == "diverge"


def test_generate_keeps_its_verdict_when_the_token_operator_cannot_be_fitted(monkeypatch):
    """The SVD refuses non-finite tokens. That used to erase the per-token verdict with it, turning
    a measured rejection into 'no certificate'."""
    monkeypatch.setattr(loop_lm, "_empirical_transition",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("svd refused")))
    out = _run_generate(_growing, monkeypatch)
    assert out["stability_accepted"] is False
    assert "jsrr" not in out["stability_gates"]


def test_one_token_still_gets_its_measured_verdict(monkeypatch):
    out = _run_generate(_growing, monkeypatch, tokens=1)
    assert out["stability_accepted"] is False
