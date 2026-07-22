"""
NAP — Negative Authority Profiles
Operationalizes P2 (Authority and Consent Gates) in denial form, composes with M1 (Dynamic External Predicates).

NAP defines what agents are explicitly DENIED from doing. This is the inverse of capability claims.
Hard denials cannot be overridden by capability claims — they are enforcement boundaries.

Composes with M1: external deny lists (OFAC SDN, BIS Entity List, etc.) can be loaded
as NAP entries and refreshed on a schedule. The runtime degrades safely when sources are unreachable.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

# Shared authz helpers — one canonicalizer and one tier ladder for BOTH gates, so a
# denial and a capability claim can never disagree on what a token/tier means.
from .ccf import canon, canon_set, tier_rank


@dataclass
class NegativeAuthorityProfile:
    profile_id: str
    denied_actions: Set[str] = field(default_factory=set)
    denied_providers: Set[str] = field(default_factory=set)
    denied_boundaries: Set[str] = field(default_factory=set)
    denied_data_classes: Set[str] = field(default_factory=set)
    reason: str = ""
    source: str = "static"  # static | external_list | operator | temporal
    expires_at: Optional[str] = None
    last_refreshed: Optional[str] = None
    # N7 — tier override: minimum tier required to bypass this NAP (SOFT denials only)
    tier_override: Optional[str] = None  # synthesasia_guild | deep_dreamer | None (no override)
    # HARD denial: an enforcement boundary that NO tier can lift. Makes the documented
    # "hard denials cannot be overridden by a capability claim" invariant structural,
    # not conventional — a hard NAP ignores tier_override entirely (IP register §4.4).
    hard: bool = False

    def __post_init__(self) -> None:
        # Store all denial tokens canonicalized so a re-cased/re-spaced action, provider,
        # boundary, or data-class string cannot slip past the boundary (F1, CWE-178/289).
        self.denied_actions = canon_set(self.denied_actions)
        self.denied_providers = canon_set(self.denied_providers)
        self.denied_boundaries = canon_set(self.denied_boundaries)
        self.denied_data_classes = canon_set(self.denied_data_classes)

    def denies_action(self, action_type: str) -> bool:
        return canon(action_type) in self.denied_actions

    def denies_provider(self, provider_id: str) -> bool:
        return canon(provider_id) in self.denied_providers

    def denies_boundary(self, boundary: str) -> bool:
        return canon(boundary) in self.denied_boundaries

    def denies_data_class(self, label: str) -> bool:
        return canon(label) in self.denied_data_classes

    def is_expired(self) -> bool:
        if not self.expires_at:
            return False
        try:
            now = datetime.now(timezone.utc)
            expiry = datetime.fromisoformat(self.expires_at.replace("Z", "+00:00"))
            return now > expiry
        except Exception:
            return False

    def can_override(self, tier: str) -> bool:
        # A hard denial can never be lifted by a tier, regardless of tier_override.
        if self.hard or not self.tier_override:
            return False
        # Shared tier ladder; an unknown tier ranks below the floor so it can't override.
        return tier_rank(tier) >= tier_rank(self.tier_override)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "profile_id": self.profile_id,
            "denied_actions": sorted(self.denied_actions),
            "denied_providers": sorted(self.denied_providers),
            "denied_boundaries": sorted(self.denied_boundaries),
            "denied_data_classes": sorted(self.denied_data_classes),
            "reason": self.reason,
            "source": self.source,
            "expires_at": self.expires_at,
            "last_refreshed": self.last_refreshed,
            "tier_override": self.tier_override,
            "hard": self.hard,
        }


class AuthorityGate:
    """
    Checks actions against active NAP profiles. Denials take priority over capability claims.
    """

    def __init__(self) -> None:
        self._profiles: Dict[str, NegativeAuthorityProfile] = {}
        self._lock = threading.RLock()

    def add_profile(self, profile: NegativeAuthorityProfile) -> None:
        with self._lock:
            self._profiles[profile.profile_id] = profile

    def remove_profile(self, profile_id: str) -> None:
        with self._lock:
            self._profiles.pop(profile_id, None)

    def check(self, action_type: str, provider_id: str = "",
              boundary: str = "", data_classes: Optional[List[str]] = None,
              tier: Optional[str] = None) -> "AuthorityResult":
        data_classes = data_classes or []
        with self._lock:
            profiles = list(self._profiles.values())
        for nap in profiles:
            if nap.is_expired():
                continue
            # N7 — tier override: high tiers can bypass certain NAPs
            if tier and nap.can_override(tier):
                continue
            if nap.denies_action(action_type):
                return AuthorityResult(denied=True, by=nap.profile_id,
                                       reason=f"action '{action_type}' denied: {nap.reason}")
            if provider_id and nap.denies_provider(provider_id):
                return AuthorityResult(denied=True, by=nap.profile_id,
                                       reason=f"provider '{provider_id}' denied: {nap.reason}")
            if boundary and nap.denies_boundary(boundary):
                return AuthorityResult(denied=True, by=nap.profile_id,
                                       reason=f"boundary '{boundary}' denied: {nap.reason}")
            for dc in data_classes:
                if nap.denies_data_class(dc):
                    return AuthorityResult(denied=True, by=nap.profile_id,
                                           reason=f"data class '{dc}' denied: {nap.reason}")
        return AuthorityResult(denied=False)

    def active_profiles(self) -> List[Dict[str, Any]]:
        return [p.to_dict() for p in self._profiles.values() if not p.is_expired()]


@dataclass
class AuthorityResult:
    denied: bool
    by: str = ""
    reason: str = ""


# ── Standard NAP profiles for Lantern OS ──────────────────────────────────

def dreamer_safety_nap() -> NegativeAuthorityProfile:
    """Hard denials for all dreamer-facing interactions."""
    return NegativeAuthorityProfile(
        profile_id="dreamer-safety",
        denied_actions={"financial_trade", "account_creation", "credential_entry", "data_deletion"},
        denied_data_classes={"pii.ssn", "pii.financial", "phi.diagnosis", "coppa.under_13"},
        reason="Dreamer safety boundary — no financial, medical, or child-identity actions",
        source="static",
        hard=True,  # safety is an enforcement boundary — no tier lifts it
    )


def local_only_nap() -> NegativeAuthorityProfile:
    """Enforces local-only mode — no cloud provider calls."""
    return NegativeAuthorityProfile(
        profile_id="local-only",
        denied_providers={"anthropic", "openai", "google", "groq", "deepseek", "azure"},
        denied_boundaries={"cloud"},
        reason="Local-only mode — all traffic stays on-device",
        source="operator",
    )
