"""
PCSF — Provider Capacity State Format
Operationalizes P4 (Capability Constraints) for LLM provider routing.

Tracks which providers are available, degraded, or exhausted, and routes
requests through a fallback chain with circuit breakers and quota awareness.

This is the capacity fallback system referenced in the master plan:
Claude → OpenAI → Gemini → Ollama → offline persona fallback.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Dict, List, Optional


class ProviderState(Enum):
    AVAILABLE = "available"
    DEGRADED = "degraded"
    QUOTA_HIT = "quota_hit"
    CIRCUIT_OPEN = "circuit_open"
    UNAVAILABLE = "unavailable"
    NO_KEY = "no_key"


@dataclass
class ProviderCapacityState:
    provider_id: str
    state: ProviderState = ProviderState.UNAVAILABLE
    latency_ema_ms: float = 0.0
    latency_p99_ms: float = 0.0
    error_count: int = 0
    success_count: int = 0
    last_success_at: Optional[float] = None
    last_error_at: Optional[float] = None
    last_error_msg: str = ""
    quota_remaining: Optional[int] = None
    circuit_recovery_at: Optional[float] = None
    env_key: Optional[str] = None
    last_checked: Optional[float] = None  # P7 — health timestamp

    def is_routable(self) -> bool:
        if self.state in (ProviderState.AVAILABLE, ProviderState.DEGRADED):
            return True
        if self.state == ProviderState.CIRCUIT_OPEN and self.circuit_recovery_at:
            return time.time() >= self.circuit_recovery_at
        return False

    def record_success(self, latency_ms: float) -> None:
        self.success_count += 1
        self.last_success_at = time.time()
        self.latency_p50_ms = (self.latency_p50_ms + latency_ms) / 2
        self.latency_p99_ms = max(self.latency_p99_ms, latency_ms)
        self.error_count = 0
        self.state = ProviderState.AVAILABLE

    def record_error(self, msg: str, failure_threshold: int = 3, recovery_secs: float = 30.0) -> None:
        self.error_count += 1
        self.last_error_at = time.time()
        self.last_error_msg = msg
        if self.error_count >= failure_threshold:
            self.state = ProviderState.CIRCUIT_OPEN
            self.circuit_recovery_at = time.time() + recovery_secs
        else:
            self.state = ProviderState.DEGRADED

    def record_quota_hit(self) -> None:
        self.state = ProviderState.QUOTA_HIT
        self.last_error_at = time.time()
        self.last_error_msg = "quota exhausted"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "provider_id": self.provider_id,
            "state": self.state.value,
            "latency_ema_ms": self.latency_ema_ms,
            "latency_p99_ms": self.latency_p99_ms,
            "error_count": self.error_count,
            "success_count": self.success_count,
            "quota_remaining": self.quota_remaining,
            "is_routable": self.is_routable(),
            "last_checked": datetime.fromtimestamp(self.last_checked, tz=timezone.utc).isoformat() if self.last_checked else None,
        }


class DreamerTier(Enum):
    WANDERER = "wanderer"
    DEEP_DREAMER = "deep_dreamer"
    SYNTHESASIA_GUILD = "synthesasia_guild"


TIER_PRIORITY_BOOST: Dict[str, Dict[str, int]] = {
    "wanderer": {},
    "deep_dreamer": {"anthropic": -1, "openai": -1},
    "synthesasia_guild": {"anthropic": -2, "openai": -2, "google": -1},
}

TIER_QUOTA_LIMITS: Dict[str, Dict[str, Optional[int]]] = {
    "wanderer": {"art_generation": 15, "chat": 100, "3door_plays": 5},
    "deep_dreamer": {"art_generation": None, "chat": None, "3door_plays": None},
    "synthesasia_guild": {"art_generation": None, "chat": None, "3door_plays": None},
}


class ProviderRegistry:
    """
    Manages the capacity fallback chain. Providers are tried in priority order;
    circuit breakers and quota tracking automatically route around failures.
    Tier-aware: paid tiers get priority routing to better providers.
    """

    def __init__(self) -> None:
        self._providers: Dict[str, ProviderCapacityState] = {}
        self._priority: List[str] = []
        self._lock = threading.RLock()

    def register(self, provider_id: str, env_key: Optional[str] = None, priority: Optional[int] = None) -> None:
        with self._lock:
            pcs = ProviderCapacityState(provider_id=provider_id, env_key=env_key)
            self._providers[provider_id] = pcs
            if provider_id not in self._priority:
                if priority is not None and 0 <= priority <= len(self._priority):
                    self._priority.insert(priority, provider_id)
                else:
                    self._priority.append(provider_id)

    def check_env(self, env_getter: Callable[[str], Optional[str]]) -> None:
        with self._lock:
            for pcs in self._providers.values():
                pcs.last_checked = time.time()
                if pcs.env_key:
                    val = env_getter(pcs.env_key)
                    if not val:
                        pcs.state = ProviderState.NO_KEY
                    elif pcs.state == ProviderState.NO_KEY:
                        pcs.state = ProviderState.AVAILABLE

    def get_routable_chain(self, tier: str = "wanderer") -> List[str]:
        with self._lock:
            routable = [pid for pid in self._priority if self._providers[pid].is_routable()]
            boosts = TIER_PRIORITY_BOOST.get(tier, {})
            if boosts:
                def sort_key(pid: str) -> int:
                    base = routable.index(pid) if pid in routable else 999
                    return base + boosts.get(pid, 0)
                routable.sort(key=sort_key)
            return routable

    def check_tier_quota(self, tier: str, action: str, current_count: int) -> Optional[int]:
        limits = TIER_QUOTA_LIMITS.get(tier, {})
        limit = limits.get(action)
        if limit is None:
            return None
        return max(0, limit - current_count)

    def get(self, provider_id: str) -> Optional[ProviderCapacityState]:
        return self._providers.get(provider_id)

    def record_success(self, provider_id: str, latency_ms: float) -> None:
        pcs = self._providers.get(provider_id)
        if pcs:
            pcs.record_success(latency_ms)

    def record_error(self, provider_id: str, msg: str) -> None:
        pcs = self._providers.get(provider_id)
        if pcs:
            pcs.record_error(msg)

    def record_quota_hit(self, provider_id: str) -> None:
        pcs = self._providers.get(provider_id)
        if pcs:
            pcs.record_quota_hit()

    def snapshot(self, tier: str = "wanderer") -> Dict[str, Any]:
        with self._lock:
            return {
                "priority": list(self._priority),
                "providers": {pid: pcs.to_dict() for pid, pcs in self._providers.items()},
                "routable_chain": self.get_routable_chain(tier=tier),
                "tier": tier,
                "tier_boosts": TIER_PRIORITY_BOOST.get(tier, {}),
                "tier_quota_limits": TIER_QUOTA_LIMITS.get(tier, {}),
            }


def default_registry() -> ProviderRegistry:
    """The standard Lantern OS provider fallback chain."""
    reg = ProviderRegistry()
    reg.register("anthropic", env_key="ANTHROPIC_API_KEY", priority=0)
    reg.register("openai", env_key="OPENAI_API_KEY", priority=1)
    reg.register("google", env_key="GOOGLE_API_KEY", priority=2)
    reg.register("groq", env_key="GROQ_API_KEY", priority=3)
    reg.register("deepseek", env_key="DEEPSEEK_API_KEY", priority=4)
    reg.register("ollama", env_key=None, priority=5)  # no key needed
    reg.register("offline", env_key=None, priority=6)  # always available
    return reg
