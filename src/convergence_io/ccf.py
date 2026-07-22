"""
CCF — Capability Claim Format
Operationalizes P4 (Capability Constraints), consumed by P5 (Boundary), P8 (Vendor Chain), P10 (Supply Chain).

An agent must prove at action time that it has the capability it claims.
A CapabilityClaim is the runtime record of what an agent can actually do right now.
A CapabilityGate checks claims before allowing actions to proceed.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set


# ── Shared authz helpers (also imported by nap.py so both gates agree) ──────────

def canon(token: str) -> str:
    """Canonicalize an authorization token before any allow/deny decision.

    Lowercase, strip, and unify whitespace/hyphens to '_' — so a denial keyed on
    'financial_trade' cannot be bypassed by 'Financial_Trade', 'financial-trade',
    'financial trade', or trailing space (CWE-178 / CWE-289 canonicalization).
    Dots are preserved (hierarchical labels like 'pii.ssn' keep their structure).
    """
    return re.sub(r"[\s\-]+", "_", str(token).strip().lower())


def canon_set(tokens) -> Set[str]:
    return {canon(t) for t in (tokens or [])}


# The single tier ladder both gates rank against. Unknown tiers are handled
# fail-closed by the callers (unknown *required* tier denies; unknown *claim* tier
# ranks below everything). Keep NAP and CCF pointed at THIS map.
TIER_ORDER: Dict[str, int] = {"wanderer": 0, "deep_dreamer": 1, "synthesasia_guild": 2}


def tier_rank(tier: str) -> int:
    """Rank a claim/subject tier; an unrecognized tier ranks below the floor (-1),
    so it can never satisfy a real (>=0) requirement."""
    return TIER_ORDER.get(canon(tier), -1)


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

    def __post_init__(self) -> None:
        # Store capabilities canonicalized so matching is bypass-proof (F6).
        self.capabilities = canon_set(self.capabilities)
        self.tier = canon(self.tier) if self.tier else self.tier

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
        return canon(cap) in self.capabilities

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
        # Honest iff the agent actually held EVERYTHING it needed (F4). The old
        # any-overlap test (`expected & actual`) rewarded partial over-claims, so an
        # agent with one real cap could keep claiming caps it lacked at honesty 1.0.
        matched = set(expected_caps).issubset(set(actual_caps))
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
        # CCF tier enforcement: action → required tier (keys canonicalized).
        self._tier_requirements: Dict[str, str] = {canon(k): v for k, v in {
            "art_generation_unlimited": "synthesasia_guild",
            "art_generation": "deep_dreamer",
            "3door_full": "deep_dreamer",
            "advanced_symbolic_tools": "deep_dreamer",
            "guild_override": "synthesasia_guild",
        }.items()}

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
        # Tier enforcement (F5: an unknown REQUIRED tier fails CLOSED — XACML
        # "indeterminate → deny" — instead of the old fail-open where an
        # unrecognized required tier acted as no requirement at all).
        if tier and claim.tier:
            if canon(tier) not in TIER_ORDER:
                return GateResult(allowed=False,
                                  reason=f"unknown required tier '{tier}' (fail-closed)")
            if tier_rank(claim.tier) < tier_rank(tier):
                return GateResult(allowed=False, reason=f"tier mismatch: claim tier '{claim.tier}' < required '{tier}'")
        required = canon_set(required)                      # F6: canonical match
        missing = required - claim.capabilities
        if missing:
            self._honesty.record_result(agent_id, required, claim.capabilities)
            return GateResult(allowed=False, reason=f"missing capabilities: {sorted(missing)}", honesty_score=self._honesty.score(agent_id))
        if boundary and canon(claim.boundary) != canon(boundary) and canon(claim.boundary) != "hybrid":
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
