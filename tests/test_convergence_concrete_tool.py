"""Tests for the concrete Tool that gives ``Kernel.act()`` a real body.

``convergence.concrete_tools.RepoStatTool`` is a concrete ``objects.Tool``
subclass overriding ``async call()`` to return a real ``ToolResult``. These
tests drive the full Act path through the Kernel.

Reference: convergence/concrete_tools.py, convergence/objects.py, convergence/kernel.py.

Run: python -m pytest tests/test_convergence_concrete_tool.py -q
"""

from pathlib import Path
import tempfile

import pytest

from convergence.objects import ToolResult
from convergence.kernel import Kernel
from convergence.concrete_tools import RepoStatTool


@pytest.fixture
def kernel():
    """Kernel backed by a temporary memory file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        k = Kernel(memory_path=str(Path(tmpdir) / "memory.jsonl"))
        assert k.initialize()
        yield k


@pytest.mark.asyncio
async def test_concrete_tool_registers_and_acts(kernel):
    """Register concrete Tool, reason() a record, act() sets result+confidence."""
    tmp = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8")
    try:
        tmp.write("line-1\nline-2\nline-3\n")
        tmp.close()

        tool = RepoStatTool()
        kernel.register_tool(tool)
        assert "repo-stat" in kernel.tools

        # Stage 1/2: observe the target path as a memory.
        obs = kernel.observe("test-harness", {"target_path": tmp.name}, confidence=0.99)

        # Stage 3: reason — form a hypothesis grounded in that memory.
        record = kernel.reason(
            hypothesis="The target file exists and has 3 lines",
            evidence_ids=[obs.id],
            reasoner="concrete-tool-test",
        )
        assert record.result is None  # not yet acted
        assert record.confidence == 0.5  # initial confidence

        # Stage 4: act — run the real tool body.
        result = await kernel.act("repo-stat", {"path": tmp.name}, record)

        # ToolResult success is correct for an existing file.
        assert isinstance(result, ToolResult)
        assert result.success is True
        assert result.tool_name == "repo-stat"
        assert result.output["exists"] is True
        assert result.output["is_file"] is True
        assert result.output["line_count"] == 3

        # The Kernel propagated result + confidence onto the record.
        assert record.result == result.output
        assert record.result is not None
        assert record.confidence == result.confidence == 1.0
    finally:
        Path(tmp.name).unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_concrete_tool_reports_failure_for_missing_path(kernel):
    """Missing path -> ToolResult.success False, record still updated."""
    tool = RepoStatTool()
    kernel.register_tool(tool)

    record = kernel.reason(
        hypothesis="A nonexistent path will be reported as absent",
        evidence_ids=[],
        reasoner="concrete-tool-test",
    )

    missing = str(Path(tempfile.gettempdir()) / "definitely-not-here-9f8e7d.xyz")
    result = await kernel.act("repo-stat", {"path": missing}, record)

    assert result.success is False
    assert result.error == "path does not exist"
    assert result.output["exists"] is False
    # Even on failure, the Kernel writes result/confidence onto the record.
    assert record.result == result.output
    assert record.confidence == result.confidence


@pytest.mark.asyncio
async def test_concrete_tool_rejects_malformed_input(kernel):
    """Malformed input -> success False, error set, zero confidence."""
    tool = RepoStatTool()
    result = await tool.call({})  # no 'path' key
    assert result.success is False
    assert result.confidence == 0.0
    assert result.error is not None
    assert result.tool_name == "repo-stat"


def test_act_rejects_unregistered_tool(kernel):
    """Sanity: Kernel.act on an unknown tool raises ValueError."""
    import asyncio

    record = kernel.reason("noop", [], "concrete-tool-test")
    with pytest.raises(ValueError):
        asyncio.run(kernel.act("no-such-tool", {}, record))
