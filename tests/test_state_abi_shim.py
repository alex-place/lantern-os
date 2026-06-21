"""Tests for the Σ₀-K1 state-ABI shim φ/ψ — issue #844.

Synthetic only: exercises the shim on random hidden tensors (no live Ouro / GPU).
The "no decode-quality regression vs raw Ouro on Gate A" acceptance is a live
served-kernel measurement and is out of scope here.
"""
import pytest

torch = pytest.importorskip("torch")

from src.sigma0.state_abi import StateABIShim
from src.cio_sde import CIO_SDE, rollout

H = 2048   # Ouro-1.4B last-layer hidden size (the (H,) exit-depth vector)
D = 128    # state-ABI dim d ∈ [64, 256]


@pytest.mark.synthetic
def test_phi_shape_and_feeds_state_vm():
    shim = StateABIShim(hidden_dim=H, state_dim=D, seed=0)
    B = 8
    h = torch.randn(B, H)
    x = shim.encode(h)
    assert x.shape == (B, D)
    # x must be a valid seed for the CIO_SDE state VM (dim=D) — a rollout runs.
    m = CIO_SDE(dim=D, ctrl_dim=2, hidden=16)
    s0 = torch.eye(D).expand(B, D, D).clone()
    xf, sf, tr = rollout(m, x, s0, steps=3)
    assert xf.shape == (B, D)
    assert len(tr.steps) == 3


@pytest.mark.synthetic
def test_state_dim_bounds_enforced():
    with pytest.raises(ValueError):
        StateABIShim(hidden_dim=H, state_dim=32)    # < 64
    with pytest.raises(ValueError):
        StateABIShim(hidden_dim=H, state_dim=512)   # > 256
    StateABIShim(hidden_dim=H, state_dim=64)        # bounds are inclusive
    StateABIShim(hidden_dim=H, state_dim=256)


@pytest.mark.synthetic
def test_determinism_same_seed():
    h = torch.randn(4, H)
    a = StateABIShim(hidden_dim=H, state_dim=D, seed=7)
    b = StateABIShim(hidden_dim=H, state_dim=D, seed=7)
    assert torch.allclose(a.encode(h), b.encode(h))   # same seed → identical φ
    assert torch.allclose(a.encode(h), a.encode(h))   # forward is deterministic


@pytest.mark.synthetic
def test_round_trip_shape_and_learns():
    shim = StateABIShim(hidden_dim=H, state_dim=D, seed=0)
    h = torch.randn(16, H)
    assert shim.round_trip(h).shape == h.shape   # ψ(φ(h)) lands back in R^H

    loss_fn = torch.nn.MSELoss()
    opt = torch.optim.Adam(shim.parameters(), lr=1e-2)
    init = loss_fn(shim.round_trip(h), h).item()
    for _ in range(100):
        opt.zero_grad()
        loss = loss_fn(shim.round_trip(h), h)
        loss.backward()
        opt.step()
    final = loss_fn(shim.round_trip(h), h).item()
    # Lossy d<H bottleneck — not zero, but ψ∘φ must learn to reconstruct.
    assert final < init


@pytest.mark.synthetic
def test_batch_and_rank_invariance():
    shim = StateABIShim(hidden_dim=H, state_dim=D, seed=1)
    h = torch.randn(5, H)
    assert shim.encode(h[0]).shape == (D,)          # unbatched (H,) → (d,)
    h3 = torch.randn(2, 3, H)
    assert shim.encode(h3).shape == (2, 3, D)        # rank-3 (B,T,H) → (B,T,d)
    # per-row result is independent of batching (LayerNorm is per-row over H)
    assert torch.allclose(shim.encode(h)[0], shim.encode(h[0]), atol=1e-6)
