"""
AAPF — Agent Action Provenance Format
Operationalizes P3 (Provenance and Audit), consumed by P6 (Subject Rights), P7 (Incident Response), P9 (Reporting).

Every action produces a record tying the artifact to the actor with enough detail
to reproduce the decision. This is the audit trail for all agent actions.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class ActionRecord:
    action_id: str
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    actor_agent_id: str = ""
    actor_provider_id: str = ""
    actor_model: str = ""
    action_type: str = ""  # chat | save | dispatch | gate_check | boundary_cross
    input_summary: str = ""
    output_summary: str = ""
    # Cross-references to other RPS primitives
    capability_claim_id: Optional[str] = None
    nap_profile_id: Optional[str] = None  # A9 — which NAP rule was triggered
    dcf_ref: Optional[str] = None  # A10 — DCF classification at time of action
    tier: str = "wanderer"  # A11 — user tier
    consent_state: str = "implicit"  # A11 — explicit | implicit | denied
    data_classifications: List[str] = field(default_factory=list)
    authority_check: str = "none"  # none | passed | denied
    boundary: str = "local"
    latency_ms: float = 0.0
    status: str = "ok"  # ok | error | denied | timeout
    error_msg: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    # A12 — integrity proof
    integrity_hash: str = ""

    def to_dict(self) -> Dict[str, Any]:
        d = {
            "action_id": self.action_id,
            "timestamp": self.timestamp,
            "actor": {
                "agent_id": self.actor_agent_id,
                "provider_id": self.actor_provider_id,
                "model": self.actor_model,
            },
            "action_type": self.action_type,
            "input_summary": self.input_summary,
            "output_summary": self.output_summary,
            "capability_claim_id": self.capability_claim_id,
            "nap_profile_id": self.nap_profile_id,
            "dcf_ref": self.dcf_ref,
            "tier": self.tier,
            "consent_state": self.consent_state,
            "data_classifications": self.data_classifications,
            "authority_check": self.authority_check,
            "boundary": self.boundary,
            "latency_ms": self.latency_ms,
            "status": self.status,
            "error_msg": self.error_msg,
            "metadata": self.metadata,
        }
        # Compute integrity hash if not already set
        if not self.integrity_hash:
            payload = json.dumps(d, sort_keys=True, ensure_ascii=False)
            self.integrity_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        d["integrity_hash"] = self.integrity_hash
        return d


class ProvenanceLedger:
    """
    Append-only ledger of ActionRecords. Writes to JSONL on disk.
    Provides query interface for audit, incident response, and reporting.
    """

    def __init__(self, ledger_path: Optional[Path] = None) -> None:
        self._path = ledger_path or Path("data/provenance/actions.jsonl")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._records: List[ActionRecord] = []
        self._lock = threading.Lock()

    def record(self, action: ActionRecord) -> None:
        with self._lock:
            self._records.append(action)
            try:
                with open(self._path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(action.to_dict()) + "\n")
            except OSError as exc:
                logging.warning("Provenance ledger write failed: %s", exc)

    def query(self, agent_id: Optional[str] = None, action_type: Optional[str] = None,
              since: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
        with self._lock:
            results = list(self._records)
        if agent_id:
            results = [r for r in results if r.actor_agent_id == agent_id]
        if action_type:
            results = [r for r in results if r.action_type == action_type]
        if since:
            results = [r for r in results if r.timestamp >= since]
        return [r.to_dict() for r in results[-limit:]]

    def count_by_status(self) -> Dict[str, int]:
        with self._lock:
            counts: Dict[str, int] = {}
            for r in self._records:
                counts[r.status] = counts.get(r.status, 0) + 1
            return counts
