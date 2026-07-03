#!/usr/bin/env python3
"""Read-only bio-threat source registry contracts for HFF.

This module defines conservative, data-only records for bio-threat source
classification and outbreak narrative review. It intentionally performs no
network calls, polling, runtime response, pathogen design, synthesis guidance,
or autonomous correction.
"""

from dataclasses import asdict, dataclass, field
from typing import List

SOURCE_AUTHORITY_PRIMARY = "primary_authority"
SOURCE_AUTHORITY_PUBLIC_HEALTH = "public_health_authority"
SOURCE_AUTHORITY_RESEARCH = "research"
SOURCE_AUTHORITY_STATE_POSITION = "state_position"
SOURCE_AUTHORITY_MEDIA = "media"
SOURCE_AUTHORITY_UNKNOWN = "unknown"

EVIDENCE_ROLE_OPERATIONAL_SIGNAL = "operational_signal"
EVIDENCE_ROLE_TAXONOMY_SEED = "taxonomy_seed"
EVIDENCE_ROLE_NARRATIVE_CONTEXT = "narrative_context"
EVIDENCE_ROLE_BACKGROUND = "background"
EVIDENCE_ROLE_NOT_ACCEPTED = "not_accepted"

SOURCE_SCOPE_GLOBAL = "global"
SOURCE_SCOPE_REGIONAL = "regional"
SOURCE_SCOPE_NATIONAL = "national"
SOURCE_SCOPE_LOCAL = "local"
SOURCE_SCOPE_DOMAIN = "domain_specific"

CADENCE_REAL_TIME = "real_time"
CADENCE_DAILY = "daily"
CADENCE_WEEKLY = "weekly"
CADENCE_MONTHLY = "monthly"
CADENCE_EVENT_DRIVEN = "event_driven"
CADENCE_STATIC = "static"
CADENCE_UNKNOWN = "unknown"

NARRATIVE_STATUS_UNCLASSIFIED = "unclassified"
NARRATIVE_STATUS_SOURCE_CLASSIFIED = "source_classified"
NARRATIVE_STATUS_EVIDENCE_BOUND = "evidence_bound"
NARRATIVE_STATUS_QUARANTINED = "quarantined"
NARRATIVE_STATUS_REJECTED = "rejected"

THREAT_STATUS_CANDIDATE = "candidate"
THREAT_STATUS_MONITOR = "monitor"
THREAT_STATUS_REVIEW = "review"
THREAT_STATUS_QUARANTINE = "quarantine"

RISK_DOMAIN_AMR = "amr"
RISK_DOMAIN_FUNGAL = "fungal_resistance"
RISK_DOMAIN_ZOONOTIC = "zoonotic_spillover"
RISK_DOMAIN_VACCINE_PREVENTABLE = "vaccine_preventable"
RISK_DOMAIN_WASH = "water_sanitation_hygiene"
RISK_DOMAIN_PRIORITY_PATHOGEN = "priority_pathogen"
RISK_DOMAIN_AI_BIO = "ai_bio"
RISK_DOMAIN_OUTBREAK_NARRATIVE = "outbreak_narrative"

PROHIBITED_DETAIL_PATTERNS = (
    "protocol steps",
    "synthesis instructions",
    "genetic design",
    "increase transmissibility",
    "increase virulence",
    "evade detection",
    "lab procedure",
    "culture conditions",
)


@dataclass
class SourceTrustProfile:
    """Classifies a source before it can support a public claim."""

    source_id: str = ""
    name: str = ""
    url: str = ""
    authority: str = SOURCE_AUTHORITY_UNKNOWN
    scope: str = SOURCE_SCOPE_DOMAIN
    update_cadence: str = CADENCE_UNKNOWN
    evidence_role: str = EVIDENCE_ROLE_BACKGROUND
    limitations: List[str] = field(default_factory=list)
    can_support_operational_claim: bool = False
    can_seed_taxonomy: bool = True

    def missing_requirements(self) -> List[str]:
        missing: List[str] = []
        if not self.source_id:
            missing.append("source_id")
        if not self.name:
            missing.append("name")
        if not self.url:
            missing.append("url")
        if self.authority == SOURCE_AUTHORITY_UNKNOWN:
            missing.append("authority")
        if self.update_cadence == CADENCE_UNKNOWN:
            missing.append("update_cadence")
        if not self.limitations:
            missing.append("limitations")
        if self.can_support_operational_claim and self.evidence_role != EVIDENCE_ROLE_OPERATIONAL_SIGNAL:
            missing.append("operational_evidence_role")
        if self.authority == SOURCE_AUTHORITY_STATE_POSITION and self.can_support_operational_claim:
            missing.append("state_position_cannot_be_sole_operational_truth")
        return missing

    def is_review_ready(self) -> bool:
        return not self.missing_requirements()

    def to_dict(self) -> dict:
        data = asdict(self)
        data["missing_requirements"] = self.missing_requirements()
        data["is_review_ready"] = self.is_review_ready()
        return data


@dataclass
class OutbreakNarrativeSourceClassification:
    """Routes outbreak-origin and politicized narratives into review first."""

    narrative_id: str = ""
    claim_text: str = ""
    source_refs: List[str] = field(default_factory=list)
    competing_hypotheses: List[str] = field(default_factory=list)
    uncertainty_statement: str = ""
    stigma_risk: bool = False
    geopolitical_risk: bool = False
    status: str = NARRATIVE_STATUS_UNCLASSIFIED
    safe_public_summary: str = ""

    def missing_requirements(self) -> List[str]:
        missing: List[str] = []
        if not self.narrative_id:
            missing.append("narrative_id")
        if not self.claim_text:
            missing.append("claim_text")
        if not self.source_refs:
            missing.append("source_refs")
        if not self.competing_hypotheses:
            missing.append("competing_hypotheses")
        if not self.uncertainty_statement:
            missing.append("uncertainty_statement")
        if self.status == NARRATIVE_STATUS_UNCLASSIFIED:
            missing.append("classified_status")
        if (self.stigma_risk or self.geopolitical_risk) and not self.safe_public_summary:
            missing.append("safe_public_summary")
        return missing

    def can_be_public_claim(self) -> bool:
        return self.status == NARRATIVE_STATUS_EVIDENCE_BOUND and not self.missing_requirements()

    def should_quarantine(self) -> bool:
        return self.status == NARRATIVE_STATUS_QUARANTINED or (
            self.stigma_risk and not self.safe_public_summary
        )

    def to_dict(self) -> dict:
        data = asdict(self)
        data["missing_requirements"] = self.missing_requirements()
        data["can_be_public_claim"] = self.can_be_public_claim()
        data["should_quarantine"] = self.should_quarantine()
        return data


@dataclass
class BioThreatCategory:
    """Read-only threat taxonomy candidate.

    Categories are not live alerts. They are evidence-bound buckets for future
    source registry and review work.
    """

    category_id: str = ""
    name: str = ""
    risk_domain: str = ""
    source_refs: List[str] = field(default_factory=list)
    public_health_controls: List[str] = field(default_factory=list)
    downstream_impact_reason: str = ""
    dual_use_sensitivity: str = "low"
    status: str = THREAT_STATUS_CANDIDATE
    prohibits_operational_details: bool = True

    def missing_requirements(self) -> List[str]:
        missing: List[str] = []
        if not self.category_id:
            missing.append("category_id")
        if not self.name:
            missing.append("name")
        if not self.risk_domain:
            missing.append("risk_domain")
        if not self.source_refs:
            missing.append("source_refs")
        if not self.public_health_controls:
            missing.append("public_health_controls")
        if not self.downstream_impact_reason:
            missing.append("downstream_impact_reason")
        if self.dual_use_sensitivity in {"high", "catastrophic"} and not self.prohibits_operational_details:
            missing.append("operational_details_must_be_prohibited")
        return missing

    def is_ready_for_registry(self) -> bool:
        return not self.missing_requirements()

    def to_dict(self) -> dict:
        data = asdict(self)
        data["missing_requirements"] = self.missing_requirements()
        data["is_ready_for_registry"] = self.is_ready_for_registry()
        return data


@dataclass
class ReadOnlyBioThreatSourceRegistry:
    """Container for read-only source and category records."""

    registry_id: str = ""
    sources: List[SourceTrustProfile] = field(default_factory=list)
    narratives: List[OutbreakNarrativeSourceClassification] = field(default_factory=list)
    categories: List[BioThreatCategory] = field(default_factory=list)
    runtime_enabled: bool = False
    polling_enabled: bool = False
    autonomous_response_enabled: bool = False
    public_dashboard_enabled: bool = False

    def safety_violations(self) -> List[str]:
        violations: List[str] = []
        if self.runtime_enabled:
            violations.append("runtime_enabled")
        if self.polling_enabled:
            violations.append("polling_enabled")
        if self.autonomous_response_enabled:
            violations.append("autonomous_response_enabled")
        if self.public_dashboard_enabled:
            violations.append("public_dashboard_enabled")
        for category in self.categories:
            if not category.prohibits_operational_details:
                violations.append(f"operational_details_allowed:{category.category_id}")
        return violations

    def is_read_only_safe(self) -> bool:
        return not self.safety_violations()

    def missing_requirements(self) -> List[str]:
        missing: List[str] = []
        if not self.registry_id:
            missing.append("registry_id")
        if not self.sources:
            missing.append("sources")
        if not self.categories:
            missing.append("categories")
        if not self.is_read_only_safe():
            missing.append("read_only_safety")
        return missing

    def to_dict(self) -> dict:
        return {
            "registry_id": self.registry_id,
            "sources": [source.to_dict() for source in self.sources],
            "narratives": [narrative.to_dict() for narrative in self.narratives],
            "categories": [category.to_dict() for category in self.categories],
            "runtime_enabled": self.runtime_enabled,
            "polling_enabled": self.polling_enabled,
            "autonomous_response_enabled": self.autonomous_response_enabled,
            "public_dashboard_enabled": self.public_dashboard_enabled,
            "safety_violations": self.safety_violations(),
            "is_read_only_safe": self.is_read_only_safe(),
            "missing_requirements": self.missing_requirements(),
        }


def contains_prohibited_operational_detail(text: str) -> bool:
    """Conservative string scan for out-of-scope operational detail labels."""
    lowered = text.lower()
    return any(pattern in lowered for pattern in PROHIBITED_DETAIL_PATTERNS)


def default_high_confidence_categories() -> List[BioThreatCategory]:
    """Return the downstream-impact ordered category seed list."""
    return [
        BioThreatCategory(
            category_id="amr",
            name="Antimicrobial resistance",
            risk_domain=RISK_DOMAIN_AMR,
            source_refs=["WHO_AMR_FACT_SHEET"],
            public_health_controls=["stewardship", "surveillance", "infection prevention", "diagnostics"],
            downstream_impact_reason="High ongoing burden with proven public-health controls.",
            status=THREAT_STATUS_MONITOR,
        ),
        BioThreatCategory(
            category_id="fungal-resistance",
            name="Fungal resistance and Candida auris",
            risk_domain=RISK_DOMAIN_FUNGAL,
            source_refs=["CDC_CANDIDA_AURIS"],
            public_health_controls=["early identification", "infection control", "environmental cleaning", "transfer communication"],
            downstream_impact_reason="Healthcare-associated spread can be reduced by early detection and IPC.",
            status=THREAT_STATUS_MONITOR,
        ),
        BioThreatCategory(
            category_id="h5n1-spillover",
            name="H5N1 zoonotic spillover",
            risk_domain=RISK_DOMAIN_ZOONOTIC,
            source_refs=["CDC_H5N1_MONITORING"],
            public_health_controls=["exposure monitoring", "worker protection", "animal surveillance", "avoid raw milk"],
            downstream_impact_reason="Current cross-sector animal/human exposure risk with clear monitoring guidance.",
            status=THREAT_STATUS_MONITOR,
        ),
        BioThreatCategory(
            category_id="measles-vaccine-coverage",
            name="Measles vaccination gaps",
            risk_domain=RISK_DOMAIN_VACCINE_PREVENTABLE,
            source_refs=["WHO_MEASLES_FACT_SHEET"],
            public_health_controls=["two-dose vaccination", "catch-up campaigns", "surveillance", "misinformation response"],
            downstream_impact_reason="Highly transmissible but preventable with high-confidence vaccination controls.",
            status=THREAT_STATUS_MONITOR,
        ),
        BioThreatCategory(
            category_id="cholera-wash",
            name="Cholera and WASH risk",
            risk_domain=RISK_DOMAIN_WASH,
            source_refs=["WHO_CHOLERA", "CDC_CHOLERA_VACCINATION"],
            public_health_controls=["safe water", "sanitation", "hygiene", "oral cholera vaccine"],
            downstream_impact_reason="Humanitarian and infrastructure-sensitive risk with proven controls.",
            status=THREAT_STATUS_MONITOR,
        ),
        BioThreatCategory(
            category_id="priority-pathogens",
            name="WHO R&D Blueprint priority pathogens and Disease X",
            risk_domain=RISK_DOMAIN_PRIORITY_PATHOGEN,
            source_refs=["WHO_RD_BLUEPRINT"],
            public_health_controls=["diagnostics", "vaccines", "therapeutics", "platform preparedness"],
            downstream_impact_reason="Preparedness registry for epidemic/pandemic potential without likelihood overclaiming.",
            status=THREAT_STATUS_REVIEW,
        ),
        BioThreatCategory(
            category_id="ai-bio-interface",
            name="AI-bio digital-to-physical interface risk",
            risk_domain=RISK_DOMAIN_AI_BIO,
            source_refs=["NTI_AI_BIO", "NIST_GENAI_BIOSECURITY"],
            public_health_controls=["screening", "provenance", "access control", "human review"],
            downstream_impact_reason="High-consequence dual-use domain requiring governance-only handling.",
            dual_use_sensitivity="high",
            status=THREAT_STATUS_QUARANTINE,
        ),
    ]
