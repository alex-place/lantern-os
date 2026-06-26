"""
The Question Machine — bidirectional consolidation of the convergence loop.

Deep Thought computed the Answer (42); the machine it then built — the Earth — was a
*question-finder*. This module is the question-finder for the CIO loop: it runs the loop
**both ways** and consolidates them.

    beginning → forward   the predict pass: state x rolls forward under the drift f
                          (Observe → Reason → Act). "Where the Question is heading."
    end → backward        the adjoint/costate pass: λ_t = ∂J/∂x_t flows BACK from a
                          terminal condition (Pontryagin / backprop-through-time /
                          the Kalman smoother). "The Answer, seen from each moment."
    consolidate           the Hamiltonian stationarity ∂H/∂u = 0 is where the two
                          passes meet — the two-point boundary value problem, the
                          certificate's "safe passage" (SIGMA0-COLLAPSE-CERTIFICATE §5).

The **question** at step t is the seam disagreement ‖∂H/∂u_t‖ = ‖g_t‖: how far the
forward choice is from what the backward objective demands. Large ‖g_t‖ = "this is the
moment I most need to resolve." The machine surfaces the highest-leverage question it is
both ABLE (CAP — CapabilityGate) and ALLOWED (NAP — AuthorityGate, denials override) to
ask — and emits it as a convergence record [hypothesis, evidence, confidence, source].

HONESTY (the higher-order collapse, SIGMA0-C3): when forward and backward AGREE the
question score → 0 — but two mirrors agreeing can be *jointly wrong*. Consolidation makes
the trajectory COHERENT, not CORRECT. A near-zero question score means "internally I have
nothing left to ask," which is exactly the dead 42-state if the loop is ungrounded. The
escape is an EXTERNAL terminal condition (a real goal / observation): grounding reopens
the question. `consolidate(...)` is internal; `ask(...)`'s output is a hypothesis to be
externally verified, never an answer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import torch

from .engine import CIO_SDE, Dynamics, drift_jacobian

Tensor = torch.Tensor


# ── forward pass (beginning → forward) ───────────────────────────────────────

def forward_states(model: CIO_SDE, x0: Tensor, us: Sequence[Tensor],
                   dt: float) -> List[Tensor]:
    """Deterministic, control-driven rollout x_{t+1} = x_t + f(x_t,u_t)·dt.

    The noise-free dynamics the adjoint differentiates — the "what will happen if I apply
    this control sequence" prediction. Returns [x_0, …, x_T] (T = len(us))."""
    node = model.graph.active
    xs = [x0]
    x = x0
    for u in us:
        x = x + node.drift(x, u) * dt
        xs.append(x)
    return xs


def control_jacobian(node: Dynamics, x: Tensor, u: Tensor) -> Tensor:
    """B = ∂f/∂u, batched (B, d, m) — the control's leverage on the dynamics.

    The companion to engine.drift_jacobian (which gives A = ∂f/∂x)."""
    def f_single(xi: Tensor, ui: Tensor) -> Tensor:
        return node.drift(xi.unsqueeze(0), ui.unsqueeze(0)).squeeze(0)

    return torch.func.vmap(torch.func.jacrev(f_single, argnums=1))(x, u)


# ── backward pass (end → backward) ───────────────────────────────────────────

def backward_costate(model: CIO_SDE, xs: Sequence[Tensor], us: Sequence[Tensor],
                     dt: float,
                     terminal_lambda: Optional[Tensor] = None
                     ) -> Tuple[List[Tensor], List[Tensor]]:
    """The adjoint sweep — Pontryagin's costate run backward from the terminal condition.

        λ_T = terminal_lambda            (= ∇_x Φ(x_T); the "end", e.g. 2(x_T − goal))
        λ_t = ∇_x L_t·dt + (I + A_tᵀ·dt) λ_{t+1}
        g_t = ∇_u L_t·dt + dt·B_tᵀ λ_{t+1}        (g_t = ∂J/∂u_t = ∂H/∂u_t, the seam)

    `g_t` is EXACTLY the gradient of the total cost J = Σ_t L(x_t,u_t)·dt + Φ(x_T) w.r.t.
    u_t (machine-checked against finite differences). Returns (λ[0..T], g[0..T−1])."""
    node = model.graph.active
    T = len(us)
    B, d = xs[0].shape
    lams: List[Optional[Tensor]] = [None] * (T + 1)
    grads: List[Optional[Tensor]] = [None] * T
    lams[T] = (terminal_lambda if terminal_lambda is not None
               else torch.zeros(B, d, dtype=xs[0].dtype, device=xs[0].device))

    for t in reversed(range(T)):
        x_t = xs[t].detach().clone().requires_grad_(True)
        u_t = us[t].detach().clone().requires_grad_(True)
        L = model.stage_cost(x_t, u_t).sum()          # per-sample independent → grads stack
        gx, gu = torch.autograd.grad(L, [x_t, u_t])
        A = drift_jacobian(node, xs[t].detach(), us[t].detach())     # (B, d, d) = ∂f/∂x
        Bm = control_jacobian(node, xs[t].detach(), us[t].detach())  # (B, d, m) = ∂f/∂u
        lam_next = lams[t + 1]
        # (I + Aᵀ dt) λ_{t+1} :  Aᵀλ has components Σ_j A_{ji} λ_j
        at_lam = torch.einsum("bji,bj->bi", A, lam_next)
        lams[t] = gx * dt + lam_next + dt * at_lam
        # g_t = ∇_u L·dt + dt·Bᵀ λ_{t+1} :  (Bᵀλ)_j = Σ_i B_{ij} λ_i
        bt_lam = torch.einsum("bij,bi->bj", Bm, lam_next)
        grads[t] = gu * dt + dt * bt_lam

    return [l for l in lams], [g for g in grads]  # type: ignore[list-item]


# ── the question (a convergence record) ──────────────────────────────────────

@dataclass
class Question:
    """A surfaced question — shaped as a convergence record [hypothesis, evidence,
    confidence, source]. The hypothesis is *what to resolve*, not an answer."""
    step: int
    dim: int
    channel: str                 # the action_type / capability the question routes through
    score: float                 # ‖∂H/∂u‖ component — forward↔backward disagreement
    admissible: bool             # passed CAP (able) AND NAP (allowed)
    gate_reason: str = ""        # why inadmissible, if so
    uncertainty: float = 0.0     # tr(Σ_t) weight, when covariance is supplied

    @property
    def hypothesis(self) -> str:
        return (f"resolve dim {self.dim} at step {self.step} via '{self.channel}' "
                f"(forward↔backward disagreement {self.score:.4g})")

    def to_record(self) -> Dict[str, object]:
        return {
            "hypothesis": self.hypothesis,
            "evidence": {"seam_disagreement": self.score, "uncertainty": self.uncertainty},
            "confidence": {"informativeness": self.score},
            "source": "forward-backward consolidation (cio_sde.question)",
            "channel": self.channel, "step": self.step, "dim": self.dim,
            "admissible": self.admissible, "gate_reason": self.gate_reason,
        }


@dataclass
class ConsolidationResult:
    """The consolidated trajectory + the seam between forward and backward."""
    us: List[Tensor]
    xs: List[Tensor]
    lams: List[Tensor]
    grads: List[Tensor]                 # g_t = ∂H/∂u_t per step
    scores: List[float]                 # ‖g_t‖ per step (mean over batch) — question scores
    iterations: int = 0
    max_score_history: List[float] = field(default_factory=list)

    @property
    def max_score(self) -> float:
        return max(self.scores) if self.scores else 0.0


# ── the machine ──────────────────────────────────────────────────────────────

class QuestionMachine:
    """Consolidates the forward (predict) and backward (adjoint) passes and surfaces the
    highest-leverage question it is both ABLE (CAP) and ALLOWED (NAP) to ask.

    CAP / NAP wiring (optional — both default to "permit", so the machine is usable bare):
      • capability_gate — a CCF `CapabilityGate`; a question's channel must be a claimed
        capability of `agent_id`. The positive authority (what it can do).
      • authority_gate  — a NAP `AuthorityGate`; if it denies the channel's action_type the
        question is inadmissible REGARDLESS of capability. The negative authority (override).
      • channels — maps a control dim → the action_type/capability string it routes through.
        Unmapped dims use `default_channel`.
    """

    def __init__(self,
                 capability_gate: Optional[object] = None,
                 authority_gate: Optional[object] = None,
                 channels: Optional[Dict[int, str]] = None,
                 agent_id: str = "question-machine",
                 default_channel: str = "probe") -> None:
        self.capability_gate = capability_gate
        self.authority_gate = authority_gate
        self.channels = channels or {}
        self.agent_id = agent_id
        self.default_channel = default_channel

    def _channel(self, dim: int) -> str:
        return self.channels.get(dim, self.default_channel)

    # ── consolidation: the two-point boundary value problem ──────────────────
    def consolidate(self, model: CIO_SDE, x0: Tensor, us: Sequence[Tensor], dt: float,
                    terminal_grad: Optional[Callable[[Tensor], Tensor]] = None,
                    iterations: int = 0, lr: float = 0.1,
                    sigmas: Optional[Sequence[Tensor]] = None) -> ConsolidationResult:
        """Run forward, then backward, then (optionally) iterate the seam toward stationarity.

        `terminal_grad(x_T) -> λ_T` is the EXTERNAL anchor — the end condition the backward
        pass propagates (e.g. `lambda xT: 2*(xT - goal)`). None ⇒ λ_T = 0 (no external pull;
        the ungrounded case, where the consolidated trajectory has nothing to ask).

        `iterations > 0` performs forward-backward gradient descent on `us`
        (us ← us − lr·g): each step re-predicts forward and re-propagates backward, driving
        ‖∂H/∂u‖ → 0. That descent IS the search for the safe passage; at its fixed point the
        forward and backward passes agree (question score ≈ 0)."""
        us = [u.detach().clone() for u in us]
        history: List[float] = []
        xs: List[Tensor] = []
        lams: List[Tensor] = []
        grads: List[Tensor] = []

        for _ in range(max(iterations, 0) + 1):
            xs = forward_states(model, x0, us, dt)
            term = terminal_grad(xs[-1]) if terminal_grad is not None else None
            lams, grads = backward_costate(model, xs, us, dt, terminal_lambda=term)
            history.append(max(float(g.norm(dim=-1).mean().item()) for g in grads))
            if iterations <= 0:
                break
            iterations_left = len(history) <= iterations
            if iterations_left:
                us = [u - lr * g for u, g in zip(us, grads)]

        scores = self._scores(grads, sigmas)
        return ConsolidationResult(us=us, xs=xs, lams=lams, grads=grads, scores=scores,
                                   iterations=max(len(history) - 1, 0),
                                   max_score_history=history)

    def _scores(self, grads: Sequence[Tensor],
                sigmas: Optional[Sequence[Tensor]]) -> List[float]:
        scores: List[float] = []
        for t, g in enumerate(grads):
            base = float(g.norm(dim=-1).mean().item())   # ‖∂H/∂u_t‖, mean over batch
            if sigmas is not None and t < len(sigmas):
                tr = float(torch.diagonal(sigmas[t], dim1=-2, dim2=-1).sum(-1).mean().item())
                base = base * (1.0 + tr)                  # weight by uncertainty (explore where unsure)
            scores.append(base)
        return scores

    # ── ask: surface the top admissible question ─────────────────────────────
    def ask(self, result: ConsolidationResult, top_k: int = 1,
            tier: Optional[str] = None) -> List[Question]:
        """Rank questions by seam disagreement, gate each through CAP then NAP (NAP
        overrides), and return the top_k ADMISSIBLE ones. Inadmissible candidates are
        skipped but their reason is recorded on the returned objects when surfaced."""
        # candidate (step, dim, magnitude) sorted by |g| descending
        candidates: List[Tuple[int, int, float]] = []
        for t, g in enumerate(result.grads):
            mag = g.abs().mean(dim=0)                     # per-dim magnitude, mean over batch
            for j in range(mag.shape[-1]):
                candidates.append((t, j, float(mag[j].item())))
        candidates.sort(key=lambda c: c[2], reverse=True)

        admitted: List[Question] = []
        for step, dim, mag in candidates:
            channel = self._channel(dim)
            ok, reason = self._gate(channel, tier)
            q = Question(step=step, dim=dim, channel=channel, score=mag,
                         admissible=ok, gate_reason=reason)
            if ok:
                admitted.append(q)
            if len(admitted) >= top_k:
                break
        return admitted

    def _gate(self, channel: str, tier: Optional[str]) -> Tuple[bool, str]:
        """CAP (able) AND NAP (allowed). NAP denial overrides CAP — denials win."""
        # NAP first: a denial is final regardless of capability.
        if self.authority_gate is not None:
            res = self.authority_gate.check(action_type=channel, tier=tier)
            if getattr(res, "denied", False):
                return False, f"NAP denied '{channel}': {getattr(res, 'reason', '')}"
        # CAP: must be a claimed, verified capability.
        if self.capability_gate is not None:
            gate = self.capability_gate.check(self.agent_id, {channel}, tier=tier)
            if not getattr(gate, "allowed", False):
                return False, f"CAP blocked '{channel}': {getattr(gate, 'reason', '')}"
        return True, ""
