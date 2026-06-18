"""
Lantern OS MCP Server
FastAPI + SSE transport for Model Context Protocol.

Endpoints:
  GET /sse        — SSE connection for MCP clients
  POST /messages  — Message endpoint for client→server RPC
  GET /health     — Health check

Tools exposed:
  queue_status    — View work queue depth and tasks
  task_intake     — Submit a task to the queue
  dispatch_work   — Dispatch to an orchestrator agent
  boot_check      — Check orchestrator boot status
  list_skills     — List available skills
  get_status      — Overall system status
"""

import os
import sys
import json
import uuid
import asyncio
import logging
import time
import secrets
import hashlib
import base64
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from pathlib import Path
from urllib.parse import urlencode

# Mesh bridge for P2P coordination
from mesh_bridge import get_mesh_bridge, MeshBridge, HTTPX_AVAILABLE

REPO_ROOT = Path(__file__).resolve().parents[2]

# Load local env overrides if present
try:
    from dotenv import load_dotenv
    load_dotenv(REPO_ROOT / ".env.local")
except Exception:
    pass

# Agent tool hooks + CSF cache enforcement
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    from agent_tool_hooks import ToolHookRegistry
    HOOKS_AVAILABLE = True
except Exception as exc:
    logger = logging.getLogger("lantern.mcp")
    logger.warning("agent_tool_hooks not available: %s", exc)
    HOOKS_AVAILABLE = False

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("lantern.mcp")

# FastAPI + SSE
try:
    from fastapi import FastAPI, Request, HTTPException, Form
    from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse
    from fastapi.middleware.cors import CORSMiddleware
    from starlette.background import BackgroundTask
    import uvicorn
    FASTAPI_AVAILABLE = True
except ImportError as e:
    FASTAPI_AVAILABLE = False
    logger.critical("fastapi/uvicorn not installed: %s", e)
    sys.exit(1)

# Optional: OpenAI Agents SDK for native MCP server support
try:
    from agents.mcp.server import MCPServer as AgentsMCPServer
    from agents.mcp.server import MCPServerSse as AgentsMCPServerSse
    AGENTS_SDK_AVAILABLE = True
except ImportError:
    AGENTS_SDK_AVAILABLE = False

app = FastAPI(title="Lantern OS MCP Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://chat.openai.com", "https://chatgpt.com", "https://grok.com", "https://claude.ai", "*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ── Auth ──
_MCP_API_KEY = os.getenv("MCP_API_KEY", "")
_OAUTH_CLIENT_ID = os.getenv("MCP_OAUTH_CLIENT_ID", "chatgpt")
_MCP_BASE_URL = os.getenv("MCP_BASE_URL", "https://mcp.lantern-os.net")

# In-memory OAuth state (process-lifetime; restarts invalidate tokens — acceptable for single-user)
_auth_codes: Dict[str, Dict[str, Any]] = {}   # code  -> {client_id, redirect_uri, code_challenge, scope, expires}
_access_tokens: Dict[str, Dict[str, Any]] = {}  # token -> {client_id, scope, expires}


def _check_mcp_auth(request: "Request") -> bool:
    """Accept Bearer OAuth token, static API key, or open (no key configured)."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
        if _MCP_API_KEY and token == _MCP_API_KEY:
            return True
        entry = _access_tokens.get(token)
        if entry and entry.get("expires", 0) > time.time():
            return True
        # Prune expired token
        _access_tokens.pop(token, None)
        return not bool(_MCP_API_KEY)
    if request.headers.get("X-API-Key", "") and request.headers.get("X-API-Key") == _MCP_API_KEY:
        return True
    return not bool(_MCP_API_KEY)  # open when no key is set

# ── Fleet status — loaded from file, not hardcoded ──
_FLEET_STATUS_PATH = REPO_ROOT / "data" / "status" / "super-jarvis-fleet.json"
_AGENTS_CONFIG_PATH = REPO_ROOT / "config" / "agents.json"

# ── MCP Resources — large files exposed as URI-addressable contexts ──
# Refactored from blob reads (fs.readFileSync) to MCP resource URIs.
# Connectors should reference these by URI instead of embedding full text.
_RESOURCES_REGISTRY = {
    "pcsf://model":        REPO_ROOT / "data" / "pcsf" / "model.pcsf.json",
    "pcsf://agent":        REPO_ROOT / "data" / "pcsf" / "agent.pcsf.json",
    "pcsf://settings":     REPO_ROOT / "data" / "pcsf" / "settings.pcsf.json",
    "pcsf://narrator":     REPO_ROOT / "data" / "pcsf" / "narrator.pcsf.json",
    "pcsf://provider":     REPO_ROOT / "data" / "pcsf" / "provider.pcsf.json",
    "pcsf://health":       REPO_ROOT / "data" / "pcsf" / "health.pcsf.json",
    "rag://house":         REPO_ROOT / "data" / "internal-rag-house" / "LANTERN-OS-INTERNAL-HOUSE-RAG.flat.md",
    "rag://manifest":      REPO_ROOT / "data" / "internal-rag-house" / "RAG-HOUSE-MANIFEST.json",
    "rag://readme":        REPO_ROOT / "data" / "internal-rag-house" / "README.md",
    "context://personas":  REPO_ROOT / "data" / "contexts" / "personas.json",
    "context://doors":     REPO_ROOT / "data" / "contexts" / "doors.json",
    "context://doors-instruction": REPO_ROOT / "data" / "contexts" / "doors-instruction.md",
    "context://keystone-debug":    REPO_ROOT / "data" / "contexts" / "keystone-debug.md",
}


def _resolve_resource(uri: str) -> Optional[Path]:
    """Resolve an MCP resource URI to a filesystem path. Returns None if not found."""
    # Exact match first
    if uri in _RESOURCES_REGISTRY:
        return _RESOURCES_REGISTRY[uri]
    # Directory listing for csf://memory and journal://entries
    if uri == "csf://memory":
        return REPO_ROOT / "data" / "csf_memory"
    if uri == "journal://entries":
        return REPO_ROOT / "data" / "dream_journal"
    return None


def _read_resource(uri: str) -> Optional[Dict[str, Any]]:
    """Read an MCP resource by URI. Returns dict with contents, mimeType, text, or blob."""
    path = _resolve_resource(uri)
    if not path:
        return None
    if not path.exists():
        return None

    # Directory listing
    if path.is_dir():
        files = sorted([p.name for p in path.iterdir() if p.is_file()])[:50]
        return {
            "uri": uri,
            "mimeType": "application/json",
            "text": json.dumps({"uri": uri, "type": "directory", "files": files}, indent=2),
        }

    # Single file
    suffix = path.suffix.lower()
    mime = {
        ".json": "application/json",
        ".md": "text/markdown",
        ".txt": "text/plain",
        ".yaml": "application/yaml",
        ".yml": "application/yaml",
    }.get(suffix, "text/plain")

    try:
        text = path.read_text(encoding="utf-8")
        return {
            "uri": uri,
            "mimeType": mime,
            "text": text,
        }
    except Exception as exc:
        logger.warning("Failed to read resource %s: %s", uri, exc)
        return None

def _load_fleet_status() -> Dict[str, Any]:
    """Load fleet status from data/status/super-jarvis-fleet.json.
    Returns honest counts: designed slots from config, active slots from status file.
    Never fabricates live worker counts."""
    designed_slots = 36  # from agents.json designedRingSlots
    active_slots = 0
    sleeping_slots = 0
    claim_boundary = "design contract only; live worker counts require local orchestrator evidence"

    # Load designed slot count from agents config
    try:
        if _AGENTS_CONFIG_PATH.exists():
            agents_cfg = json.loads(_AGENTS_CONFIG_PATH.read_text(encoding="utf-8"))
            designed_slots = agents_cfg.get("designedRingSlots", designed_slots)
            claim_boundary = agents_cfg.get("fleetClaimBoundary", claim_boundary)
    except Exception as exc:
        logger.warning("Could not read agents config: %s", exc)

    # Load live status from fleet status file
    try:
        if _FLEET_STATUS_PATH.exists():
            fleet = json.loads(_FLEET_STATUS_PATH.read_text(encoding="utf-8"))
            active_slots = fleet.get("activeSlots", 0)
            sleeping_slots = fleet.get("sleepingSlots", designed_slots)
            claim_boundary = fleet.get("fleetClaimBoundary", claim_boundary)
    except Exception as exc:
        logger.warning("Could not read fleet status file: %s", exc)

    return {
        "designed_ring_slots": designed_slots,
        "active_slots": active_slots,
        "sleeping_slots": sleeping_slots,
        "claim_boundary": claim_boundary,
    }

_STARTED_AT = datetime.now(timezone.utc).isoformat()

# ── In-memory state (replace with Redis/DB in production) ──
_task_queue: List[Dict[str, Any]] = []

# Skills registry — only skills with real deployed Python modules.
# super_jarvis_fleet is NOT a skill — it is the agent fleet. See data/status/super-jarvis-fleet.json.
# kalshi_bridge removed: no Python module exists, only a standalone script (scripts/kalshi_odds.py).
_skills_db: Dict[str, Dict[str, Any]] = {
    "dream_journal":   {"enabled": True,  "version": "1.0.0", "module": "skills/dream_journal/dream_journal.py"},
    "lucid_dreaming":  {"enabled": True,  "version": "1.0.0", "module": "skills/lucid_dreaming/mild_wbtb_protocol.py"},
    "archive_curator": {"enabled": True,  "version": "1.0.0", "module": "src/discord_lounge_bot/archive_curator.py"},
    "voice_curator":   {"enabled": True,  "version": "1.0.0", "module": "src/discord_lounge_bot/voice_curator.py"},
}

def _build_boot_status() -> Dict[str, Any]:
    """Build boot status from real fleet state, not hardcoded slot counts."""
    fleet = _load_fleet_status()
    return {
        "status": "online",
        "active_slots": fleet["active_slots"],
        "sleeping_slots": fleet["sleeping_slots"],
        "designed_ring_slots": fleet["designed_ring_slots"],
        "claim_boundary": fleet["claim_boundary"],
        "started_at": _STARTED_AT,
        "version": "1.0.0",
    }

_mcp_sessions: Dict[str, asyncio.Queue] = {}

# ── SSE / MCP Protocol Helpers ──

async def _event_stream(session_id: str):
    """Yield SSE events for a given MCP session."""
    queue = asyncio.Queue()
    _mcp_sessions[session_id] = queue
    try:
        # Send endpoint event
        endpoint_url = os.getenv("MCP_MESSAGES_ENDPOINT", "/messages")
        yield f"event: endpoint\ndata: {endpoint_url}?session_id={session_id}\n\n"

        while True:
            msg = await queue.get()
            if msg is None:  # shutdown signal
                break
            data = json.dumps(msg)
            yield f"event: message\ndata: {data}\n\n"
    finally:
        _mcp_sessions.pop(session_id, None)


async def _send_to_session(session_id: str, message: Dict[str, Any]):
    """Send a JSON-RPC message to a connected session."""
    queue = _mcp_sessions.get(session_id)
    if queue:
        await queue.put(message)


# ── Tool Implementations ──

def _tool_queue_status(limit: int = 10) -> Dict[str, Any]:
    tasks = _task_queue[:limit]
    return {
        "queue_depth": len(_task_queue),
        "tasks": tasks,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _tool_task_intake(description: str, priority: str = "medium") -> Dict[str, Any]:
    task_id = str(uuid.uuid4())[:8]
    task = {
        "id": task_id,
        "description": description,
        "priority": priority,
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    _task_queue.append(task)
    # Sort by priority
    priority_order = {"high": 0, "medium": 1, "low": 2}
    _task_queue.sort(key=lambda t: priority_order.get(t["priority"], 1))
    return {
        "task_id": task_id,
        "status": "submitted",
        "queue_position": len(_task_queue),
    }


def _tool_dispatch_work(agent: str, task: str) -> Dict[str, Any]:
    dispatch_id = str(uuid.uuid4())[:8]
    return {
        "dispatch_id": dispatch_id,
        "agent": agent,
        "task": task,
        "status": "dispatched",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _tool_boot_check() -> Dict[str, Any]:
    """Check orchestrator boot status. Reports honest slot counts from fleet status file."""
    return _build_boot_status()


def _tool_list_skills() -> Dict[str, Any]:
    """List available skills. Does not include fleet agents — see fleet_status for agent fleet."""
    return {
        "skills": [
            {"name": k, **v}
            for k, v in _skills_db.items()
        ],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _tool_get_status() -> Dict[str, Any]:
    """Overall system status with honest fleet counts loaded from fleet status file."""
    fleet = _load_fleet_status()
    started = datetime.fromisoformat(_STARTED_AT)
    uptime = int((datetime.now(timezone.utc) - started).total_seconds())
    return {
        "status": "healthy",
        "uptime_seconds": uptime,
        "queue_depth": len(_task_queue),
        "active_slots": fleet["active_slots"],
        "designed_ring_slots": fleet["designed_ring_slots"],
        "claim_boundary": fleet["claim_boundary"],
        "version": "1.0.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _tool_fleet_status() -> Dict[str, Any]:
    """Read the agent fleet status directly from data/status/super-jarvis-fleet.json.
    Returns designed ring slot count, active vs sleeping slots, and the claim boundary.
    Active slots = 0 means all agents are in sleep/design mode, not live workers."""
    fleet = _load_fleet_status()
    # Also return raw slot list if available
    slots_preview: List[Dict[str, Any]] = []
    try:
        if _FLEET_STATUS_PATH.exists():
            raw = json.loads(_FLEET_STATUS_PATH.read_text(encoding="utf-8"))
            slots_preview = raw.get("slots", [])[:5]  # first 5 for preview
    except Exception:
        pass
    return {
        **fleet,
        "slots_preview": slots_preview,
        "fleet_status_file": str(_FLEET_STATUS_PATH),
        "file_exists": _FLEET_STATUS_PATH.exists(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ── Mesh / P2P Tools ──

_mesh = get_mesh_bridge()


def _tool_mesh_register_peer(name: str, mcp_url: str, messages_url: str = "", donated_resources: str = "{}") -> Dict[str, Any]:
    """Register a peer node in the P2P mesh. Peers may donate resources (agent slots, compute)."""
    resources = json.loads(donated_resources) if donated_resources else {}
    # NOTE: this is a sync wrapper; the real mesh bridge is async.
    # For the MCP tool registry we return a serializable dict.
    loop = asyncio.get_event_loop()
    result = loop.run_until_complete(_mesh.register_peer(
        name=name,
        mcp_url=mcp_url,
        messages_url=messages_url or None,
        donated_resources=resources,
    ))
    return result


def _tool_mesh_status() -> Dict[str, Any]:
    """Show P2P mesh topology: founder, peers, and aggregate donated resources."""
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(_mesh.get_topology())


def _tool_mesh_donate(peer_id: str, resources: str) -> Dict[str, Any]:
    """Update the resources a peer is willing to donate (opt-in)."""
    parsed = json.loads(resources) if resources else {}
    loop = asyncio.get_event_loop()
    result = loop.run_until_complete(_mesh.update_donation(peer_id, parsed))
    return result or {"error": "peer not found"}


def _tool_mesh_prune(max_age_seconds: float = 300.0) -> Dict[str, Any]:
    """Remove stale peers that haven't sent a heartbeat. Founder-only control."""
    loop = asyncio.get_event_loop()
    removed = loop.run_until_complete(_mesh.prune_stale_peers(max_age_seconds))
    return {"pruned": removed, "timestamp": datetime.now(timezone.utc).isoformat()}


def _tool_update_lantern_os(restart: bool = True) -> Dict[str, Any]:
    """Pull latest master, install dependencies, and optionally restart the server."""
    import subprocess
    steps = []

    try:
        pull = subprocess.run(
            ["git", "pull", "origin", "master"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=60,
        )
        steps.append({"step": "git_pull", "ok": pull.returncode == 0, "output": pull.stdout.strip() or pull.stderr.strip()})
    except Exception as exc:
        steps.append({"step": "git_pull", "ok": False, "output": str(exc)})

    try:
        npm = subprocess.run(
            ["npm", "install", "--prefix", "apps/lantern-garage"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=120,
        )
        steps.append({"step": "npm_install", "ok": npm.returncode == 0, "output": npm.stdout.strip() or npm.stderr.strip()})
    except Exception as exc:
        steps.append({"step": "npm_install", "ok": False, "output": str(exc)})

    new_version = {"commit": "unknown", "tag": "unknown"}
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=10)
        tag = subprocess.run(["git", "describe", "--tags", "--always"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=10)
        new_version = {"commit": commit.stdout.strip(), "tag": tag.stdout.strip()}
    except Exception:
        pass

    all_ok = all(s["ok"] for s in steps)
    restart_scheduled = False

    if all_ok and restart:
        try:
            if os.name == "nt":
                subprocess.Popen(
                    ["powershell.exe", "-Command", "Start-Sleep -Seconds 2; Start-Process node -ArgumentList 'apps/lantern-garage/server.js' -WindowStyle Hidden"],
                    cwd=REPO_ROOT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
                )
            else:
                subprocess.Popen(
                    ["sh", "-c", "sleep 2 && node apps/lantern-garage/server.js"],
                    cwd=REPO_ROOT, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            restart_scheduled = True
        except Exception as exc:
            steps.append({"step": "restart", "ok": False, "output": str(exc)})

    return {"ok": all_ok, "steps": steps, "version": new_version, "restart_scheduled": restart_scheduled}


def _tool_web_search(query: str, max_results: int = 5) -> Dict[str, Any]:
    """Search the web via DuckDuckGo (no API key required). Returns title, URL, and snippet for each result."""
    import urllib.request
    import urllib.parse
    import re

    try:
        url = "https://lite.duckduckgo.com/lite/"
        data = urllib.parse.urlencode({"q": query, "kl": "us-en"}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/html",
                "Accept-Language": "en-US,en;q=0.9",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        results = []
        link_pattern = re.compile(
            r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
            re.IGNORECASE | re.DOTALL,
        )
        snippet_pattern = re.compile(
            r'<td[^>]+class="result__snippet"[^>]*>(.*?)</td>',
            re.IGNORECASE | re.DOTALL,
        )

        links = link_pattern.findall(html)
        snippets = snippet_pattern.findall(html)

        for i, (href, title_raw) in enumerate(links[:max_results]):
            title = re.sub(r"<[^>]+>", "", title_raw).strip()
            if href.startswith("//"):
                href = "https:" + href
            elif href.startswith("/"):
                href = "https://duckduckgo.com" + href
            snippet = re.sub(r"<[^>]+>", "", snippets[i]).strip() if i < len(snippets) else ""
            results.append({
                "rank": i + 1,
                "title": title,
                "url": href,
                "snippet": snippet,
            })

        return {
            "success": True,
            "query": query,
            "results": results,
            "result_count": len(results),
            "source": "duckduckgo-lite",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:
        logger.exception("Web search failed")
        return {
            "success": False,
            "query": query,
            "error": str(exc),
            "hint": "DuckDuckGo lite search failed. Check network connectivity.",
        }


# ── JSON-RPC Dispatch ──

TOOLS_REGISTRY = {
    "queue_status": _tool_queue_status,
    "task_intake": _tool_task_intake,
    "dispatch_work": _tool_dispatch_work,
    "boot_check": _tool_boot_check,
    "list_skills": _tool_list_skills,
    "get_status": _tool_get_status,
    "fleet_status": _tool_fleet_status,
    "mesh_register_peer": _tool_mesh_register_peer,
    "mesh_status": _tool_mesh_status,
    "mesh_donate": _tool_mesh_donate,
    "mesh_prune": _tool_mesh_prune,
    "update_lantern_os": _tool_update_lantern_os,
    "web_search": _tool_web_search,
}

# ── GitHub tools (gh-CLI backed) — mirrors the high-value core of GitHub's MCP ──
# Act-stage tooling. Write tools honor GITHUB_WRITE_ENABLED (default on).
try:
    import github_tools
    _gh_added = github_tools.register(TOOLS_REGISTRY)
    _GITHUB_INT_PARAMS = github_tools.INT_PARAMS
    logger.info("GitHub tools registered (%d): write_enabled=%s", len(_gh_added), github_tools.WRITE_ENABLED)
except Exception as _gh_exc:  # pragma: no cover - optional module
    _GITHUB_INT_PARAMS = set()
    logger.warning("GitHub tools not loaded: %s", _gh_exc)


def _handle_jsonrpc(req: Dict[str, Any]) -> Dict[str, Any]:
    """Handle a single JSON-RPC request."""
    req_id = req.get("id")
    method = req.get("method", "")
    params = req.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {
                    "name": "lantern-os-mcp",
                    "version": "1.0.0",
                },
                "capabilities": {
                    "tools": {},
                    "logging": {},
                    "resources": {},
                },
            },
        }

    if method == "tools/list":
        tools = []
        for name, fn in TOOLS_REGISTRY.items():
            import inspect
            sig = inspect.signature(fn)
            parameters = {
                "type": "object",
                "properties": {},
                "required": [],
            }
            for param_name, param in sig.parameters.items():
                if param_name in ("limit",) or param_name in _GITHUB_INT_PARAMS:
                    parameters["properties"][param_name] = {
                        "type": "integer",
                        "default": param.default if param.default is not inspect.Parameter.empty else 10,
                    }
                elif param_name in ("description", "agent", "task", "priority"):
                    parameters["properties"][param_name] = {
                        "type": "string",
                        "default": param.default if param.default is not inspect.Parameter.empty else "",
                    }
                else:
                    parameters["properties"][param_name] = {
                        "type": "string",
                        "default": param.default if param.default is not inspect.Parameter.empty else "",
                    }
                if param.default is inspect.Parameter.empty:
                    parameters["required"].append(param_name)
            tools.append({
                "name": name,
                "description": (fn.__doc__ or "").strip(),
                "inputSchema": parameters,
            })
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": tools},
        }

    if method == "tools/call":
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})
        fn = TOOLS_REGISTRY.get(tool_name)
        if not fn:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32601,
                    "message": f"Tool '{tool_name}' not found",
                },
            }
        try:
            if HOOKS_AVAILABLE:
                registry = ToolHookRegistry(agent_id="mcp_server")
                result = registry.run(tool_name, tool_args, fn=fn, request_id=str(req_id))
            else:
                result = fn(**tool_args)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(result, default=str)}],
                    "isError": False,
                },
            }
        except Exception as exc:
            logger.exception("Tool '%s' failed with args %s", tool_name, tool_args)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error: {exc}"}],
                    "isError": True,
                },
            }

    if method == "resources/list":
        resources = []
        for uri, rpath in _RESOURCES_REGISTRY.items():
            resources.append({
                "uri": uri,
                "name": uri.split("://")[-1],
                "mimeType": _read_resource(uri,).get("mimeType", "text/plain") if _read_resource(uri,) else "text/plain",
                "size": rpath.stat().st_size if rpath.exists() else 0,
            })
        # Add directory resources
        for uri in ("csf://memory", "journal://entries"):
            resources.append({
                "uri": uri,
                "name": uri.split("://")[-1],
                "mimeType": "application/json",
                "size": 0,
            })
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"resources": resources},
        }

    if method == "resources/read":
        uri = params.get("uri", "")
        resource = _read_resource(uri)
        if not resource:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32002, "message": f"Resource '{uri}' not found"},
            }
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "contents": [{"uri": uri, **resource}],
            },
        }

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method '{method}' not found"},
    }


# ── HTTP Endpoints ──

# ── OAuth 2.1 + PKCE (required for ChatGPT connector) ──

@app.get("/.well-known/oauth-authorization-server")
async def oauth_metadata(request: Request):
    base = _MCP_BASE_URL
    return JSONResponse({
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": ["mcp"],
    })


@app.get("/oauth/authorize", response_class=HTMLResponse)
async def oauth_authorize_get(
    request: Request,
    response_type: str = "code",
    client_id: str = "",
    redirect_uri: str = "",
    code_challenge: str = "",
    code_challenge_method: str = "S256",
    state: str = "",
    scope: str = "mcp",
):
    if response_type != "code" or not code_challenge or not redirect_uri:
        return HTMLResponse("<h1>Bad Request</h1><p>Missing required OAuth parameters.</p>", status_code=400)

    hidden = (
        f'<input type="hidden" name="client_id" value="{client_id}">'
        f'<input type="hidden" name="redirect_uri" value="{redirect_uri}">'
        f'<input type="hidden" name="code_challenge" value="{code_challenge}">'
        f'<input type="hidden" name="code_challenge_method" value="{code_challenge_method}">'
        f'<input type="hidden" name="state" value="{state}">'
        f'<input type="hidden" name="scope" value="{scope}">'
    )
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lantern OS · Authorize</title>
  <style>
    body {{ font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }}
    .card {{ background: #161b22; border: 1px solid #30363d; border-radius: 12px;
             padding: 2rem 2.5rem; max-width: 420px; width: 100%; text-align: center; }}
    h1 {{ font-size: 1.4rem; margin-bottom: .5rem; }}
    p  {{ color: #8b949e; margin-bottom: 1.5rem; font-size: .95rem; }}
    .client {{ background: #21262d; border-radius: 6px; padding: .5rem 1rem;
               display: inline-block; margin-bottom: 1.5rem; font-size: .9rem; color: #79c0ff; }}
    button {{ cursor: pointer; border: none; border-radius: 6px; padding: .7rem 1.5rem;
              font-size: 1rem; font-weight: 600; transition: filter .15s; }}
    .allow  {{ background: #238636; color: #fff; margin-right: .75rem; }}
    .allow:hover {{ filter: brightness(1.15); }}
    .deny   {{ background: #21262d; color: #e6edf3; border: 1px solid #30363d; }}
    .deny:hover {{ filter: brightness(1.1); }}
  </style>
</head>
<body>
  <div class="card">
    <h1>🔦 Lantern OS</h1>
    <p>The following client is requesting access to your Lantern OS MCP tools:</p>
    <div class="client">{client_id or "Unknown client"}</div>
    <p>Granting access allows this client to call tools like <code>get_status</code>, <code>web_search</code>, and <code>task_intake</code>.</p>
    <form method="POST" action="/oauth/authorize">
      {hidden}
      <button type="submit" name="approved" value="1" class="allow">Allow</button>
      <button type="submit" name="approved" value="0" class="deny">Deny</button>
    </form>
  </div>
</body>
</html>"""
    return HTMLResponse(html)


@app.post("/oauth/authorize")
async def oauth_authorize_post(request: Request):
    form = await request.form()
    approved = str(form.get("approved", "0")) == "1"
    redirect_uri = str(form.get("redirect_uri", ""))
    state = str(form.get("state", ""))

    if not redirect_uri:
        return HTMLResponse("<h1>Bad Request</h1><p>Missing redirect_uri.</p>", status_code=400)

    if not approved:
        params = urlencode({"error": "access_denied", "state": state})
        return HTMLResponse(
            f'<meta http-equiv="refresh" content="0;url={redirect_uri}?{params}">',
            status_code=302,
            headers={"Location": f"{redirect_uri}?{params}"},
        )

    code = secrets.token_urlsafe(32)
    _auth_codes[code] = {
        "client_id": str(form.get("client_id", "")),
        "redirect_uri": redirect_uri,
        "code_challenge": str(form.get("code_challenge", "")),
        "code_challenge_method": str(form.get("code_challenge_method", "S256")),
        "scope": str(form.get("scope", "mcp")),
        "expires": time.time() + 300,  # 5-minute code lifetime
    }

    params = urlencode({"code": code, "state": state})
    return HTMLResponse(
        f'<meta http-equiv="refresh" content="0;url={redirect_uri}?{params}">',
        status_code=302,
        headers={"Location": f"{redirect_uri}?{params}"},
    )


@app.post("/oauth/token")
async def oauth_token(request: Request):
    try:
        form = await request.form()
    except Exception:
        return JSONResponse({"error": "invalid_request"}, status_code=400)

    grant_type = str(form.get("grant_type", ""))
    if grant_type != "authorization_code":
        return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)

    code = str(form.get("code", ""))
    code_verifier = str(form.get("code_verifier", ""))

    entry = _auth_codes.pop(code, None)
    if not entry:
        return JSONResponse({"error": "invalid_grant", "error_description": "unknown or expired code"}, status_code=400)
    if entry["expires"] < time.time():
        return JSONResponse({"error": "invalid_grant", "error_description": "code expired"}, status_code=400)

    # PKCE S256 verification
    digest = hashlib.sha256(code_verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    if challenge != entry["code_challenge"]:
        return JSONResponse({"error": "invalid_grant", "error_description": "PKCE verification failed"}, status_code=400)

    token = secrets.token_urlsafe(40)
    _access_tokens[token] = {
        "client_id": entry["client_id"],
        "scope": entry["scope"],
        "expires": time.time() + 60 * 60 * 24 * 30,  # 30-day tokens
    }

    return JSONResponse({
        "access_token": token,
        "token_type": "Bearer",
        "expires_in": 60 * 60 * 24 * 30,
        "scope": entry["scope"],
    })


# ── MCP Streamable HTTP transport (2024-11-05 spec) ──

@app.get("/mcp")
async def mcp_discovery(request: Request):
    """MCP server discovery / capability document."""
    if not _check_mcp_auth(request):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return JSONResponse({
        "name": "lantern-os-mcp",
        "version": "1.0.0",
        "protocolVersion": "2024-11-05",
        "capabilities": {"tools": {}, "logging": {}, "resources": {}},
        "serverInfo": {"name": "Lantern OS MCP Server", "description": "Convergence Core tools for Lantern OS"},
        "tools": list(TOOLS_REGISTRY.keys()),
    })


@app.post("/mcp")
async def mcp_streamable_http(request: Request):
    """MCP Streamable HTTP endpoint — handles single requests and batches."""
    if not _check_mcp_auth(request):
        raise HTTPException(status_code=401, detail="Unauthorized")

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}}, status_code=400)

    wants_stream = "text/event-stream" in request.headers.get("Accept", "")

    if isinstance(body, list):
        payload = [_handle_jsonrpc(r) for r in body]
    else:
        payload = _handle_jsonrpc(body)

    if wants_stream:
        async def _stream():
            yield f"data: {json.dumps(payload)}\n\n"
        return StreamingResponse(_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    return JSONResponse(payload)


# ── ChatGPT Actions: OpenAPI spec + per-tool REST endpoints ──

def _build_openapi_spec(base_url: str) -> Dict[str, Any]:
    """Generate an OpenAPI 3.1.0 spec from TOOLS_REGISTRY for ChatGPT Actions."""
    import inspect
    paths: Dict[str, Any] = {}

    for name, fn in TOOLS_REGISTRY.items():
        sig = inspect.signature(fn)
        parameters: List[Dict[str, Any]] = []
        for param_name, param in sig.parameters.items():
            has_default = param.default is not inspect.Parameter.empty
            ann = param.annotation
            if ann is int or param_name in ("limit", "max_results"):
                param_type = "integer"
            elif ann is float or param_name in ("max_age_seconds",):
                param_type = "number"
            elif ann is bool or param_name in ("restart",):
                param_type = "boolean"
            else:
                param_type = "string"

            p: Dict[str, Any] = {
                "name": param_name,
                "in": "query",
                "required": not has_default,
                "schema": {"type": param_type},
            }
            if has_default and param.default is not None:
                p["schema"]["default"] = param.default
            parameters.append(p)

        doc = (fn.__doc__ or "").strip()
        summary = doc.split("\n")[0][:120] if doc else name

        paths[f"/tools/{name}"] = {
            "get": {
                "operationId": name,
                "summary": summary,
                "description": doc,
                "deprecated": False,
                **({"parameters": parameters} if parameters else {}),
                "responses": {
                    "200": {
                        "description": "Tool result",
                        "content": {"application/json": {"schema": {"type": "object"}}},
                    }
                },
            }
        }

    spec: Dict[str, Any] = {
        "openapi": "3.1.0",
        "info": {
            "title": "Lantern OS Tools",
            "description": "Convergence Core tools: status, task queue, web search, fleet, and more.",
            "version": "1.0.0",
        },
        "servers": [{"url": base_url}],
        "paths": paths,
        "components": {"schemas": {}},
    }

    if _MCP_API_KEY:
        spec["components"]["securitySchemes"] = {
            "ApiKeyAuth": {"type": "apiKey", "in": "header", "name": "X-API-Key"}
        }
        spec["security"] = [{"ApiKeyAuth": []}]

    return spec


@app.get("/openapi.json")
async def openapi_spec(request: Request):
    """OpenAPI 3.1.0 spec — import this URL into ChatGPT Actions."""
    base = _MCP_BASE_URL
    return JSONResponse(_build_openapi_spec(base))


@app.get("/tools/{tool_name}")
async def tool_call_rest(tool_name: str, request: Request):
    """Direct REST endpoint for each tool. ChatGPT Actions GET calls land here."""
    if not _check_mcp_auth(request):
        raise HTTPException(status_code=401, detail="Unauthorized")
    fn = TOOLS_REGISTRY.get(tool_name)
    if not fn:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_name}' not found")
    # Coerce query params to the expected types using the function signature
    import inspect
    sig = inspect.signature(fn)
    kwargs: Dict[str, Any] = {}
    for param_name, param in sig.parameters.items():
        raw = request.query_params.get(param_name)
        if raw is None:
            continue
        ann = param.annotation
        try:
            if ann is int or param_name in ("limit", "max_results"):
                kwargs[param_name] = int(raw)
            elif ann is float or param_name in ("max_age_seconds",):
                kwargs[param_name] = float(raw)
            elif ann is bool or param_name in ("restart",):
                kwargs[param_name] = raw.lower() in ("1", "true", "yes")
            else:
                kwargs[param_name] = raw
        except (ValueError, TypeError):
            kwargs[param_name] = raw
    try:
        result = fn(**kwargs)
        return JSONResponse(result)
    except TypeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.exception("Tool '%s' REST call failed", tool_name)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/health")
async def health():
    start = time.time()
    fleet = _load_fleet_status()
    mesh = await _mesh.get_topology()
    result = {
        "status": "online",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "active_slots": fleet["active_slots"],
        "designed_ring_slots": fleet["designed_ring_slots"],
        "claim_boundary": fleet["claim_boundary"],
        "queue_depth": len(_task_queue),
        "mesh_peers": mesh["peer_count"],
        "mesh_donors": mesh["donor_count"],
        "response_time_ms": round((time.time() - start) * 1000, 2),
    }
    return result


@app.get("/mesh/topology")
async def mesh_topology():
    """Expose mesh topology as a plain HTTP endpoint (no SSE required)."""
    return await _mesh.get_topology()


@app.get("/resource")
async def resource_list():
    """List all available MCP resources as plain HTTP JSON (no SSE required)."""
    resources = []
    for uri, rpath in _RESOURCES_REGISTRY.items():
        resources.append({
            "uri": uri,
            "name": uri.split("://")[-1],
            "mimeType": _read_resource(uri).get("mimeType", "text/plain") if _read_resource(uri) else "text/plain",
            "size": rpath.stat().st_size if rpath.exists() else 0,
        })
    for uri in ("csf://memory", "journal://entries"):
        resources.append({
            "uri": uri,
            "name": uri.split("://")[-1],
            "mimeType": "application/json",
            "size": 0,
        })
    return {"resources": resources}


@app.get("/resource/{uri:path}")
async def resource_read(uri: str):
    """Read a single MCP resource by URI as plain HTTP (no SSE required).
    URI scheme separator : is encoded as %3A by most clients; we accept both.
    """
    # Decode common encodings
    decoded = uri.replace("%3A", ":").replace("%2F", "/")
    resource = _read_resource(decoded)
    if not resource:
        raise HTTPException(status_code=404, detail=f"Resource '{decoded}' not found")
    return resource


@app.get("/sse")
async def sse_endpoint(request: Request):
    session_id = request.query_params.get("session_id", str(uuid.uuid4()))
    return StreamingResponse(
        _event_stream(session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@app.post("/messages")
async def messages_endpoint(request: Request):
    """Receive JSON-RPC messages from MCP client."""
    session_id = request.query_params.get("session_id", "")
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        logger.warning("Invalid JSON from session %s: %s", session_id, exc)
        return JSONResponse({"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}}, status_code=400)
    except Exception as exc:
        logger.warning("Unexpected request error from session %s: %s", session_id, exc)
        return JSONResponse({"jsonrpc": "2.0", "error": {"code": -32603, "message": "Internal error"}}, status_code=500)

    if not body:
        logger.warning("Empty body from session %s", session_id)
        return JSONResponse({"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid Request"}}, status_code=400)

    if isinstance(body, list):
        # Batch request
        results = [_handle_jsonrpc(req) for req in body]
        for resp in results:
            await _send_to_session(session_id, resp)
        return JSONResponse({"status": "batch processed"})
    else:
        result = _handle_jsonrpc(body)
        await _send_to_session(session_id, result)
        return JSONResponse(result)


@app.get("/")
async def root():
    mesh = await _mesh.get_topology()
    return {
        "name": "Lantern OS MCP Server",
        "version": "1.0.0",
        "endpoints": ["/sse", "/messages", "/health", "/mesh/topology", "/resource"],
        "tools": list(TOOLS_REGISTRY.keys()),
        "mesh": {
            "founder_id": mesh["founder_id"],
            "peer_count": mesh["peer_count"],
            "donor_count": mesh["donor_count"],
            "aggregate_donated_resources": mesh["aggregate_donated_resources"],
        },
    }


# ── Main ──

if __name__ == "__main__":
    port = int(os.getenv("MCP_SERVER_PORT", "8771"))
    host = os.getenv("MCP_SERVER_HOST", "127.0.0.1")
    logger.info("Lantern OS MCP Server starting on http://%s:%s", host, port)
    logger.info("Tools available: %s", list(TOOLS_REGISTRY.keys()))
    logger.info("Mesh mode: founder control + opt-in peer donations")
    uvicorn.run(app, host=host, port=port, log_level="info")
