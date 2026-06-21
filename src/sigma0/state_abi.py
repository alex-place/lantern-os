"""
Σ₀-K1 component 6 — the state-ABI shim φ / ψ  (#844, the named kernel blocker).

The kernel's hot-swap VM operates on a portable state vector x ∈ R^d
(``CIO_SDE(dim=d)``). Ouro's reasoning loop instead carries weight-tied,
last-layer hidden vectors h ∈ R^H taken at its Q-exit / converge exit depth
(``loop_lm.py``: ``hidden = hidden_states_list[step-1][:, -1:, :]`` → detached to
shape ``(H,)``). Those raw tensors are NOT a shared ABI across providers — which
is exactly why this projection shim is the spec's "one true blocker" (component 6,
``docs/SIGMA0-K1-KERNEL-SPEC.md`` §4.2).

    φ:  h ∈ R^H  →  x ∈ R^d      project the exit-depth hidden onto the d-dim state ABI
    ψ:  x ∈ R^d  →  ĥ ∈ R^H      learned readout back to a decode-context vector

``d ∈ [64, 256]`` per the spec. This module is the *structural* shim plus a
round-trip; the issue's "no decode-quality regression vs raw Ouro on Gate A"
acceptance is a live-Ouro measurement (the served kernel scored by
``eval_keystone.py`` over the 65-prompt golden set, with vs. without the shim) and
needs a GPU + a running kernel, so it is out of scope for the unit tests here.
"""
from __future__ import annotations

from typing import Optional

import torch
from torch import nn

Tensor = torch.Tensor


class StateABIShim(nn.Module):
    """Projection shim between an Ouro exit-depth hidden (R^H) and the state ABI (R^d)."""

    def __init__(self, hidden_dim: int, state_dim: int = 128, seed: Optional[int] = None) -> None:
        super().__init__()
        if not (64 <= state_dim <= 256):
            raise ValueError(
                f"state_dim must be in [64, 256] per Σ₀-K1 spec §4.2, got {state_dim}"
            )
        if hidden_dim <= 0:
            raise ValueError(f"hidden_dim must be positive, got {hidden_dim}")
        self.hidden_dim = hidden_dim
        self.state_dim = state_dim
        if seed is not None:
            torch.manual_seed(seed)
        # φ: LayerNorm stabilises the raw Ouro hidden scale before the projection.
        self.phi = nn.Sequential(nn.LayerNorm(hidden_dim), nn.Linear(hidden_dim, state_dim))
        # ψ: learned readout from the state ABI back to the decode-context space.
        self.psi = nn.Linear(state_dim, hidden_dim)

    def encode(self, h: Tensor) -> Tensor:
        """φ: exit-depth hidden ``h`` (..., H) → state ``x`` (..., d)."""
        return self.phi(h)

    def decode(self, x: Tensor) -> Tensor:
        """ψ: state ``x`` (..., d) → decode-context ``ĥ`` (..., H)."""
        return self.psi(x)

    def round_trip(self, h: Tensor) -> Tensor:
        """ψ(φ(h)) — reconstruct the decode context from the state ABI."""
        return self.decode(self.encode(h))

    def forward(self, h: Tensor) -> Tensor:  # noqa: D401 - nn.Module convention
        return self.encode(h)
