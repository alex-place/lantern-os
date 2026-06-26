"""
The grounded Question Loop — the Question Machine closed through external channels.

`question.py` surfaces *what to ask*; it stops at a string. This module makes the machine
actually ASK — through an external channel — and fold the answer back, so coherence becomes
correctness. This is the Act stage of the loop: the organ that touches reality.

Each round (`QuestionDrivenLoop.step`):
    1. CONSOLIDATE the plan toward the current goal *belief* ĝ (answer the control question
       internally — the forward⇄backward seam).
    2. ASK the highest-leverage admissible question (CAP/NAP gated) about a goal dimension
       not yet grounded.
    3. RESOLVE it through that dimension's channel — an EXTERNAL observation.
    4. FOLD the observation into ĝ. Repeat until everything askable is grounded.

The thesis, made executable (SIGMA0-COLLAPSE-CERTIFICATE §7 — *grounding is the safety
mechanism*):
    • OracleChannel (grounded reality) → ĝ → the TRUE goal; the plan reaches it.
    • MirrorChannel (the machine's own belief — a mirror) → ĝ never corrects; the plan
      converges, internally coherent, onto the WRONG goal. The 42-state.
    • A NAP-denied channel → that dimension is never asked → a permanent BLIND SPOT. Denials
      keep you safe and leave you blind; that trade is surfaced, not hidden.

The human-in-the-loop is not special-cased: a human is just a `CallbackChannel` whose
callback is a person answering the machine's highest-leverage admissible question. That is
the whole "ultimate HITL AGI" in one line — the human grounds the question the machine most
needs answered and is allowed to ask.

Assumes B = I (control dim j ↔ goal dim j); the loop grounds goal dimensions by their
control-leverage order.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

import torch

from .engine import CIO_SDE
from .question import QuestionMachine

Tensor = torch.Tensor


# ── the observation (external evidence) ──────────────────────────────────────

@dataclass
class Observation:
    """External evidence returned by a channel — the grounding signal."""
    dim: int
    value: float
    source: str
    confidence: float = 1.0
    agreement: str = "single-source"   # single-source | corroborated | divergent
    n_sources: int = 1


# ── channels (Act-stage organs) ──────────────────────────────────────────────

class Channel:
    """An Act-stage organ: resolves a question against something EXTERNAL to the machine.

    Subclasses implement `resolve(dim, belief) -> Observation`. The channel `name` IS the
    action_type/capability string the CAP (CapabilityGate) and NAP (AuthorityGate) gate on.
    """

    def __init__(self, name: str) -> None:
        self.name = name

    def resolve(self, dim: int, belief: Tensor) -> Observation:  # pragma: no cover - abstract
        raise NotImplementedError


class CallbackChannel(Channel):
    """Wraps any external function — the general grounding organ.

    A human-in-the-loop is exactly this: `CallbackChannel("ask_human", answer_fn)` where
    `answer_fn(dim, belief)` is a person answering the machine's question for that dimension.
    """

    def __init__(self, name: str, fn: Callable[[int, Tensor], float]) -> None:
        super().__init__(name)
        self.fn = fn

    def resolve(self, dim: int, belief: Tensor) -> Observation:
        return Observation(dim=dim, value=float(self.fn(dim, belief)), source=self.name)


def HumanChannel(answer: Callable[[int, Tensor], float], name: str = "ask_human") -> CallbackChannel:
    """The human-in-the-loop organ — a person answering the highest-leverage admissible
    question. The highest-authority grounding channel."""
    return CallbackChannel(name, answer)


class OracleChannel(Channel):
    """Grounded reality: returns the TRUE goal component in the asked dimension — external
    truth the machine cannot derive from its own representations."""

    def __init__(self, true_goal: Tensor, name: str = "oracle") -> None:
        super().__init__(name)
        self.true_goal = true_goal

    def resolve(self, dim: int, belief: Tensor) -> Observation:
        return Observation(dim=dim, value=float(self.true_goal[0, dim]), source=self.name)


class MirrorChannel(Channel):
    """Ungrounded self-reference: returns the machine's OWN current belief — zero external
    information. The mirror agreeing with the mirror; converges coherent-but-wrong."""

    def __init__(self, name: str = "mirror") -> None:
        super().__init__(name)

    def resolve(self, dim: int, belief: Tensor) -> Observation:
        return Observation(dim=dim, value=float(belief[0, dim]), source=self.name)


class CorroboratedChannel(Channel):
    """≥2 independent channels, fused — the External-Reality Rule as a single channel.

    One grounding source is a single point of failure: a mirror, a stale feed, or a wrong
    oracle is believed unconditionally. Corroboration is the fix — query multiple independent
    channels and fuse. Agreement *earns* confidence; disagreement is surfaced, not averaged
    away. This is the same discipline as the multi-source flourishing feeds and the
    deep-research 3-vote verify, brought inside the grounded loop.

      • all sources agree (spread ≤ tol) → "corroborated", confidence → 1.0
      • sources diverge                  → "divergent", confidence falls with the spread
      • one source                       → "single-source", confidence 0.5 (uncorroborated)

    The fused value is the precision-unweighted mean; a divergent result's LOW confidence is
    the signal a loop should act on (re-ground, or escalate to a human), not the value.
    """

    def __init__(self, name: str, channels, tol: float = 0.05) -> None:
        super().__init__(name)
        self.channels = list(channels)
        self.tol = tol

    def resolve(self, dim: int, belief: Tensor) -> Observation:
        obs = [c.resolve(dim, belief) for c in self.channels]
        vals = [o.value for o in obs]
        n = len(vals)
        mean = sum(vals) / n if n else 0.0
        spread = (sum((v - mean) ** 2 for v in vals) / n) ** 0.5 if n > 1 else 0.0
        if n < 2:
            agreement, confidence = "single-source", 0.5
        elif spread <= self.tol:
            agreement, confidence = "corroborated", 1.0
        else:
            agreement = "divergent"
            confidence = max(0.0, 1.0 - spread / (4.0 * self.tol))
        srcs = ",".join(sorted({o.source for o in obs}))
        return Observation(dim=dim, value=mean, source=f"{self.name}[{srcs}]",
                           confidence=round(confidence, 4), agreement=agreement, n_sources=n)


# ── the real web organ (natural-language grounding) ──────────────────────────

@dataclass
class WebEvidence:
    """Grounded evidence from the open web — a [claim/query, evidence, source] triple."""
    query: str
    evidence: str
    source: str
    ok: bool


class WebChannel:
    """A REAL external grounding organ — looks a query up on the live web, no API key.

    Distinct shape from the numeric `Channel`s above: it grounds **natural-language**
    queries (`lookup(query) -> WebEvidence`), the form an NL grounded loop needs. Tries
    Wikipedia's REST summary (clean encyclopedic extract) then the DuckDuckGo Instant-Answer
    API; both stdlib `urllib`, fail-safe with timeouts. This is the Act-stage organ that
    turns a coherent answer into a *grounded* one — every fact carries a source URL.

    The piece it does NOT include is the **reasoner**: turning an English question into web
    queries and the returned evidence into an answer needs an LLM (any model in the Reason
    slot — Ouro, Claude, …). Wire `reasoner(question, evidence) -> answer` and the loop runs
    autonomously; until then a human (or this assistant) plays that slot.
    """

    def __init__(self, name: str = "web_search", timeout: float = 12.0) -> None:
        self.name = name
        self.timeout = timeout

    def _get_json(self, url: str) -> dict:
        import json
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "lantern-os-question-loop/1.0"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:  # nosec - read-only public APIs
            return json.loads(r.read().decode("utf-8", "replace"))

    def _wikipedia(self, query: str):
        import urllib.parse
        try:
            title = urllib.parse.quote(query.strip().replace(" ", "_"))
            d = self._get_json(f"https://en.wikipedia.org/api/rest_v1/page/summary/{title}")
            extract = d.get("extract", "") or ""
            url = (d.get("content_urls", {}).get("desktop", {}).get("page")
                   or "https://en.wikipedia.org")
            return extract, url
        except Exception:
            return "", ""

    def _duckduckgo(self, query: str):
        import urllib.parse
        try:
            q = urllib.parse.quote(query)
            d = self._get_json(f"https://api.duckduckgo.com/?q={q}&format=json&no_html=1")
            extract = d.get("AbstractText", "") or d.get("Answer", "") or ""
            return extract, (d.get("AbstractURL", "") or "https://duckduckgo.com")
        except Exception:
            return "", ""

    def lookup(self, query: str) -> WebEvidence:
        """Ground a natural-language query against the live web. Returns evidence + source."""
        evidence, url = self._wikipedia(query)
        if not evidence:
            evidence, url = self._duckduckgo(query)
        return WebEvidence(query=query, evidence=evidence, source=url, ok=bool(evidence))


# ── the loop ─────────────────────────────────────────────────────────────────

@dataclass
class LoopRecord:
    """One grounded round — a convergence record [hypothesis, evidence, confidence, source]."""
    step: int
    dim: int
    channel: str
    observation: float
    belief_before: float
    belief_after: float
    seam: float
    confidence: float = 1.0            # the channel's confidence in this observation
    agreement: str = "single-source"   # single-source | corroborated | divergent
    n_sources: int = 1

    def to_dict(self) -> Dict[str, object]:
        return {
            "hypothesis": f"ground goal dim {self.dim} via '{self.channel}' (seam {self.seam:.4g})",
            "evidence": {"observation": self.observation, "belief_before": self.belief_before,
                         "n_sources": self.n_sources, "agreement": self.agreement},
            "confidence": {"seam": self.seam, "grounding": self.confidence},
            "source": f"channel:{self.channel}",
            "step": self.step, "dim": self.dim, "belief_after": self.belief_after,
        }


@dataclass
class LoopResult:
    belief: Tensor                 # the grounded goal belief ĝ (→ true goal iff channels ground)
    x_T: Tensor                    # where the final plan actually lands
    final_seam: float              # internal coherence of the final plan (≈0 = consolidated)
    grounded: List[int]            # goal dims that got grounded
    blind: List[int]               # goal dims never grounded (e.g. NAP-denied channels)
    history: List[LoopRecord] = field(default_factory=list)


class QuestionDrivenLoop:
    """Closes the Question Machine through channels. See module docstring."""

    def __init__(self, model: CIO_SDE, qm: QuestionMachine, channels: Dict[str, Channel],
                 x0: Tensor, dt: float, goal_belief: Tensor, horizon: int = 8) -> None:
        self.model = model
        self.qm = qm
        self.channels = channels
        self.x0 = x0
        self.dt = dt
        self.horizon = horizon
        self.belief = goal_belief.clone()
        self.us: List[Tensor] = [torch.zeros(1, model.ctrl_dim, dtype=x0.dtype) for _ in range(horizon)]
        self.grounded: set = set()
        self.history: List[LoopRecord] = []

    def _terminal_grad(self) -> Callable[[Tensor], Tensor]:
        belief = self.belief
        return lambda xT: 2.0 * (xT - belief)

    def step(self, consolidate_iters: int = 60, lr: float = 0.05) -> Optional[LoopRecord]:
        """One grounded round. Returns the record, or None when nothing askable remains."""
        res = self.qm.consolidate(self.model, self.x0, self.us, self.dt,
                                  terminal_grad=self._terminal_grad(),
                                  iterations=consolidate_iters, lr=lr)
        self.us = res.us
        n_candidates = len(res.grads) * self.model.ctrl_dim
        ranked = self.qm.ask(res, top_k=n_candidates)            # all ADMISSIBLE, seam-ranked
        q = next((c for c in ranked if c.dim not in self.grounded), None)
        if q is None:
            return None
        channel = self.channels.get(q.channel)
        if channel is None:
            self.grounded.add(q.dim)                             # unresolvable — don't stall
            return None
        before = float(self.belief[0, q.dim])
        obs = channel.resolve(q.dim, self.belief)
        self.belief[0, q.dim] = obs.value                        # fold external evidence into ĝ
        self.grounded.add(q.dim)
        rec = LoopRecord(step=len(self.history), dim=q.dim, channel=q.channel,
                         observation=obs.value, belief_before=before,
                         belief_after=obs.value, seam=q.score,
                         confidence=obs.confidence, agreement=obs.agreement,
                         n_sources=obs.n_sources)
        self.history.append(rec)
        return rec

    def run(self, max_steps: int = 12, consolidate_iters: int = 60,
            final_iters: int = 400, lr: float = 0.05) -> LoopResult:
        for _ in range(max_steps):
            if self.step(consolidate_iters=consolidate_iters, lr=lr) is None:
                break
        # final plan toward the grounded belief
        final = self.qm.consolidate(self.model, self.x0, self.us, self.dt,
                                    terminal_grad=self._terminal_grad(),
                                    iterations=final_iters, lr=lr)
        self.us = final.us
        d = self.model.dim
        blind = [j for j in range(d) if j not in self.grounded]
        return LoopResult(belief=self.belief.clone(), x_T=final.xs[-1],
                          final_seam=final.max_score, grounded=sorted(self.grounded),
                          blind=blind, history=self.history)
