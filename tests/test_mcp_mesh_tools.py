"""#2100 — mesh MCP tools must actually work when dispatched inside the server's
running event loop.

The original wrappers called ``loop.run_until_complete(...)`` from a sync
function, which raises "This event loop is already running" on every live call
(verified against the running server during the audit) — i.e. the tools were
registered but non-functional. The fix makes them ``async def`` and teaches
both dispatch sites (JSON-RPC ``tools/call`` + ``GET /tools/{name}``) to await
awaitable results.
"""
from __future__ import annotations

import asyncio
import inspect
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MCP_DIR = REPO_ROOT / "src" / "mcp_server"
if str(MCP_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_DIR))

import server  # noqa: E402


def test_mesh_tools_are_async_and_registered():
    for name in ("mesh_register_peer", "mesh_status", "mesh_donate", "mesh_prune"):
        fn = server.TOOLS_REGISTRY[name]
        assert inspect.iscoroutinefunction(fn), (
            f"{name} must be async — a sync run_until_complete wrapper deadlocks "
            "or errors inside the server's running loop (#2100)"
        )


def test_mesh_register_status_prune_round_trip():
    """Drive the real MeshBridge through the tool wrappers in one event loop —
    the same loop discipline the live server has (its asyncio.Lock is loop-bound)."""

    async def scenario():
        reg = await server._tool_mesh_register_peer(
            name="pytest-2100-probe", mcp_url="http://127.0.0.1:9/dead")
        topo = await server._tool_mesh_status()
        pruned = await server._tool_mesh_prune(max_age_seconds=0.0)
        return reg, topo, pruned

    reg, topo, pruned = asyncio.run(scenario())
    assert isinstance(reg, dict) and reg, "register_peer must return the peer record"
    assert isinstance(topo, dict) and topo.get("peers") is not None, (
        f"mesh_status must return a topology dict, got {topo!r}")
    assert isinstance(pruned, dict) and "pruned" in pruned


def test_dispatchers_await_async_tools():
    """Both dispatch sites must handle awaitable results — source-level guard
    (matches the style of the other server source-inspection tests)."""
    src = (MCP_DIR / "server.py").read_text(encoding="utf-8")
    assert src.count("inspect.isawaitable(result)") >= 2, (
        "tools/call and GET /tools/{name} must both await async tool results (#2100)")
