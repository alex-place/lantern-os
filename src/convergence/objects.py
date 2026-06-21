"""Core Convergence Model Σ₀ objects.

Four immutable dataclasses that form the foundation of the Convergence Engine:
- Memory: append-only persistent knowledge
- Task: goal + constraints + status
- Tool: executable capability with I/O contract
- ConvergenceRecord: hypothesis + evidence + result + confidence (one reasoning cycle)

Reference: CONVERGANCE-SIGMA0-BRIEFING.md
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from enum import Enum
import json


class TaskStatus(str, Enum):
    """Task lifecycle states."""
    QUEUED = "queued"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    ABANDONED = "abandoned"


class ToolOutcome(Enum):
    """Tool execution outcome (tri-state).

    Distinct from the ``ToolResult`` dataclass below, which carries the
    full structured payload of a ``Tool.call()``.
    """
    SUCCESS = "success"
    FAILURE = "failure"
    ERROR = "error"


@dataclass
class Memory:
    """Append-only persistent knowledge entry.

    Never mutated after creation. Confidence may shift, but the entry remains.
    Implements the Remember stage of the Convergence Loop.
    """
    id: str
    timestamp: datetime
    source: str  # which tool/agent/observation produced this?
    confidence: float  # 0.0-1.0: how much do we trust this?
    content: Dict[str, Any]  # the actual data
    evidence_ids: List[str] = field(default_factory=list)  # which memories support this?

    def to_jsonl(self) -> str:
        """Serialize to JSONL format."""
        return json.dumps({
            "id": self.id,
            "timestamp": self.timestamp.isoformat(),
            "source": self.source,
            "confidence": self.confidence,
            "content": self.content,
            "evidence_ids": self.evidence_ids,
        })


@dataclass
class Task:
    """Goal-driven work unit with explicit constraints and status.

    Implements the basis for coordinated execution. Every task has:
    - A concrete goal
    - Explicit constraints (must do X, must not do Y)
    - Status tracking
    - Dependency graph
    """
    id: str
    goal: str
    constraints: List[str]  # must follow these rules
    status: TaskStatus = TaskStatus.QUEUED
    required_memories: List[str] = field(default_factory=list)  # which Memory.ids must exist?
    dependencies: List[str] = field(default_factory=list)  # which Task.ids must complete first?
    created_at: datetime = field(default_factory=datetime.now)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    def is_blocked(self, completed_tasks: List[str]) -> Tuple[bool, List[str]]:
        """Check if this task can run (all dependencies completed).

        Returns: (is_blocked, list_of_blocking_task_ids)
        """
        blocking = [dep for dep in self.dependencies if dep not in completed_tasks]
        return (len(blocking) > 0, blocking)


@dataclass
class Tool:
    """Executable capability with input/output contract.

    Wraps existing routes/functions as composable tools.
    Implements the Act stage of the Convergence Loop.
    """
    name: str
    description: str
    input_schema: Dict[str, Any]  # JSON Schema
    output_schema: Dict[str, Any]  # JSON Schema

    async def call(self, input_data: Dict[str, Any]) -> "ToolResult":
        """Execute the tool and return structured result.

        Must be implemented by subclass.
        Returns: ToolResult with {success, output, confidence}
        """
        raise NotImplementedError("Subclass must implement call()")


@dataclass
class ToolResult:
    """Structured result from Tool.call().

    Always includes success indicator and confidence scoring,
    enabling downstream reasoning to gauge trustworthiness.
    """
    success: bool
    output: Dict[str, Any]
    confidence: float  # 0.0-1.0: how much do we trust this output?
    error: Optional[str] = None
    tool_name: Optional[str] = None


@dataclass
class ConvergenceRecord:
    """One cycle of reasoning: hypothesis → evidence → result → confidence.

    Captures the complete reasoning cycle and grounds it in observable evidence.
    Forms the basis for learning, verification, and pattern extraction.

    Implements all six stages:
    - Observe: captured in evidence_ids
    - Remember: evidence_ids point to memories
    - Reason: hypothesis field
    - Act: result field (decision/action)
    - Verify: confidence updated post-facto
    - Converge: high-confidence records become patterns
    """
    id: str
    hypothesis: str  # What we think is true / the claim
    evidence_ids: List[str]  # Which memories support this?
    result: Any  # The decision/action/claim
    confidence: float  # 0.0-1.0: how certain are we?
    reasoner: str  # Which tool/agent produced this?
    timestamp: datetime = field(default_factory=datetime.now)
    verified: bool = False  # Has this been tested?
    verification_notes: Optional[str] = None
    source: Optional[str] = None  # External Reality Rule: where did this come from?
    # G9 (#764): hashes of verification evidence already folded into `confidence`,
    # keyed (record_id, evidence_hash). Re-applying the same test/NIS reading is then
    # idempotent, so replaying one passing test can no longer ratchet confidence → 1.0.
    # See src/convergence/verify.py.
    applied_evidence: List[str] = field(default_factory=list)

    def to_jsonl(self) -> str:
        """Serialize to JSONL format."""
        return json.dumps({
            "id": self.id,
            "hypothesis": self.hypothesis,
            "evidence_ids": self.evidence_ids,
            "result": self.result,
            "confidence": self.confidence,
            "reasoner": self.reasoner,
            "timestamp": self.timestamp.isoformat(),
            "verified": self.verified,
            "verification_notes": self.verification_notes,
            "source": self.source,
            "applied_evidence": self.applied_evidence,
        })
