"""
Σ₀-K1 component 5 — wrap a provider/agent as a hot-swappable `Dynamics` node.

Each provider becomes one execution-graph node whose `drift(x, u)` advances ONE reasoning
step on the shared state x ∈ Rᵈ (the state ABI, component 6). Because every node speaks the
same d-dim ABI, `GraphController.hot_swap` ([cio_sde/engine.py]) can route around an
unavailable/expensive provider with a drift-EQUIVALENT one (‖f_old−f_new‖/‖f_old‖ < tol).

Two ways to build a node:

  * `ProviderDynamics(dim, ctrl_dim, drift_fn)` — `drift_fn(x, u) -> f ∈ Rᵈ` is the
    reasoning velocity in state space. Use a deterministic mock for tests/cheap nodes.

  * `ProviderDynamics.from_text_provider(dim, ctrl_dim, abi, decode_fn, provider_call,
    encode_fn)` — the LIVE wrapper. One reasoning step is:
        h_in   = abi.psi(x)            # x → decode-context hidden  (ψ)
        prompt = decode_fn(h_in, u)    # hidden → prompt text
        reply  = provider_call(prompt) # the actual provider (LLM/agent) call
        h_out  = encode_fn(reply)      # reply → hidden
        x_next = abi.phi(h_out)        # hidden → x'                (φ)
        f      = x_next − x            # drift = the step's displacement
    This needs a live model+provider (network/cost), so it is exercised by #843/#845,
    not unit tests. The node abstraction + the drift-equivalence gate are tested here.

Boundary (spec §2): hot-swap is swap-for-availability/cost (behaviour-PRESERVING), not
swap-for-diversity. Whether any two REAL providers are drift-equivalent on x is the open
question #845 measures empirically using these nodes.
"""
from __future__ import annotations

from typing import Callable, Optional

import torch

from cio_sde.engine import Dynamics

Tensor = torch.Tensor
DriftFn = Callable[[Tensor, Tensor], Tensor]


class ProviderDynamics(Dynamics):
    """A graph node backed by a provider's reasoning step. Implements the `Dynamics`
    interface (`drift`, `diffusion`) so it hot-swaps like any other node."""

    def __init__(self, dim: int, ctrl_dim: int, drift_fn: DriftFn,
                 provider_id: str = "provider", noise: float = 0.02) -> None:
        super().__init__(dim, ctrl_dim, hidden=1)   # base nets unused (tiny)
        self.provider_id = provider_id
        self._drift_fn = drift_fn
        self._noise = float(noise)

    def drift(self, x: Tensor, u: Tensor) -> Tensor:
        f = self._drift_fn(x, u)
        if f.shape != x.shape:
            raise ValueError(f"drift_fn returned {tuple(f.shape)}, expected {tuple(x.shape)}")
        return f

    def diffusion(self, x: Tensor) -> Tensor:
        # Providers are ~deterministic per call; a small constant exploration gain.
        return torch.full_like(x, self._noise)

    # ── live wrapper: provider operating in TEXT space via the φ/ψ ABI ─────────
    @classmethod
    def from_text_provider(cls, dim: int, ctrl_dim: int, abi,
                           decode_fn: Callable[[Tensor, Tensor], str],
                           provider_call: Callable[[str], str],
                           encode_fn: Callable[[str], Tensor],
                           provider_id: str = "provider", noise: float = 0.02
                           ) -> "ProviderDynamics":
        """Build a node whose drift is one real provider reasoning step, mapped through
        the state ABI. `abi` is the component-6 shim (e.g. StateABIShim) exposing
        `.phi`=encode (h→x) and `.psi`=decode (x→h). Per-sample over the batch."""
        def drift_fn(x: Tensor, u: Tensor) -> Tensor:
            outs = []
            for i in range(x.shape[0]):
                h_in = abi.psi(x[i])
                prompt = decode_fn(h_in, u[i])
                reply = provider_call(prompt)
                x_next = abi.phi(encode_fn(reply))
                outs.append(x_next - x[i])
            return torch.stack(outs, dim=0)
        return cls(dim, ctrl_dim, drift_fn, provider_id=provider_id, noise=noise)


def mock_linear_provider(dim: int, ctrl_dim: int, *, scale: float = 1.0,
                         seed: int = 0, provider_id: str = "mock") -> ProviderDynamics:
    """A deterministic, seeded provider node for tests/cheap fallbacks: f = (x·Aᵀ + u·Bᵀ)·scale
    with fixed A, B. Two mocks with the same A/B (any scale within tol) are drift-equivalent;
    different A/B are not — exactly the property the hot-swap gate checks."""
    g = torch.Generator().manual_seed(seed)
    A = torch.randn(dim, dim, generator=g) / (dim ** 0.5)
    B = torch.randn(dim, ctrl_dim, generator=g) / (ctrl_dim ** 0.5)

    def drift_fn(x: Tensor, u: Tensor) -> Tensor:
        return (x @ A.T + u @ B.T) * scale

    return ProviderDynamics(dim, ctrl_dim, drift_fn, provider_id=provider_id)
