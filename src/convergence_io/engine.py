"""
Convergence IO Engine — Unified orchestration layer
Replaces super-jarvis-default and super-jarvis-primary.

Composes all 5 RPS-derived specs (PCSF, CCF, AAPF, NAP, DCF) into a single
runtime that routes dreamer requests through the capacity fallback chain
with capability verification, authority gates, data classification, and
full provenance recording.

Usage:
    engine = ConvergenceIO()
    result = engine.route_chat("I dreamed of a door...", agent_id="lantern", kind="dream")
    # result.provider_used, result.text, result.provenance_id, result.source
"""

from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .pcsf import ProviderCapacityState, ProviderRegistry, ProviderState, default_registry
from .ccf import CapabilityClaim, CapabilityGate
from .aapf import ActionRecord, ProvenanceLedger
from .nap import AuthorityGate, NegativeAuthorityProfile, dreamer_safety_nap
from .dcf import DataClassification, DREAM_LABELS


@dataclass
class RouteResult:
    text: str = ""
    provider_used: str = "offline"
    agent_name: str = "Orion"
    source: str = "offline"  # llm | offline | circuit_breaker | denied
    saved: bool = False
    provenance_id: str = ""
    latency_ms: float = 0.0
    capacity_snapshot: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)


class ConvergenceIO:
    """
    The unified Convergence IO engine. Drop-in replacement for super-jarvis.

    Initialization:
        engine = ConvergenceIO(repo_root=Path("."))

    The engine auto-detects available providers by checking env vars,
    applies NAP safety profiles, and routes through the PCSF fallback chain.
    """

    def __init__(self, repo_root: Optional[Path] = None,
                 provider_registry: Optional[ProviderRegistry] = None) -> None:
        self.repo_root = repo_root or Path(".")
        self.registry = provider_registry or default_registry()
        self.capability_gate = CapabilityGate()
        self.authority_gate = AuthorityGate()
        self.ledger = ProvenanceLedger(
            ledger_path=self.repo_root / "data" / "provenance" / "actions.jsonl"
        )

        self.registry.check_env(lambda k: os.environ.get(k))
        self.authority_gate.add_profile(dreamer_safety_nap())

        # Register default capability claims so the engine is usable out-of-the-box
        # Includes all dream-chat agents so classifyIntent() results route cleanly
        for default_agent in ("auto", "lantern", "orion", "keystone", "blinkbug",
                               "waterfall", "xenon", "founder", ""):
            claim = CapabilityClaim(
                agent_id=default_agent,
                provider_id="pcsf-chain",
                capabilities={"chat", "save", "dispatch"},
                boundary="hybrid",
                tier="wanderer",
            )
            claim.verify()
            self.capability_gate.register_claim(claim)

        self._provider_handlers: Dict[str, Callable] = {}

    def register_provider_handler(self, provider_id: str, handler: Callable) -> None:
        self._provider_handlers[provider_id] = handler

    def route_chat(self, message: str, agent_id: str = "auto",
                   kind: str = "dream", user: str = "dreamer",
                   system_prompt: str = "", save_fn: Optional[Callable] = None,
                   tier: str = "wanderer",
                   generate_art: bool = False) -> RouteResult:
        """
        Route a chat message through the full convergence stack:
        1. DCF — classify the input data + retention check
        2. NAP — check authority gates (denials) with tier override
        3. CCF — verify capability claims with tier enforcement
        4. PCSF — route through capacity fallback chain with tier priority
        5. AAPF — record provenance with cross-references + integrity hash
        """
        action_id = f"chat-{uuid.uuid4().hex[:12]}"
        start = time.time()

        # 1. DCF — classify input + retention check
        classification = DataClassification(datum_id=action_id, labels={"dream_content"})
        if kind in ("character", "lore", "place"):
            classification.add_label("symbolic_data")
        if not classification.is_retained(DREAM_LABELS):
            self._record_action(action_id, agent_id, "", "chat", message[:120], "",
                                "denied", "DCF retention policy expired", 0.0,
                                classification, tier=tier, nap_id="dcf-retention")
            return RouteResult(
                text="This data has expired per retention policy.",
                source="denied",
                provenance_id=action_id,
            )

        # 2. NAP — authority check with tier override
        auth_result = self.authority_gate.check(
            action_type="chat",
            data_classes=list(classification.labels),
            tier=tier,
        )
        if auth_result.denied:
            self._record_action(action_id, agent_id, "", "chat", message[:120], "",
                                "denied", auth_result.reason, 0.0,
                                classification, tier=tier, nap_id=auth_result.by)
            return RouteResult(
                text=f"This action was denied: {auth_result.reason}",
                source="denied",
                provenance_id=action_id,
            )

        # 3. CCF — verify capability claims with tier enforcement
        ccf_result = self.capability_gate.check(
            agent_id=agent_id,
            required={"chat"},
            tier=tier,
        )
        if not ccf_result.allowed:
            self._record_action(action_id, agent_id, "", "chat", message[:120], "",
                                "denied", ccf_result.reason, 0.0,
                                classification, tier=tier)
            return RouteResult(
                text=f"Capability claim denied: {ccf_result.reason}",
                source="denied",
                provenance_id=action_id,
            )

        # 4. PCSF — get routable chain with tier priority
        self.registry.check_env(lambda k: os.environ.get(k))
        chain = self.registry.get_routable_chain(tier=tier)

        # 5. Try each provider in the chain
        result = RouteResult(provenance_id=action_id)
        for provider_id in chain:
            if provider_id == "offline":
                break

            handler = self._provider_handlers.get(provider_id)
            if not handler:
                continue

            try:
                call_start = time.time()
                response = handler(message=message, system_prompt=system_prompt,
                                   agent_id=agent_id, kind=kind)
                call_ms = round((time.time() - call_start) * 1000, 2)

                if response and response.get("text"):
                    self.registry.record_success(provider_id, call_ms)
                    result.text = response["text"]
                    result.provider_used = provider_id
                    result.agent_name = response.get("agent_name", agent_id)
                    result.source = "llm"
                    result.latency_ms = call_ms
                    break
            except Exception as exc:
                self.registry.record_error(provider_id, str(exc))
                continue

        # 6. Offline fallback if no provider succeeded
        if not result.text:
            result.text = self._offline_reply(message, kind)
            result.source = "offline"
            result.provider_used = "offline"

        # 7. DCF — propagate labels to generated art if requested
        if generate_art:
            art_id = f"art-{uuid.uuid4().hex[:12]}"
            art_classification = classification.derive(art_id, DREAM_LABELS)
            # Art inherits private/sensitive labels from source dream
            result.metadata["art_classification"] = art_classification.to_dict()

        # Save entry if save function provided
        if save_fn:
            try:
                save_fn(user=user, kind=kind, text=message)
                result.saved = True
            except Exception:
                pass

        total_ms = round((time.time() - start) * 1000, 2)
        result.latency_ms = total_ms
        result.capacity_snapshot = self.registry.snapshot(tier=tier)

        # 8. AAPF — record provenance with cross-references + integrity hash
        ccf_id = ccf_result.claim.to_dict().get("agent_id") if ccf_result.claim else None
        self._record_action(
            action_id, agent_id, result.provider_used, "chat",
            message[:200], result.text[:200],
            "ok" if result.source == "llm" else result.source,
            "", total_ms, classification,
            tier=tier,
            nap_id=auth_result.by if auth_result.denied else None,
            ccf_id=ccf_id,
            dcf_ref=classification.datum_id,
        )

        return result

    def _offline_reply(self, message: str, kind: str) -> str:
        snippet = message[:90] if message else ""
        replies = {
            "dream": f'The flame holds steady. "{snippet}..." What light did you bring back?',
            "note": f'Noted. "{snippet}..." Patterns like this surface for a reason.',
            "symbol": f'Symbols return when they have something left to say. What does "{snippet}..." mean to you?',
            "mirror": f'Mirrors show what we are ready to see. "{snippet}..." What does this reveal?',
            "event": f'Moments like this leave a mark. "{snippet}..." How did it shift something?',
            "lore": f'Lore is the hidden structure. "{snippet}..." What rule does this describe?',
            "character": f'Characters carry messages. "{snippet}..." What does this one want you to know?',
            "place": f'Places hold their own gravity. "{snippet}..." What did this space feel like?',
        }
        return replies.get(kind, replies["dream"])

    def _record_action(self, action_id: str, agent_id: str, provider_id: str,
                       action_type: str, input_summary: str, output_summary: str,
                       status: str, error_msg: str, latency_ms: float,
                       classification: Optional[DataClassification] = None,
                       tier: str = "wanderer",
                       nap_id: Optional[str] = None,
                       ccf_id: Optional[str] = None,
                       dcf_ref: Optional[str] = None) -> None:
        record = ActionRecord(
            action_id=action_id,
            actor_agent_id=agent_id,
            actor_provider_id=provider_id,
            action_type=action_type,
            input_summary=input_summary,
            output_summary=output_summary,
            data_classifications=sorted(classification.labels) if classification else [],
            authority_check="denied" if status == "denied" else "passed",
            latency_ms=latency_ms,
            status=status,
            error_msg=error_msg,
            tier=tier,
            nap_profile_id=nap_id,
            capability_claim_id=ccf_id,
            dcf_ref=dcf_ref,
        )
        # integrity_hash is auto-computed in to_dict()
        self.ledger.record(record)

    def health(self) -> Dict[str, Any]:
        return {
            "ok": True,
            "version": "1.0.0",
            "service": "convergence-io",
            "providers": self.registry.snapshot(),
            "authority_profiles": self.authority_gate.active_profiles(),
            "capabilities": self.capability_gate.snapshot(),
            "provenance_counts": self.ledger.count_by_status(),
        }
