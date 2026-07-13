"""Task-aware PCSF route and evidence contracts.

This module deliberately sits above ``pcsf.ProviderRegistry``.  The registry
answers *which providers are currently healthy*; this module answers *whether a
specific task may use one*, what evidence it must produce, and whether the run
is allowed to leave the local boundary.

The first slice is intentionally transport-agnostic.  It does not make network
calls and does not replace provider adapters.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from hashlib import sha256
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set

from .pcsf import ProviderRegistry


class ExecutionBoundary(str, Enum):
    LOCAL = "local"
    HYBRID = "hybrid"
    CLOUD_APPROVED = "cloud-approved"


class RouteStatus(str, Enum):
    ALLOWED = "allowed"
    BLOCKED = "blocked"
    ESCALATION_REQUIRED = "escalation-required"


class FailureClass(str, Enum):
    POLICY_DENIED = "policy_denied"
    NO_ROUTABLE_PROVIDER = "no_routable_provider"
    MISSING_CAPABILITY = "missing_capability"
    BUDGET_EXCEEDED = "budget_exceeded"
    CLOUD_APPROVAL_REQUIRED = "cloud_approval_required"
    SECRET_SCAN_REQUIRED = "secret_scan_required"
    VERIFICATION_PLAN_REQUIRED = "verification_plan_required"


@dataclass(frozen=True)
class ProviderCapability:
    """Static provider/model metadata owned by unisona.ai, not provider health."""

    provider_id: str
    model_id: str
    boundary: ExecutionBoundary
    capabilities: Set[str] = field(default_factory=lambda: {"chat"})
    estimated_cost_usd: float = 0.0
    context_window: Optional[int] = None
    enabled: bool = True

    def supports(self, required: Iterable[str]) -> bool:
        return set(required).issubset(self.capabilities)


@dataclass(frozen=True)
class EvidenceContract:
    """Minimum evidence needed before a run can be marked complete."""

    required_artifacts: Sequence[str] = field(default_factory=tuple)
    required_checks: Sequence[str] = field(default_factory=tuple)
    require_exit_code_zero: bool = False
    allow_unverified_completion: bool = False

    def is_actionable(self) -> bool:
        return bool(
            self.required_artifacts
            or self.required_checks
            or self.require_exit_code_zero
            or self.allow_unverified_completion
        )


@dataclass(frozen=True)
class RouteRequest:
    task_id: str
    intent: str
    boundary: ExecutionBoundary = ExecutionBoundary.LOCAL
    required_capabilities: Set[str] = field(default_factory=lambda: {"chat"})
    input_classification: str = "internal"
    estimated_input_tokens: int = 0
    max_cost_usd: Optional[float] = None
    cloud_approved: bool = False
    secret_scan_passed: bool = False
    verification: EvidenceContract = field(default_factory=EvidenceContract)
    preferred_providers: Sequence[str] = field(default_factory=tuple)

    def context_hash(self) -> str:
        """Stable fingerprint for the decision inputs; never contains raw prompt text."""
        canonical = {
            "task_id": self.task_id,
            "intent": self.intent,
            "boundary": self.boundary.value,
            "required_capabilities": sorted(self.required_capabilities),
            "input_classification": self.input_classification,
            "estimated_input_tokens": self.estimated_input_tokens,
            "max_cost_usd": self.max_cost_usd,
            "cloud_approved": self.cloud_approved,
            "secret_scan_passed": self.secret_scan_passed,
            "verification": asdict(self.verification),
            "preferred_providers": list(self.preferred_providers),
        }
        return sha256(repr(canonical).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class RouteCandidate:
    provider_id: str
    model_id: str
    boundary: ExecutionBoundary
    estimated_cost_usd: float
    rationale: Sequence[str]


@dataclass(frozen=True)
class RouteDecision:
    status: RouteStatus
    request_hash: str
    selected: Optional[RouteCandidate] = None
    fallbacks: Sequence[RouteCandidate] = field(default_factory=tuple)
    reasons: Sequence[str] = field(default_factory=tuple)
    failure_class: Optional[FailureClass] = None
    evidence_contract: Optional[EvidenceContract] = None

    def to_dict(self) -> Dict[str, Any]:
        def candidate(value: Optional[RouteCandidate]) -> Optional[Dict[str, Any]]:
            if value is None:
                return None
            return {
                "provider_id": value.provider_id,
                "model_id": value.model_id,
                "boundary": value.boundary.value,
                "estimated_cost_usd": value.estimated_cost_usd,
                "rationale": list(value.rationale),
            }
        return {
            "status": self.status.value,
            "request_hash": self.request_hash,
            "selected": candidate(self.selected),
            "fallbacks": [candidate(item) for item in self.fallbacks],
            "reasons": list(self.reasons),
            "failure_class": self.failure_class.value if self.failure_class else None,
            "evidence_contract": asdict(self.evidence_contract) if self.evidence_contract else None,
        }


@dataclass(frozen=True)
class ExecutionReceipt:
    """Receipt emitted by a transport/tool runner after an attempted action."""

    task_id: str
    route: RouteCandidate
    status: str
    exit_code: Optional[int] = None
    artifact_hashes: Mapping[str, str] = field(default_factory=dict)
    checks: Mapping[str, bool] = field(default_factory=dict)
    stdout_hash: Optional[str] = None
    stderr_hash: Optional[str] = None


@dataclass(frozen=True)
class EvidenceAssessment:
    complete: bool
    reasons: Sequence[str]


class RouteEngine:
    """Deterministic task-aware route selection over PCSF provider health."""

    def __init__(self, registry: ProviderRegistry, capabilities: Sequence[ProviderCapability]) -> None:
        self.registry = registry
        self._capabilities = list(capabilities)

    def decide(self, request: RouteRequest) -> RouteDecision:
        request_hash = request.context_hash()
        if not request.verification.is_actionable():
            return RouteDecision(
                status=RouteStatus.BLOCKED,
                request_hash=request_hash,
                reasons=("task has no executable evidence contract",),
                failure_class=FailureClass.VERIFICATION_PLAN_REQUIRED,
            )

        eligible: List[RouteCandidate] = []
        cloud_candidates_seen = False
        capability_match_seen = False
        budget_match_seen = False
        for descriptor in self._ordered_capabilities(request):
            if not descriptor.enabled:
                continue
            if not descriptor.supports(request.required_capabilities):
                continue
            capability_match_seen = True
            if request.max_cost_usd is not None and descriptor.estimated_cost_usd > request.max_cost_usd:
                continue
            budget_match_seen = True
            if descriptor.boundary != ExecutionBoundary.LOCAL:
                cloud_candidates_seen = True
                if request.boundary == ExecutionBoundary.LOCAL:
                    continue
                if not request.cloud_approved:
                    continue
                if not request.secret_scan_passed:
                    continue
            provider = self.registry.get(descriptor.provider_id)
            if provider is None or not provider.is_routable():
                continue
            eligible.append(RouteCandidate(
                provider_id=descriptor.provider_id,
                model_id=descriptor.model_id,
                boundary=descriptor.boundary,
                estimated_cost_usd=descriptor.estimated_cost_usd,
                rationale=(
                    "provider is routable",
                    "required capabilities satisfied",
                    "within task cost ceiling",
                    "boundary policy satisfied",
                ),
            ))

        if eligible:
            return RouteDecision(
                status=RouteStatus.ALLOWED,
                request_hash=request_hash,
                selected=eligible[0],
                fallbacks=tuple(eligible[1:]),
                reasons=("route selected by policy and live capacity state",),
                evidence_contract=request.verification,
            )

        if cloud_candidates_seen and request.boundary != ExecutionBoundary.LOCAL:
            if not request.cloud_approved:
                return RouteDecision(
                    status=RouteStatus.ESCALATION_REQUIRED,
                    request_hash=request_hash,
                    reasons=("eligible cloud route exists but task has no cloud approval",),
                    failure_class=FailureClass.CLOUD_APPROVAL_REQUIRED,
                    evidence_contract=request.verification,
                )
            if not request.secret_scan_passed:
                return RouteDecision(
                    status=RouteStatus.BLOCKED,
                    request_hash=request_hash,
                    reasons=("cloud route requested but secret scan has not passed",),
                    failure_class=FailureClass.SECRET_SCAN_REQUIRED,
                    evidence_contract=request.verification,
                )
        if not capability_match_seen:
            failure = FailureClass.MISSING_CAPABILITY
            reason = "no configured route supports all required capabilities"
        elif not budget_match_seen:
            failure = FailureClass.BUDGET_EXCEEDED
            reason = "all capable routes exceed the task cost ceiling"
        else:
            failure = FailureClass.NO_ROUTABLE_PROVIDER
            reason = "no eligible provider is currently routable"
        return RouteDecision(
            status=RouteStatus.BLOCKED,
            request_hash=request_hash,
            reasons=(reason,),
            failure_class=failure,
            evidence_contract=request.verification,
        )

    def assess_evidence(self, contract: EvidenceContract, receipt: ExecutionReceipt) -> EvidenceAssessment:
        reasons: List[str] = []
        if contract.require_exit_code_zero and receipt.exit_code != 0:
            reasons.append("required zero exit code was not observed")
        missing_artifacts = [name for name in contract.required_artifacts if name not in receipt.artifact_hashes]
        if missing_artifacts:
            reasons.append("missing required artifacts: " + ", ".join(missing_artifacts))
        failed_checks = [name for name in contract.required_checks if receipt.checks.get(name) is not True]
        if failed_checks:
            reasons.append("required checks did not pass: " + ", ".join(failed_checks))
        if receipt.status not in {"completed", "succeeded"} and not contract.allow_unverified_completion:
            reasons.append("execution did not reach a successful terminal status")
        return EvidenceAssessment(complete=not reasons, reasons=tuple(reasons))

    def _ordered_capabilities(self, request: RouteRequest) -> List[ProviderCapability]:
        preferred = {provider: index for index, provider in enumerate(request.preferred_providers)}
        registry_chain = self.registry.get_routable_chain()
        registry_rank = {provider: index for index, provider in enumerate(registry_chain)}
        return sorted(
            self._capabilities,
            key=lambda item: (
                preferred.get(item.provider_id, 10_000),
                registry_rank.get(item.provider_id, 10_000),
                item.estimated_cost_usd,
                item.provider_id,
                item.model_id,
            ),
        )
