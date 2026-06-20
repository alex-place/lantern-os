"""
CCF — Capability Claim Format
Operationalizes P4 (Capability Constraints), consumed by P5 (Boundary), P8 (Vendor Chain), P10 (Supply Chain).

An agent must prove at action time that it has the capability it claims.
A CapabilityClaim is the runtime record of what an agent can actually do right now.
A CapabilityGate checks claims before allowing actions to proceed.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set


@dataclass
class CapabilityClaim:
    agent_id: str
    provider_id: str
    capabilities: Set[str] = field(default_factory=set)
    model: Optional[str] = None
    max_tokens: Optional[int] = None
    tools_available: List[str] = field(default_factory=list)
    boundary: str = "local"  # local | cloud | hybrid
    verified_at: Optional[str] = None
    verification_method: str = "env_check"  # env_check | health_probe | attestation
    # CCF temporal validity (P4)
    validity_seconds: Optional[int] = 60  # default 60s claim validity
    expires_at: Optional[str] = None
    # CCF tier enforcement
    tier: str = "wanderer"  # wanderer | deep_dreamer | synthesasia_guild

    def verify(self) -> "CapabilityClaim":
        now = datetime.now(timezone.utc)
        self.verified_at = now.isoformat()
        if self.validity_seconds is not None:
            expiry = now + timedelta(seconds=self.validity_seconds)
            self.expires_at = expiry.isoformat()
        return self

    def is_expired(self) -> bool:
        if not self.expires_at:
            return False
        try:
            now = datetime.now(timezone.utc)
            expiry = datetime.fromisoformat(self.expires_at.replace("Z", "+00:00"))
            return now > expiry
        except Exception:
            return False

    def has_capability(self, cap: str) -> bool:
        return cap in self.capabilities

    def to_dict(self) -> Dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "provider_id": self.provider_id,
            "capabilities": sorted(self.capabilities),
            "model": self.model,
            "max_tokens": self.max_tokens,
            "tools_available": self.tools_available,
            "boundary": self.boundary,
            "verified_at": self.verified_at,
            "verification_method": self.verification_method,
            "validity_seconds": self.validity_seconds,
            "expires_at": self.expires_at,
            "tier": self.tier,
        }


class HonestyTracker:
    """Tracks how truthful claims have been historically (P6 — honesty score)."""

    def __init__(self) -> None:
        self._checks: Dict[str, List[Dict[str, Any]]] = {}

    def record_result(self, agent_id: str, expected_caps: Set[str], actual_caps: Set[str]) -> None:
        matched = bool(expected_caps & actual_caps)
        entry = {"expected": sorted(expected_caps), "actual": sorted(actual_caps), "matched": matched, "at": datetime.now(timezone.utc).isoformat()}
        self._checks.setdefault(agent_id, []).append(entry)

    def score(self, agent_id: str, window: int = 20) -> float:
        checks = self._checks.get(agent_id, [])
        recent = checks[-window:] if len(checks) > window else checks
        if not recent:
            return 1.0
        hits = sum(1 for c in recent if c["matched"])
        prior_hits, prior_total = 3, 3
        return round((hits + prior_hits) / (len(recent) + prior_total), 3)

    def snapshot(self) -> Dict[str, Any]:
        return {aid: {"score": self.score(aid), "total_checks": len(v)} for aid, v in self._checks.items()}


class CapabilityGate:
    """
    Checks a CapabilityClaim against required capabilities before allowing an action.
    Rejects hallucinated capability: if the agent cannot prove it, the action is denied.
    Enforces tier limits, temporal validity, and tracks honesty.
    """

    def __init__(self, honesty_floor: float = 0.5, pcsf_registry: Optional[Any] = None) -> None:
        self._claims: Dict[str, CapabilityClaim] = {}
        self._honesty = HonestyTracker()
        self._lock = threading.RLock()
        # P6: minimum historical honesty score to allow an action.
        self._honesty_floor = honesty_floor
        # P8/PCSF: optional ProviderRegistry; when supplied, a claim whose provider is
        # not currently routable (circuit-open / quota-hit / no-key) is denied.
        self._pcsf = pcsf_registry
        # CCF tier enforcement: action → required tier
        self._tier_requirements: Dict[str, str] = {
            "art_generation_unlimited": "synthesasia_guild",
            "art_generation": "deep_dreamer",
            "3door_full": "deep_dreamer",
            "advanced_symbolic_tools": "deep_dreamer",
            "guild_override": "synthesasia_guild",
        }

    def register_claim(self, claim: CapabilityClaim) -> None:
        if not claim.verified_at:
            claim.verify()
        self._claims[claim.agent_id] = claim

    def check(self, agent_id: str, required: Set[str], boundary: Optional[str] = None,
              tier: Optional[str] = None) -> "GateResult":
        claim = self._claims.get(agent_id)
        if not claim:
            return GateResult(allowed=False, reason=f"no capability claim registered for {agent_id}")
        if claim.is_expired():
            return GateResult(allowed=False, reason=f"claim for {agent_id} expired at {claim.expires_at}")
        if not claim.verified_at:
            return GateResult(allowed=False, reason=f"claim for {agent_id} not verified")
        # P8/PCSF: the provider backing this claim must currently be routable.
        if self._pcsf is not None and claim.provider_id:
            pcs = self._pcsf.get(claim.provider_id)
            if pcs is not None and not pcs.is_routable():
                return GateResult(allowed=False,
                                  reason=f"provider '{claim.provider_id}' not routable (PCSF state {pcs.state.value})",
                                  honesty_score=self._honesty.score(agent_id))
        # P6: deny if this agent's historical honesty has fallen below the floor.
        score = self._honesty.score(agent_id)
        if score < self._honesty_floor:
            return GateResult(allowed=False,
                              reason=f"honesty {score} < floor {self._honesty_floor}",
                              honesty_score=score)
        # Tier enforcement
        if tier and claim.tier:
            tier_order = {"wanderer": 0, "deep_dreamer": 1, "synthesasia_guild": 2}
            claim_rank = tier_order.get(claim.tier, 0)
            request_rank = tier_order.get(tier, 0)
            if claim_rank < request_rank:
                return GateResult(allowed=False, reason=f"tier mismatch: claim tier '{claim.tier}' < required '{tier}'")
        missing = required - claim.capabilities
        if missing:
            self._honesty.record_result(agent_id, required, claim.capabilities)
            return GateResult(allowed=False, reason=f"missing capabilities: {sorted(missing)}", honesty_score=self._honesty.score(agent_id))
        if boundary and claim.boundary != boundary and claim.boundary != "hybrid":
            return GateResult(allowed=False, reason=f"boundary mismatch: need {boundary}, have {claim.boundary}")
        self._honesty.record_result(agent_id, required, claim.capabilities)
        return GateResult(allowed=True, claim=claim, honesty_score=self._honesty.score(agent_id))

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "claims": {aid: c.to_dict() for aid, c in self._claims.items()},
                "honesty": self._honesty.snapshot(),
            }


@dataclass
class GateResult:
    allowed: bool
    reason: str = ""
    claim: Optional[CapabilityClaim] = None
    honesty_score: float = 1.0
