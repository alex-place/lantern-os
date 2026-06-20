"""Convergence Model Σ₀ core components.

Four immutable objects:
- Memory: append-only persistent knowledge
- Task: goal + constraints + status
- Tool: executable capability with I/O contract
- ConvergenceRecord: hypothesis + evidence + result + confidence

Six-stage loop:
1. Observe: ingest external state
2. Remember: store and query persistent knowledge
3. Reason: form hypotheses using memory
4. Act: execute tools
5. Verify: check outcomes against reality
6. Converge: extract patterns and improve

Reference: CONVERGANCE-SIGMA0-BRIEFING.md
"""

from .objects import Memory, Task, Tool, ToolOutcome, ToolResult, ConvergenceRecord, TaskStatus
from .kernel import Kernel
from .research import ResearchLoop, ResearchProgram, ResearchReport, ResearchClaim

__all__ = [
    "Memory",
    "Task",
    "Tool",
    "ToolOutcome",
    "ToolResult",
    "ConvergenceRecord",
    "TaskStatus",
    "Kernel",
    "ResearchLoop",
    "ResearchProgram",
    "ResearchReport",
    "ResearchClaim",
]
