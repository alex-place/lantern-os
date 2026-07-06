"""Convergence Model Σ₀ Kernel — Core orchestration loop.

The Kernel implements the six-stage loop that is the sole abstraction of Lantern OS:
1. Observe — ingest external state
2. Remember — store and query persistent knowledge
3. Reason — form hypotheses using memory
4. Act — execute tools based on reasoning
5. Verify — check outcomes against reality
6. Converge — extract patterns and improve

Reference: CONVERGANCE-SIGMA0-BRIEFING.md, convergence-core-mapping.md
"""

from datetime import datetime
from typing import Any, Dict, List, Optional
import json
import uuid
from pathlib import Path

from .objects import Memory, Task, Tool, ConvergenceRecord, TaskStatus


class Kernel:
    """Orchestrator for the six-stage Convergence Loop.

    The Kernel manages:
    - Task lifecycle (queued → assigned → in_progress → completed)
    - Memory persistence (append-only JSONL)
    - Tool registry and execution
    - Convergence record generation
    - Stage transitions
    """

    def __init__(self, memory_path: str = "data/memory.jsonl", codebase_index_path: Optional[str] = None):
        """Initialize the Kernel with persistent memory.

        Args:
            memory_path: Path to append-only memory log
            codebase_index_path: Optional path to codebase understanding
        """
        self.memory_path = Path(memory_path)
        self.codebase_index_path = codebase_index_path
        self.memory: Dict[str, Memory] = {}
        self.tools: Dict[str, Tool] = {}
        self.convergence_records: List[ConvergenceRecord] = []
        self.current_task: Optional[Task] = None
        self.completed_tasks: List[str] = []
        self.components: Dict[str, bool] = {}
        self.health: Dict[str, Any] = {}

        # Ensure memory file exists
        self.memory_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.memory_path.exists():
            self.memory_path.touch()

    def initialize(self) -> bool:
        """Bootstrap the Kernel: load memory, wire all core objects, health-check.

        Wires the four core objects (Memory, Task, Tool, ConvergenceRecord) and the
        optional Convergence components (router, verify) when present, then records a
        startup health check in `self.health`.

        Returns: True if core systems initialized successfully.
        """
        try:
            # Load existing memory from disk
            self._load_memory_from_disk()

            # Verify core components
            assert self.memory_path.exists(), "Memory file not found"
            assert self.memory_path.parent.exists(), "Memory directory not found"

            # Startup health check across all wired objects/stages.
            self.health = self.health_check()
            self.components = self.health["components"]
            return self.health["ok"]
        except Exception as e:
            print(f"Kernel initialization failed: {e}")
            return False

    def health_check(self) -> Dict[str, Any]:
        """Report operational status of each core object and loop stage.

        Core objects (memory, tools registry, convergence records) gate `ok`.
        The router (wq-006) and verify (wq-007) modules are optional capabilities:
        reported, but their absence does not fail the core.
        """
        components: Dict[str, bool] = {
            "memory": self.memory_path.exists() and self.memory_path.parent.exists(),
            "tools_registry": isinstance(self.tools, dict),
            "convergence_records": isinstance(self.convergence_records, list),
        }
        try:
            from .convergence_router import route_to_record  # noqa: F401
            components["router"] = True
        except Exception:
            components["router"] = False
        try:
            from .verify import verify_with_test  # noqa: F401
            components["verify"] = True
        except Exception:
            components["verify"] = False

        core_ok = (components["memory"] and components["tools_registry"]
                   and components["convergence_records"])
        return {
            "ok": core_ok,
            "components": components,
            "memory_count": len(self.memory),
            "tools_count": len(self.tools),
            "records_count": len(self.convergence_records),
            "completed_tasks": len(self.completed_tasks),
        }

    def register_tool(self, tool: Tool) -> None:
        """Register an executable tool with the Kernel.

        Args:
            tool: Tool object with call() method
        """
        self.tools[tool.name] = tool

    # ========== Stage 1: Observe ==========
    def observe(self, source: str, data: Dict[str, Any], confidence: float = 0.9) -> Memory:
        """Capture external state as a Memory entry.

        Args:
            source: Origin of observation (tool name, agent name)
            data: The observed data
            confidence: How much to trust this observation (default: 0.9)

        Returns: Memory object representing the observation
        """
        memory = Memory(
            id=f"mem-{datetime.now().timestamp()}-{uuid.uuid4().hex[:6]}",
            timestamp=datetime.now(),
            source=source,
            confidence=confidence,
            content=data
        )
        self.memory[memory.id] = memory
        self._append_to_disk(memory)  # Automatically persist observations
        return memory

    # ========== Stage 2: Remember ==========
    def append_memory(self, memory: Memory) -> None:
        """Append a memory to persistent storage.

        Args:
            memory: Memory object to persist
        """
        self.memory[memory.id] = memory
        self._append_to_disk(memory)

    def query_memory(
        self,
        pattern: str,
        min_confidence: float = 0.5,
        order_by: Optional[str] = None,
        limit: int = 10,
    ) -> List[Memory]:
        """Query persistent memory for relevant entries.

        Args:
            pattern: Pattern to search in memory source/content
            min_confidence: Minimum confidence threshold
            order_by: Field to sort by (timestamp, confidence)
            limit: Max results

        Returns: List of matching Memory objects
        """
        results = []
        pattern_lower = pattern.lower()

        for mem in self.memory.values():
            if mem.confidence < min_confidence:
                continue

            # Pattern matching on source
            if pattern_lower in mem.source.lower():
                results.append(mem)
                continue

            # Pattern matching on content (search all values)
            try:
                content_str = json.dumps(mem.content, default=str).lower()
                if pattern_lower in content_str:
                    results.append(mem)
            except (TypeError, ValueError):
                # If content can't be JSON serialized, convert to string
                if pattern_lower in str(mem.content).lower():
                    results.append(mem)

        # Sort if requested
        if order_by == "timestamp":
            results.sort(key=lambda m: m.timestamp)
        elif order_by == "confidence":
            results.sort(key=lambda m: m.confidence, reverse=True)

        return results[:limit]

    # ========== Stage 3: Reason ==========
    def reason(
        self,
        hypothesis: str,
        evidence_ids: List[str],
        reasoner: str,
    ) -> ConvergenceRecord:
        """Form a hypothesis grounded in memory evidence.

        Args:
            hypothesis: The claim being tested
            evidence_ids: Memory IDs supporting the hypothesis
            reasoner: Name of reasoning agent/tool

        Returns: ConvergenceRecord capturing the reasoning
        """
        record = ConvergenceRecord(
            id=f"rec-{datetime.now().timestamp()}-{uuid.uuid4().hex[:6]}",
            hypothesis=hypothesis,
            evidence_ids=evidence_ids,
            result=None,  # Will be set by Act stage
            confidence=0.5,  # Initial confidence (low until verified)
            reasoner=reasoner,
        )
        self.convergence_records.append(record)
        return record

    # ========== Stage 4: Act ==========
    async def act(self, tool_name: str, input_data: Dict[str, Any], record: ConvergenceRecord) -> Any:
        """Execute a tool and capture result in convergence record.

        Args:
            tool_name: Name of tool to execute
            input_data: Input to the tool
            record: ConvergenceRecord to update with result

        Returns: Tool output
        """
        if tool_name not in self.tools:
            raise ValueError(f"Tool '{tool_name}' not registered")

        tool = self.tools[tool_name]
        result = await tool.call(input_data)

        # Update convergence record with result
        record.result = result.output
        record.confidence = result.confidence

        return result

    # ========== Stage 5: Verify ==========
    def verify(
        self,
        record: ConvergenceRecord,
        actual_outcome: Any,
        success: bool,
    ) -> None:
        """Verify that predicted outcome matches reality.

        Updates confidence post-facto based on verification results.

        Args:
            record: ConvergenceRecord to verify
            actual_outcome: What actually happened
            success: Whether prediction was correct
        """
        record.verified = True
        record.verification_notes = f"Predicted: {record.result}, Actual: {actual_outcome}, Success: {success}"

        # Update confidence based on verification
        if success:
            # Successful predictions → increase confidence
            record.confidence = min(1.0, record.confidence + 0.1)
        else:
            # Failed predictions → decrease confidence
            record.confidence = max(0.0, record.confidence - 0.2)

    # ========== Stage 6: Converge ==========
    def extract_patterns(self, min_confidence: float = 0.85) -> List[Dict[str, Any]]:
        """Extract high-confidence patterns from convergence records.

        Identifies patterns that can be stored as memories for faster reasoning.

        Args:
            min_confidence: Confidence threshold for pattern extraction

        Returns: List of extracted patterns
        """
        high_confidence = [
            rec for rec in self.convergence_records
            if rec.confidence >= min_confidence and rec.verified
        ]

        patterns = []
        for record in high_confidence:
            pattern = {
                "hypothesis": record.hypothesis,
                "success_rate": record.confidence,
                "evidence_count": len(record.evidence_ids),
                "reasoner": record.reasoner,
            }
            patterns.append(pattern)

        return patterns

    PATTERN_SOURCE = "convergence_pattern"

    def compile_patterns(self, min_confidence: float = 0.85) -> List[Memory]:
        """Compile high-confidence convergence records into reusable pattern MEMORIES (#2085).

        Closes the Converge→Remember→Reason feedback loop: `extract_patterns()` finds the
        verified, high-confidence records, and this writes each as a ``Memory`` into the SAME
        append-only store (``memory_path``) that ``reason()``/``query_memory()`` already read —
        no new store, so Reason retrieves patterns exactly like any other memory.

        Idempotent: a pattern whose hypothesis is already stored is skipped, so a periodic job
        can run every cycle without duplicating. Returns the pattern memories written this call.
        """
        already = {
            m.content.get("hypothesis")
            for m in self.memory.values()
            if m.source == self.PATTERN_SOURCE and isinstance(m.content, dict)
        }
        written: List[Memory] = []
        for pat in self.extract_patterns(min_confidence):
            if pat["hypothesis"] in already:
                continue  # idempotent — already compiled into memory
            mem = Memory(
                id=f"pat-{datetime.now().timestamp()}-{uuid.uuid4().hex[:6]}",
                timestamp=datetime.now(),
                source=self.PATTERN_SOURCE,
                confidence=pat["success_rate"],
                content={"kind": "pattern", **pat},
            )
            self.append_memory(mem)          # -> self.memory + _append_to_disk (existing store)
            already.add(pat["hypothesis"])
            written.append(mem)
        return written

    def get_convergence_metrics(self) -> Dict[str, Any]:
        """Get metrics on system convergence and learning.

        Returns: Dict with convergence stats
        """
        verified_records = [rec for rec in self.convergence_records if rec.verified]
        if not verified_records:
            return {
                "total_records": len(self.convergence_records),
                "verified_records": 0,
                "average_confidence": 0.0,
                "success_rate": 0.0,
            }

        avg_confidence = sum(rec.confidence for rec in verified_records) / len(verified_records)
        successful = sum(1 for rec in verified_records if rec.confidence > 0.7)

        return {
            "total_records": len(self.convergence_records),
            "verified_records": len(verified_records),
            "average_confidence": avg_confidence,
            "success_rate": successful / len(verified_records) if verified_records else 0.0,
            "patterns_extracted": len(self.extract_patterns()),
        }

    # ========== Persistence ==========
    def _load_memory_from_disk(self) -> None:
        """Load existing memories from JSONL file."""
        if not self.memory_path.exists():
            return

        with open(self.memory_path, "r") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    mem = Memory(
                        id=data["id"],
                        timestamp=datetime.fromisoformat(data["timestamp"]),
                        source=data["source"],
                        confidence=data["confidence"],
                        content=data["content"],
                        evidence_ids=data.get("evidence_ids", []),
                    )
                    self.memory[mem.id] = mem
                except json.JSONDecodeError:
                    continue

    def _append_to_disk(self, memory: Memory) -> None:
        """Append memory to JSONL file."""
        with open(self.memory_path, "a") as f:
            f.write(memory.to_jsonl() + "\n")

    def save_convergence_record(self, record: ConvergenceRecord, path: str = "data/convergence-records.jsonl") -> None:
        """Save a convergence record to persistent storage."""
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as f:
            f.write(record.to_jsonl() + "\n")

    def load_records_from_disk(self, path: str = "data/convergence-records.jsonl") -> int:
        """Load persisted ConvergenceRecords (written by ``save_convergence_record``) back into
        ``self.convergence_records`` — the mirror of ``_load_memory_from_disk`` for records.

        A periodic ``compile_patterns`` job needs the full record history, and records were
        write-only until now (there was a saver but no loader, #2085). Returns count loaded.
        """
        p = Path(path)
        if not p.exists():
            return 0
        loaded = 0
        with open(p, "r") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    d = json.loads(line)
                    rec = ConvergenceRecord(
                        id=d["id"],
                        hypothesis=d["hypothesis"],
                        evidence_ids=d.get("evidence_ids", []),
                        result=d.get("result"),
                        confidence=d.get("confidence", 0.5),
                        reasoner=d.get("reasoner", ""),
                    )
                    rec.verified = bool(d.get("verified", False))
                    rec.verification_notes = d.get("verification_notes")
                    if d.get("timestamp"):
                        try:
                            rec.timestamp = datetime.fromisoformat(d["timestamp"])
                        except (ValueError, TypeError):
                            pass
                    self.convergence_records.append(rec)
                    loaded += 1
                except (json.JSONDecodeError, KeyError):
                    continue
        return loaded
