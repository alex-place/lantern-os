"""Tests for the Σ₀-K1 provider Dynamics node (component 5, #846)."""
import pytest

torch = pytest.importorskip("torch")

from cio_sde.engine import CIO_SDE, GraphController, rollout
from sigma0.provider_node import ProviderDynamics, mock_linear_provider
from sigma0.state_abi import StateABIShim   # the merged #844 shim (.phi=encode, .psi=decode)


DIM, CTRL = 16, 3


def test_node_implements_dynamics_interface():
    node = mock_linear_provider(DIM, CTRL, seed=0)
    x = torch.randn(4, DIM)
    u = torch.randn(4, CTRL)
    f = node.drift(x, u)
    g = node.diffusion(x)
    assert f.shape == x.shape
    assert g.shape == x.shape
    assert (g >= 0).all()              # diffusion gain must be non-negative


def test_hot_swap_accepts_drift_equivalent_provider():
    base = mock_linear_provider(DIM, CTRL, seed=0, scale=1.0)
    equiv = mock_linear_provider(DIM, CTRL, seed=0, scale=1.05)   # same A/B, +5% < tol 0.25
    gc = GraphController(base, equivalence_tol=0.25)
    x, u = torch.randn(8, DIM), torch.randn(8, CTRL)
    rec = gc.hot_swap(equiv, x, u, step=0)
    assert rec.accepted and rec.drift_delta < 0.25
    assert gc.active is equiv


def test_hot_swap_rejects_divergent_provider():
    base = mock_linear_provider(DIM, CTRL, seed=0)
    stranger = mock_linear_provider(DIM, CTRL, seed=99)          # different A/B
    gc = GraphController(base, equivalence_tol=0.25)
    x, u = torch.randn(8, DIM), torch.randn(8, CTRL)
    rec = gc.hot_swap(stranger, x, u, step=0)
    assert not rec.accepted and rec.drift_delta >= 0.25
    assert gc.active is base                                     # unchanged


def test_from_text_provider_runs_through_abi():
    abi = StateABIShim(hidden_dim=128, state_dim=64, seed=0)
    calls = {"n": 0}

    def decode_fn(h, u):
        return "prompt"

    def provider_call(prompt):
        calls["n"] += 1
        return "reply text"

    def encode_fn(reply):
        # deterministic hidden derived from the reply length
        return torch.full((128,), float(len(reply)) * 0.01)

    node = ProviderDynamics.from_text_provider(
        64, CTRL, abi, decode_fn, provider_call, encode_fn, provider_id="mock-llm")
    x = torch.randn(2, 64)
    u = torch.randn(2, CTRL)
    f = node.drift(x, u)
    assert f.shape == x.shape
    assert calls["n"] == 2              # one provider call per batch element


def test_provider_node_swaps_in_a_rollout():
    torch.manual_seed(0)
    m = CIO_SDE(dim=DIM, ctrl_dim=CTRL, hidden=16)
    prov = mock_linear_provider(DIM, CTRL, seed=2)
    x0 = torch.randn(1, DIM)
    sigma0 = torch.eye(DIM).unsqueeze(0)
    _xf, _sf, trace = rollout(m, x0, sigma0, steps=10, base_seed=0, swap_schedule={3: prov})
    assert len(trace.swaps) == 1
    assert trace.swaps[0].step == 3
