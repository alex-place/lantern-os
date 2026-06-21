"""
Σ₀-K1 component 5 — provider/agent execution nodes  (#846).

Each provider/agent is wrapped as a hot-swappable ``Dynamics`` node whose ``drift``
advances exactly one reasoning step on the shared state x ∈ R^d. The wrapper here is
a *deterministic* affine node (no network I/O): for the hot-swap VM a node only needs
a drift the behaviour-preserving gate (``GraphController.hot_swap``,
``‖f_old−f_new‖/‖f_old‖ < tol``) can compare. The real per-step advance would call the
provider; that, plus the cross-provider drift-equivalence question (spec §2 / #845),
needs the live state-ABI shim (#844) + provider keys/GPU and is out of scope here.

Routing is delegated to the existing Provider-Capacity PCSF (``ProviderRegistry`` /
``get_routable_chain``): ``route_provider_nodes`` orders a set of provider nodes by the
routable chain and drops providers that are circuit-broken or quota-hit.
"""
from __future__ import annotations

from typing import Iterable, List, Optional

import torch

from .engine import LinearDynamics

Tensor = torch.Tensor


class ProviderDynamics(LinearDynamics):
    """A provider wrapped as a hot-swappable, drift-equivalence-gated graph node.

    ``f(x, u) = x Aᵀ + u Bᵀ`` — deterministic, fixed-matrix, no I/O — so two providers
    with equivalent reasoning-step behaviour produce ``drift_delta < tol`` and swap is
    accepted, while a divergent provider is rejected by the gate.
    """

    def __init__(self, provider_id: str, A: Tensor, B: Optional[Tensor] = None,
                 noise: float = 0.05) -> None:
        super().__init__(A, B=B, noise=noise)
        self.provider_id = str(provider_id)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"ProviderDynamics(provider_id={self.provider_id!r}, dim={self.dim})"


def route_provider_nodes(nodes: Iterable[ProviderDynamics], registry,
                         tier: str = "wanderer") -> List[ProviderDynamics]:
    """Order ``nodes`` by the PCSF routable chain, dropping unroutable providers.

    ``registry`` is a ``convergence_io.pcsf.ProviderRegistry`` whose
    ``get_routable_chain(tier)`` returns provider ids in routing order (circuit-broken
    and quota-hit providers already filtered out). Returns the subset of ``nodes`` whose
    ``provider_id`` is routable, ordered to match the chain.
    """
    chain = registry.get_routable_chain(tier)
    by_id = {n.provider_id: n for n in nodes}
    return [by_id[pid] for pid in chain if pid in by_id]
