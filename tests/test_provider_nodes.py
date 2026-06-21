"""Tests for Σ₀-K1 provider execution nodes — issue #846 (component 5).

Synthetic only: ProviderDynamics drift is a fixed affine map, so the existing
behaviour-preserving hot-swap gate (Gate E) accepts an equivalent provider and
rejects a divergent one with no network/GPU. The live cross-provider
drift-equivalence question (#845) and the Ouro state-ABI (#844) are out of scope.
"""
import pytest

try:
    import torch
except (ImportError, OSError):
    pytest.skip("torch unavailable (DLL or import error)", allow_module_level=True)

from src.cio_sde import CIO_SDE, ProviderDynamics, route_provider_nodes


def _model():
    torch.manual_seed(0)
    return CIO_SDE(dim=4, ctrl_dim=2, hidden=16)


def _state(b=8, dim=4):
    x0 = torch.randn(b, dim)
    s0 = torch.eye(dim).expand(b, dim, dim).clone()
    return x0, s0


@pytest.mark.synthetic
def test_hot_swap_accepts_equivalent_provider():
    m = _model()
    x0, s0 = _state()
    A = torch.eye(4) * 0.5
    B = torch.zeros(4, 2)
    m.graph.active = ProviderDynamics("alpha", A.clone(), B.clone())   # deterministic active node
    twin = ProviderDynamics("alpha-mirror", A.clone(), B.clone())      # behaviourally identical
    u = m.pcsf(x0, s0)
    rec = m.graph.hot_swap(twin, x0, u, step=0)
    assert rec.accepted
    assert rec.drift_delta < 1e-5
    assert m.graph.active is twin


@pytest.mark.synthetic
def test_hot_swap_rejects_divergent_provider():
    m = _model()
    x0, s0 = _state()
    B = torch.zeros(4, 2)
    A = torch.eye(4) * 0.5
    m.graph.active = ProviderDynamics("alpha", A.clone(), B.clone())
    original = m.graph.active
    stranger = ProviderDynamics("beta", torch.eye(4) * -3.0, B.clone())   # very different spectrum
    u = m.pcsf(x0, s0)
    rec = m.graph.hot_swap(stranger, x0, u, step=0)
    assert not rec.accepted
    assert rec.drift_delta >= m.graph.tol
    assert m.graph.active is original                                  # unchanged on reject


@pytest.mark.synthetic
def test_provider_node_advances_state_via_rollout():
    # A provider node can drive the SDE rollout (it IS the execution node).
    from src.cio_sde import rollout
    m = _model()
    x0, s0 = _state()
    m.graph.active = ProviderDynamics("alpha", torch.eye(4) * 0.9, torch.zeros(4, 2))
    xf, sf, tr = rollout(m, x0, s0, steps=5)
    assert xf.shape == x0.shape
    assert len(tr.steps) == 5


@pytest.mark.synthetic
def test_routing_drops_quota_hit_provider():
    pcsf = pytest.importorskip("src.convergence_io.pcsf")
    reg = pcsf.ProviderRegistry()
    reg.register("alpha")
    reg.register("beta")
    reg.register("gamma")
    # fresh providers default to UNAVAILABLE; a success marks them routable.
    for pid in ("alpha", "beta", "gamma"):
        reg.record_success(pid, 100.0)
    nodes = [
        ProviderDynamics("alpha", torch.eye(4) * 0.5),
        ProviderDynamics("beta", torch.eye(4) * 0.5),
        ProviderDynamics("gamma", torch.eye(4) * 0.5),
    ]
    # all routable initially
    assert [n.provider_id for n in route_provider_nodes(nodes, reg)] == ["alpha", "beta", "gamma"]
    # quota-hit beta is routed around
    reg.record_quota_hit("beta")
    routed = route_provider_nodes(nodes, reg)
    assert [n.provider_id for n in routed] == ["alpha", "gamma"]
    assert all(isinstance(n, ProviderDynamics) for n in routed)
