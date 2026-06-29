"""Contract tests for the canonical Dream Chat/MCP tool surface."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
MCP_DIR = REPO_ROOT / "src" / "mcp_server"
if str(MCP_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_DIR))


def test_node_bridge_manifest_and_structured_outcomes(monkeypatch):
    import shared_tool_bridge

    monkeypatch.setenv("CHAT_TOOL_EXEC", "1")
    manifest = shared_tool_bridge.load_manifest()
    names = [tool["name"] for tool in manifest["tools"]]
    assert names == [
        "Read", "LS", "Glob", "Grep", "Bash", "PowerShell",
        "Write", "Edit", "web_search", "github_issue", "web_fetch",
        "workspace_write", "workspace_read", "workspace_list",
        "create_document", "local_eval_keystone_run",
        "list_creator_projects", "analyze_video", "creator_job_status",
    ]
    assert all(tool["surface_availability"] == {"dream_chat": True, "mcp": True}
               for tool in manifest["tools"])

    # Read is a filesystem (read-policy) tool, not guest_safe, so a non-operator is
    # denied before execution (#1213): even read-only file tools can't be run by a
    # public-server guest. Operator context is required to actually execute it.
    guest_read = shared_tool_bridge.execute_tool(
        "Read", {"file_path": "package.json", "limit": 2}, operator=False, enabled=True
    )
    assert guest_read["status"] == "denied"
    assert guest_read["reason_code"] == "operator_required"

    read = shared_tool_bridge.execute_tool(
        "Read", {"file_path": "package.json", "limit": 2}, operator=True, enabled=True
    )
    assert read["status"] == "executed"
    assert read["receipt"]["schema_version"] == manifest["receipt_schema_version"]

    denied = shared_tool_bridge.execute_tool(
        "Edit",
        {"file_path": "package.json", "old_string": "x", "new_string": "y"},
        operator=False,
        enabled=True,
    )
    assert denied["status"] == "denied"
    assert denied["reason_code"] == "operator_required"

    unsafe = shared_tool_bridge.execute_tool(
        "Read", {"file_path": "../package.json"}, operator=True, enabled=True
    )
    assert unsafe["status"] == "blocked"
    assert unsafe["reason_code"] == "unsafe_path"

    disallowed = shared_tool_bridge.execute_tool(
        "Bash", {"command": "rm -rf ."}, operator=True, enabled=True
    )
    assert disallowed["status"] == "blocked"
    assert disallowed["reason_code"] == "command_not_allowlisted"

    disabled = shared_tool_bridge.execute_tool(
        "Read", {"file_path": "package.json"}, enabled=False
    )
    assert disabled["status"] == "unavailable"
    assert disabled["reason_code"] == "chat_tool_exec_disabled"

    monkeypatch.setattr(
        shared_tool_bridge,
        "_node_binary",
        lambda: (_ for _ in ()).throw(shared_tool_bridge.SharedToolBridgeError("missing")),
    )
    fallback = shared_tool_bridge.load_manifest()
    assert len(fallback["tools"]) == 19
    assert fallback["execution"]["reason"] == "node_bridge_unavailable"
    unavailable = shared_tool_bridge.execute_tool("Read", {"file_path": "package.json"})
    assert unavailable["status"] == "unavailable"
    assert unavailable["reason_code"] == "node_bridge_unavailable"


def test_mcp_discovery_uses_runtime_manifest(monkeypatch):
    pytest.importorskip("fastapi", reason="full MCP discovery requires the server dependency set")
    monkeypatch.setenv("CHAT_TOOL_EXEC", "1")
    monkeypatch.setenv("MCP_SHARED_TOOL_OPERATOR", "0")

    import server

    response = server._handle_jsonrpc({
        "jsonrpc": "2.0",
        "id": "parity",
        "method": "tools/list",
        "params": {},
    })
    result = response["result"]
    manifest = result["sharedToolManifest"]
    by_name = {tool["name"]: tool for tool in result["tools"]}

    assert set(server.TOOL_DESCRIPTORS) == {tool["name"] for tool in manifest["tools"]}
    for descriptor in manifest["tools"]:
        exposed = by_name[descriptor["name"]]
        assert exposed["inputSchema"] == descriptor["input_schema"]
        meta = exposed["_meta"]["lantern"]
        assert meta["kind"] == "shared_capability"
        assert meta["policy"] == descriptor["policy"]
        assert meta["operator_required"] == descriptor["operator_required"]
        assert meta["surface_availability"] == descriptor["surface_availability"]
        assert meta["execution_enabled"] == descriptor["execution_enabled"]
        assert meta["execution_disabled_reason"] == descriptor["execution_disabled_reason"]
        assert meta["receipt_schema_version"] == descriptor["result_receipt_schema_version"]

    assert by_name["queue_status"]["_meta"]["lantern"]["kind"] == "mcp_specific_operational"
    assert "Read" not in (MCP_DIR / "shared_tool_bridge.py").read_text(encoding="utf-8")

    monkeypatch.setattr(server, "HOOKS_AVAILABLE", False)
    # MCP_SHARED_TOOL_OPERATOR=0 (set above) => guest context. Under #1213 even a
    # read-policy filesystem tool like Read is denied for a non-operator, so the
    # public MCP surface can't enumerate or read local files. Only guest_safe web
    # tools run without operator; Read/Write/Bash all return operator_required.
    read_call = server._handle_jsonrpc({
        "jsonrpc": "2.0",
        "id": "read",
        "method": "tools/call",
        "params": {"name": "Read", "arguments": {"file_path": "package.json", "limit": 2}},
    })
    read_result = json.loads(read_call["result"]["content"][0]["text"])
    assert read_result["status"] == "denied"
    assert read_result["reason_code"] == "operator_required"

    denied_call = server._handle_jsonrpc({
        "jsonrpc": "2.0",
        "id": "write",
        "method": "tools/call",
        "params": {
            "name": "Write",
            "arguments": {"file_path": "never-written.txt", "content": "blocked"},
        },
    })
    denied_result = json.loads(denied_call["result"]["content"][0]["text"])
    assert denied_result["status"] == "denied"
    assert denied_result["reason_code"] == "operator_required"

    shell_denied_call = server._handle_jsonrpc({
        "jsonrpc": "2.0",
        "id": "shell",
        "method": "tools/call",
        "params": {"name": "Bash", "arguments": {"command": "git status --short"}},
    })
    shell_denied = json.loads(shell_denied_call["result"]["content"][0]["text"])
    assert shell_denied["status"] == "denied"
    assert shell_denied["reason_code"] == "operator_required"
