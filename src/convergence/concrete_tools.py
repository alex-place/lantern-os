"""Concrete Tools for the Convergence Kernel Act stage.

Gives ``Kernel.act()`` a real body. ``objects.Tool`` defines the abstract
contract (``async call()`` raising ``NotImplementedError``); this module
provides a concrete subclass so the Act stage can actually execute.

``RepoStatTool`` is pure, read-only, and stdlib-only: it reports whether a path
exists and (for files) its line count — a genuine observable fact about the
repository, suitable for grounding a ConvergenceRecord.

Note: ``src/convergence/tools.py`` is a separate MCP-compatible execution layer
(ToolOutput/ToolStatus/ToolRegistry); this module is the ``objects.Tool``
realization used by the Kernel loop. Reference: convergence/objects.py,
convergence/kernel.py.
"""

from dataclasses import dataclass
from pathlib import Path

from .objects import Tool, ToolResult


@dataclass
class RepoStatTool(Tool):
    """Read-only Tool reporting file existence and line count.

    Pure and dependency-light (stdlib only). Overrides ``call()`` to return a
    real ``ToolResult``:

    - ``success=True``  when the path exists and was inspected.
    - ``success=False`` when the path is missing or the input is malformed.

    Input:  ``{"path": <str>}`` — a filesystem path to inspect.
    Output: ``{"path", "exists", "is_file", "line_count"}``.
    """

    def __init__(self) -> None:
        super().__init__(
            name="repo-stat",
            description="Report whether a path exists and its line count (read-only).",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            output_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "exists": {"type": "boolean"},
                    "is_file": {"type": "boolean"},
                    "line_count": {"type": "integer"},
                },
            },
        )

    async def call(self, input_data):  # type: ignore[override]
        path_str = input_data.get("path") if isinstance(input_data, dict) else None
        if not isinstance(path_str, str) or not path_str:
            return ToolResult(
                success=False,
                output={},
                confidence=0.0,
                error="input must include a non-empty 'path' string",
                tool_name=self.name,
            )

        path = Path(path_str)
        exists = path.exists()
        is_file = path.is_file()

        if not exists:
            # A genuine, observed negative fact — still a successful read,
            # but reported as failure so downstream reasoning can branch.
            return ToolResult(
                success=False,
                output={
                    "path": path_str,
                    "exists": False,
                    "is_file": False,
                    "line_count": 0,
                },
                confidence=1.0,  # absence is directly observable
                error="path does not exist",
                tool_name=self.name,
            )

        line_count = 0
        if is_file:
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    line_count = sum(1 for _ in fh)
            except OSError as exc:
                return ToolResult(
                    success=False,
                    output={"path": path_str, "exists": True, "is_file": True, "line_count": 0},
                    confidence=0.0,
                    error=f"failed to read file: {exc}",
                    tool_name=self.name,
                )

        return ToolResult(
            success=True,
            output={
                "path": path_str,
                "exists": True,
                "is_file": is_file,
                "line_count": line_count,
            },
            confidence=1.0,  # filesystem read is directly observable
            tool_name=self.name,
        )
