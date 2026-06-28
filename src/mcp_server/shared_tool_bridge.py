"""Bridge MCP discovery and execution to the canonical Node tool runner.

Tool names, schemas, and policies stay in tool-runner.js. This module contains
no copied capability table; it creates MCP adapters from the runtime manifest.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable, Dict, MutableMapping


REPO_ROOT = Path(__file__).resolve().parents[2]
BRIDGE_PATH = REPO_ROOT / "scripts" / "tool-runner-bridge.js"
GENERATED_MANIFEST_PATH = REPO_ROOT / "manifests" / "tool-capability-manifest-v1.json"
BRIDGE_TIMEOUT_SECONDS = 35

# ── Bridge spawn throttle ────────────────────────────────────────────────────
# Each tool execution shells out to a fresh `node tool-runner-bridge.js call`.
# The MCP server handles every tools/call on uvicorn's threadpool (default ~40
# workers), so a burst of concurrent tool calls used to fan out to ~40 node
# cold-starts at once (~40 MB each → ~1.6 GB spike) — enough to OOM a 12 GB box.
# Cap the number of bridges that run concurrently; excess calls queue on the
# semaphore instead of spawning more processes. Tune with MCP_BRIDGE_MAX_CONCURRENCY.
try:
    _MAX_BRIDGE_CONCURRENCY = max(1, int(os.getenv("MCP_BRIDGE_MAX_CONCURRENCY", "6")))
except ValueError:
    _MAX_BRIDGE_CONCURRENCY = 6
_BRIDGE_SEMAPHORE = threading.Semaphore(_MAX_BRIDGE_CONCURRENCY)
# Bound how long a single call waits for a free slot so a stuck batch can't pin
# the whole threadpool forever (timeout + headroom for the run itself).
_BRIDGE_ACQUIRE_TIMEOUT = BRIDGE_TIMEOUT_SECONDS + 15


class SharedToolBridgeError(RuntimeError):
    """The canonical Node bridge could not return a valid response."""


def _node_binary() -> str:
    configured = os.getenv("NODE_BINARY", "").strip()
    node = configured or shutil.which("node")
    if not node:
        raise SharedToolBridgeError("node_runtime_unavailable")
    return node


def _invoke(command: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    # Throttle concurrent node spawns so a burst of tool calls can't fan out into
    # dozens of simultaneous processes (RAM spike / OOM on a small box).
    if not _BRIDGE_SEMAPHORE.acquire(timeout=_BRIDGE_ACQUIRE_TIMEOUT):
        raise SharedToolBridgeError("node_bridge_overloaded: bridge concurrency cap reached")
    try:
        try:
            completed = subprocess.run(
                [_node_binary(), str(BRIDGE_PATH), command],
                cwd=str(REPO_ROOT),
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=BRIDGE_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise SharedToolBridgeError(f"node_bridge_unavailable: {exc}") from exc

        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "unknown bridge error").strip()
            raise SharedToolBridgeError(f"node_bridge_failed: {detail[:1000]}")
        try:
            response = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise SharedToolBridgeError("node_bridge_invalid_json") from exc
        if not isinstance(response, dict):
            raise SharedToolBridgeError("node_bridge_invalid_response")
        return response
    finally:
        _BRIDGE_SEMAPHORE.release()


def execution_enabled() -> bool:
    return os.getenv("CHAT_TOOL_EXEC", "") == "1"


def operator_authorized() -> bool:
    return os.getenv("MCP_SHARED_TOOL_OPERATOR", "") == "1"


def load_manifest() -> Dict[str, Any]:
    try:
        return _invoke("manifest", {"execution_enabled": execution_enabled()})
    except SharedToolBridgeError as exc:
        try:
            manifest = json.loads(GENERATED_MANIFEST_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as fallback_exc:
            raise SharedToolBridgeError(
                f"{exc}; generated_manifest_unavailable: {fallback_exc}"
            ) from fallback_exc
        manifest["execution"] = {"enabled": False, "reason": "node_bridge_unavailable"}
        for descriptor in manifest.get("tools", []):
            descriptor["execution_enabled"] = False
            descriptor["execution_disabled_reason"] = "node_bridge_unavailable"
        return manifest


def execute_tool(
    name: str,
    arguments: Dict[str, Any] | None = None,
    *,
    operator: bool | None = None,
    enabled: bool | None = None,
) -> Dict[str, Any]:
    try:
        return _invoke(
            "call",
            {
                "name": name,
                "arguments": arguments or {},
                "operator": operator_authorized() if operator is None else bool(operator),
                "execution_enabled": execution_enabled() if enabled is None else bool(enabled),
            },
        )
    except SharedToolBridgeError as exc:
        return {
            "ok": False,
            "status": "unavailable",
            "tool": name,
            "reason_code": "node_bridge_unavailable",
            "reason": "node_bridge_unavailable",
            "policy": None,
            "error": str(exc),
            "receipt": {
                "schema_version": 1,
                "tool": name,
                "status": "unavailable",
                "reason_code": "node_bridge_unavailable",
            },
        }


def _make_tool(name: str, description: str) -> Callable[..., Dict[str, Any]]:
    def shared_tool(**kwargs: Any) -> Dict[str, Any]:
        return execute_tool(name, kwargs)

    shared_tool.__name__ = f"shared_{name}"
    shared_tool.__doc__ = description
    return shared_tool


def register(
    registry: MutableMapping[str, Callable[..., Any]],
    descriptors: MutableMapping[str, Dict[str, Any]],
) -> Dict[str, Any]:
    manifest = load_manifest()
    for descriptor in manifest.get("tools", []):
        name = str(descriptor.get("name", "")).strip()
        if not name:
            continue
        descriptors[name] = dict(descriptor)
        registry[name] = _make_tool(name, str(descriptor.get("description", "")))
    return manifest
