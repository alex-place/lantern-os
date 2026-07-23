"""P0 gate low-rank reduction — the (2048,2048) empirical Jacobian's ρ is computed EXACTLY from a
(T-1,T-1) Gram (loop_lm.generate), so the JSRR acceptance gate is cheap on the serve path.

These tests prove the reduction changes NO accept/reject decision and that d=2048 is fast (no full
eigvals, no 2GB broadcast). Zero-dep, no model. Run:
  python -m pytest tests/test_sigma0_jsrr_reduction.py -q
"""
import time
import numpy as np
import pytest
torch = pytest.importorskip("torch")   # CI has no GPU deps — skip this suite there (runs locally)
from cio_sde.collapse import jsrr_certificate
from sigma0.loop_lm import _stability_gates, _CONT_GATE_MAX_DIM


def _emp_and_reduced(d, T, seed=0, scale=1.0):
    """Reproduce loop_lm's construction cheaply (matmul, no (T-1,d,d) broadcast)."""
    rng = np.random.RandomState(seed)
    H = scale * rng.randn(T, d)
    dH = H[1:] - H[:-1]
    norms = np.linalg.norm(H[:-1], axis=-1, keepdims=True).clip(1e-9)
    dHn = dH / norms
    Hprev = H[:-1]
    Tm1 = max(T - 1, 1)
    A_emp = (dHn.T @ Hprev) / Tm1            # (d, d) full Jacobian
    G = (Hprev @ dHn.T) / Tm1                # (T-1, T-1) reduced Gram — same nonzero spectrum
    return torch.tensor(A_emp), torch.tensor(G)


def test_reduction_preserves_rho_and_verdict():
    """ρ(reduced) == ρ(full) to machine precision, and the accept verdict is identical —
    across scales that straddle the ρ<1 boundary. (d kept ≤512 so the full eigvals is fast.)"""
    for d, T in [(512, 64), (256, 200), (128, 50)]:
        for scale in (0.3, 0.7, 1.0, 1.5):
            A, G = _emp_and_reduced(d, T, scale=scale)
            ja = jsrr_certificate(A, margin=0.05)
            jg = jsrr_certificate(G, margin=0.05)
            assert abs(ja.spectral_radius - jg.spectral_radius) < 1e-6, (d, T, scale, ja.spectral_radius, jg.spectral_radius)
            assert ja.stable == jg.stable, (d, T, scale)


def test_stability_gates_reduced_matches_full_accept():
    """_stability_gates(A, jsrr_matrix=G) yields the same JSRR verdict as the full path,
    at a dim where the continuous diagnostics also run (so both dict shapes are exercised)."""
    A, G = _emp_and_reduced(256, 50, scale=0.9)
    full = _stability_gates(A)                       # legacy call: JSRR on the full A
    red = _stability_gates(A, jsrr_matrix=G)         # new call: JSRR on the reduced G
    assert full is not None and red is not None
    assert full["jsrr"]["stable"] == red["jsrr"]["stable"]
    assert abs(full["jsrr"]["spectral_radius"] - red["jsrr"]["spectral_radius"]) < 1e-4
    assert "proven_contracting" in red              # d=256 ≤ cap → continuous diagnostics ran


def test_full_hidden_dim_is_fast_and_exact():
    """At d=2048 (Ouro hidden size) the reduced path must be sub-second and skip the O(d³)
    continuous gates, while JSRR stays exact. This is the load-bearing serve-path guarantee."""
    assert _CONT_GATE_MAX_DIM < 2048
    A, G = _emp_and_reduced(2048, 64, scale=0.8)
    t0 = time.perf_counter()
    red = _stability_gates(A, jsrr_matrix=G)
    dt = time.perf_counter() - t0
    assert dt < 1.0, f"reduced gate took {dt:.2f}s at d=2048 — expected sub-second"
    assert red is not None and red["jsrr"] is not None      # JSRR ran (exact, from the reduced G)
    assert "proven_contracting" not in red                  # continuous diagnostics skipped at d>cap
    # exactness: the reported ρ equals an independent reduced-Gram computation. The stored value
    # is round(x, 4) via _finite, so compare within the 4-decimal quantisation (the reduction
    # itself is exact to machine precision — see test_reduction_preserves_rho_and_verdict at 1e-6).
    rho_indep = float(np.abs(np.linalg.eigvals(G.numpy())).max())
    assert abs(red["jsrr"]["spectral_radius"] - rho_indep) < 1e-3
