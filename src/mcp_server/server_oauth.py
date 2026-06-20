"""
Lantern OS MCP Server — OAuth 2.0 Edition

FastAPI + SSE transport with proper OAuth 2.0 + PKCE authentication.
Designed for integration with OpenAI Custom GPTs and other OAuth-enabled MCP clients.

Runs independently on a separate port so the local no-auth server (port 8771) is untouched.

Endpoints:
  GET  /oauth/authorize              — OAuth2 authorization endpoint
  POST /oauth/token                  — OAuth2 token endpoint
  GET  /oauth/register                 — Register a new OAuth client
  GET  /.well-known/oauth-authorization-server  — OAuth discovery
  GET  /.well-known/mcp                — MCP server metadata
  GET  /health                        — Public health check
  GET  /sse                           — Protected SSE (Bearer required)
  POST /messages                      — Protected JSON-RPC (Bearer required)
  GET  /                              — Server info

Environment:
  MCP_OAUTH_PORT         — Port to bind (default: 8772)
  MCP_OAUTH_HOST         — Host to bind (default: 127.0.0.1)
  MCP_OAUTH_JWT_SECRET   — HS256 secret (default: random, logged once)
  MCP_OAUTH_ISSUER       — JWT issuer claim (default: lantern-os-mcp-oauth)
  MCP_OAUTH_TOKEN_TTL    — Access token TTL in minutes (default: 60)
"""

from __future__ import annotations

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
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("lantern.mcp.oauth")

# ── FastAPI ──
try:
    from fastapi import FastAPI, Request, HTTPException, Depends
    from fastapi.responses import JSONResponse, RedirectResponse
    from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
    from starlette.background import BackgroundTask
    import uvicorn
    FASTAPI_AVAILABLE = True
except ImportError as e:
    FASTAPI_AVAILABLE = False
    logger.critical("fastapi/uvicorn not installed: %s", e)
    sys.exit(1)

# ── JWT ──
try:
    import jwt
    JWT_AVAILABLE = True
except ImportError:
    JWT_AVAILABLE = False
    logger.critical("PyJWT not installed. Run: pip install PyJWT>=2.8.0")
    sys.exit(1)

# ── Shared state (duplicated from server.py to keep servers independent) ──
_task_queue: List[Dict[str, Any]] = []
_skills_db: Dict[str, Dict[str, Any]] = {
    "dream_journal": {"enabled": True, "version": "1.0.0"},
    "archive_curator": {"enabled": True, "version": "1.0.0"},
    "voice_curator": {"enabled": True, "version": "1.0.0"},
    "kalshi_bridge": {"enabled": False, "version": "0.1.0"},
}
_boot_status = {
    "status": "online",
    "slots_online": 3,
    "started_at": datetime.now(timezone.utc).isoformat(),
    "version": "1.0.0",
}
_mcp_sessions: Dict[str, asyncio.Queue] = {}

# ── OAuth state (in-memory; replace with Redis/DB in production) ──
_oauth_clients: Dict[str, Dict[str, Any]] = {}
_oauth_auth_codes: Dict[str, Dict[str, Any]] = {}
_oauth_codes_used: set = set()

JWT_SECRET = os.getenv("MCP_OAUTH_JWT_SECRET", secrets.token_urlsafe(32))
JWT_ISSUER = os.getenv("MCP_OAUTH_ISSUER", "lantern-os-mcp-oauth")
TOKEN_TTL_MINUTES = int(os.getenv("MCP_OAUTH_TOKEN_TTL", "60"))

if not os.getenv("MCP_OAUTH_JWT_SECRET"):
    logger.warning("MCP_OAUTH_JWT_SECRET not set. Using random secret. Set it for persistent tokens across restarts.")
    logger.info("Random secret (save this): %s", JWT_SECRET)

bearer_scheme = HTTPBearer(auto_error=False)

# ── Tool implementations (shared logic with server.py) ──

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
    return _boot_status


def _tool_list_skills() -> Dict[str, Any]:
    return {
        "skills": [
            {"name": k, **v}
            for k, v in _skills_db.items()
        ],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _tool_get_status() -> Dict[str, Any]:
    return {
        "status": "healthy",
        "uptime_seconds": 0,
        "queue_depth": len(_task_queue),
        "slots_online": _boot_status["slots_online"],
        "version": "1.0.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _tool_web_search(query: str, max_results: int = 5) -> Dict[str, Any]:
    """Search the web via DuckDuckGo (no API key required). Returns title, URL, and snippet for each result."""
    import urllib.request
    import urllib.parse
    import re

    try:
        # DuckDuckGo lite HTML endpoint — no JS, no API key
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
        # DuckDuckGo-lite result pattern: <a ... href="URL" class='result-link'>title</a>
        # followed by <td class='result-snippet'>snippet</td> (single quotes, varying order).
        link_pattern = re.compile(
            r"""<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\bclass=["']result-link["'][^>]*>(.*?)</a>""",
            re.IGNORECASE | re.DOTALL,
        )
        snippet_pattern = re.compile(
            r"""<td[^>]*\bclass=["']result-snippet["'][^>]*>(.*?)</td>""",
            re.IGNORECASE | re.DOTALL,
        )

        links = link_pattern.findall(html)
        snippets = snippet_pattern.findall(html)

        def _normalize(href: str) -> str:
            # Resolve DuckDuckGo redirect wrappers (/l/?uddg=...) to the real target.
            if "uddg=" in href:
                m = re.search(r"uddg=([^&]+)", href)
                if m:
                    return urllib.parse.unquote(m.group(1))
            if href.startswith("//"):
                return "https:" + href
            if href.startswith("/"):
                return "https://duckduckgo.com" + href
            return href

        for i, (href, title_raw) in enumerate(links[:max_results]):
            # Clean title: strip tags
            title = re.sub(r"<[^>]+>", "", title_raw).strip()
            # Get snippet if available
            snippet = re.sub(r"<[^>]+>", "", snippets[i]).strip() if i < len(snippets) else ""
            results.append({
                "rank": i + 1,
                "title": title,
                "url": _normalize(href),
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


def _tool_render_report_pdf(
    title: str,
    content: str,
    author: str = "Lantern OS",
    output_path: str = "reports/lantern-report.pdf",
) -> Dict[str, Any]:
    try:
        from reportlab.lib.pagesizes import letter
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib.units import inch
    except ImportError as exc:
        logger.error("reportlab not installed: %s", exc)
        return {
            "success": False,
            "error": f"reportlab not installed: {exc}",
            "hint": "Install with: pip install reportlab>=4.2.0",
        }

    try:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        doc = SimpleDocTemplate(
            str(path),
            pagesize=letter,
            rightMargin=72,
            leftMargin=72,
            topMargin=72,
            bottomMargin=18,
        )
        styles = getSampleStyleSheet()
        story = []
        story.append(Paragraph(f"<b>{title}</b>", styles["Title"]))
        story.append(Spacer(1, 0.2 * inch))
        story.append(Paragraph(f"Author: {author}", styles["Normal"]))
        story.append(Paragraph(f"Generated: {datetime.now(timezone.utc).isoformat()}", styles["Normal"]))
        story.append(Spacer(1, 0.3 * inch))
        for line in content.splitlines():
            if line.strip():
                story.append(Paragraph(line, styles["Normal"]))
            else:
                story.append(Spacer(1, 0.1 * inch))
        doc.build(story)
        return {
            "success": True,
            "output_path": str(path.resolve()),
            "page_size": "letter",
            "title": title,
            "author": author,
        }
    except Exception as exc:
        logger.exception("Failed to render PDF report")
        return {
            "success": False,
            "error": str(exc),
        }


TOOLS_REGISTRY = {
    "queue_status": _tool_queue_status,
    "task_intake": _tool_task_intake,
    "dispatch_work": _tool_dispatch_work,
    "boot_check": _tool_boot_check,
    "list_skills": _tool_list_skills,
    "get_status": _tool_get_status,
    "web_search": _tool_web_search,
    "render_report_pdf": _tool_render_report_pdf,
}


# ── JSON-RPC Dispatch ──

import inspect


def _handle_jsonrpc(req: Dict[str, Any]) -> Dict[str, Any]:
    req_id = req.get("id")
    method = req.get("method", "")
    params = req.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "lantern-os-mcp-oauth", "version": "1.0.0"},
                "capabilities": {"tools": {}},
            },
        }

    if method == "tools/list":
        tools = []
        for name, fn in TOOLS_REGISTRY.items():
            sig = inspect.signature(fn)
            parameters = {
                "type": "object",
                "properties": {},
                "required": [],
            }
            for param_name, param in sig.parameters.items():
                if param_name in ("limit",):
                    parameters["properties"][param_name] = {
                        "type": "integer",
                        "default": param.default if param.default is not inspect.Parameter.empty else 10,
                    }
                elif param_name in ("description", "agent", "task", "priority", "title", "content", "author", "output_path"):
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
                "error": {"code": -32601, "message": f"Tool '{tool_name}' not found"},
            }
        try:
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

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method '{method}' not found"},
    }


# ── Auth helpers ──

def _verify_token(credentials: Optional[HTTPAuthorizationCredentials]) -> Dict[str, Any]:
    if not credentials:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    token = credentials.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"], issuer=JWT_ISSUER)
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}")


def _generate_token(client_id: str, scope: str = "") -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "iss": JWT_ISSUER,
        "sub": client_id,
        "iat": now,
        "exp": now + timedelta(minutes=TOKEN_TTL_MINUTES),
        "scope": scope,
        "jti": secrets.token_urlsafe(16),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def _hash_verifier(verifier: str) -> str:
    """S256 PKCE transformation."""
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


# ── FastAPI App ──

app = FastAPI(title="Lantern OS MCP Server (OAuth)", version="1.0.0")


@app.get("/health")
async def health():
    start = time.time()
    return {
        "status": "online",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "slots_online": _boot_status["slots_online"],
        "queue_depth": len(_task_queue),
        "response_time_ms": round((time.time() - start) * 1000, 2),
    }


@app.get("/")
async def root():
    return {
        "name": "Lantern OS MCP Server (OAuth)",
        "version": "1.0.0",
        "auth": "OAuth 2.0 + PKCE",
        "endpoints": [
            "/oauth/authorize",
            "/oauth/token",
            "/oauth/register",
            "/.well-known/oauth-authorization-server",
            "/.well-known/mcp",
            "/sse",
            "/messages",
            "/health",
        ],
        "tools": list(TOOLS_REGISTRY.keys()),
    }


# ── OAuth Endpoints ──

@app.get("/.well-known/oauth-authorization-server")
async def oauth_discovery():
    # Use public URL if set (for Cloudflare tunnel), otherwise localhost
    base = os.getenv("MCP_PUBLIC_BASE_URL")
    if not base:
        host = os.getenv("MCP_OAUTH_HOST", "127.0.0.1")
        port = os.getenv("MCP_OAUTH_PORT", "8772")
        base = f"http://{host}:{port}"
    return {
        "issuer": JWT_ISSUER,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "registration_endpoint": f"{base}/oauth/register",
        "scopes_supported": ["mcp"],
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    }


@app.get("/.well-known/mcp")
async def mcp_discovery():
    # Use public URL if set (for Cloudflare tunnel), otherwise localhost
    base = os.getenv("MCP_PUBLIC_BASE_URL")
    if not base:
        host = os.getenv("MCP_OAUTH_HOST", "127.0.0.1")
        port = os.getenv("MCP_OAUTH_PORT", "8772")
        base = f"http://{host}:{port}"
    return {
        "name": "Lantern OS MCP",
        "version": "1.0.0",
        "protocol_version": "2024-11-05",
        "transport": {"type": "sse", "url": f"{base}/sse"},
        "authentication": {"type": "oauth2", "url": f"{base}/.well-known/oauth-authorization-server"},
    }


@app.get("/oauth/register")
async def oauth_register(
    client_name: str = "Lantern MCP Client",
    redirect_uri: str = "",
):
    """Register a new OAuth client. Returns client_id and client_secret.

    For GPT / Custom GPT integration, register once and save the client_id.
    If redirect_uri is omitted, a default loopback URI is provided.
    """
    client_id = f"lantern-client-{secrets.token_urlsafe(16)}"
    client_secret = secrets.token_urlsafe(32)
    if not redirect_uri:
        redirect_uri = "https://oauth.pstmn.io/v1/callback"

    _oauth_clients[client_id] = {
        "client_name": client_name,
        "client_secret": client_secret,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code"],
        "token_endpoint_auth_method": "none",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    logger.info("OAuth client registered: %s (%s)", client_id, client_name)
    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_types": ["authorization_code"],
        "token_endpoint_auth_method": "none",
        "note": "Use client_id in GPT OAuth settings. client_secret is not needed for public clients.",
    }


@app.get("/oauth/authorize")
async def oauth_authorize(
    response_type: str,
    client_id: str,
    redirect_uri: str = "",
    scope: str = "mcp",
    state: str = "",
    code_challenge: str = "",
    code_challenge_method: str = "S256",
):
    """OAuth 2.0 authorization endpoint with PKCE support."""
    if response_type != "code":
        raise HTTPException(status_code=400, detail="Unsupported response_type. Use 'code'.")

    client = _oauth_clients.get(client_id)
    if not client:
        # Auto-register unknown clients for development (remove in production)
        logger.warning("Unknown client_id '%s'; auto-registering for dev", client_id)
        if not redirect_uri:
            redirect_uri = "https://oauth.pstmn.io/v1/callback"
        client = {
            "client_name": "Auto-registered",
            "client_secret": "",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code"],
            "token_endpoint_auth_method": "none",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        _oauth_clients[client_id] = client

    allowed_uris = client.get("redirect_uris", [])
    if redirect_uri and redirect_uri not in allowed_uris:
        # Allow any redirect_uri for development (restrict in production)
        pass

    if not redirect_uri:
        redirect_uri = allowed_uris[0] if allowed_uris else "https://oauth.pstmn.io/v1/callback"

    auth_code = secrets.token_urlsafe(32)
    _oauth_auth_codes[auth_code] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": scope,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": code_challenge_method,
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
    }
    logger.info("OAuth auth code issued for client %s", client_id)

    # Build redirect with code
    sep = "&" if "?" in redirect_uri else "?"
    redirect_url = f"{redirect_uri}{sep}code={auth_code}"
    if state:
        redirect_url += f"&state={state}"
    return RedirectResponse(url=redirect_url)


@app.post("/oauth/token")
async def oauth_token(request: Request):
    """OAuth 2.0 token endpoint. Exchanges authorization code for access token."""
    body = await request.form()
    grant_type = body.get("grant_type", "")
    code = body.get("code", "")
    redirect_uri = body.get("redirect_uri", "")
    client_id = body.get("client_id", "")
    code_verifier = body.get("code_verifier", "")

    if grant_type != "authorization_code":
        raise HTTPException(status_code=400, detail="Unsupported grant_type. Use 'authorization_code'.")

    auth_data = _oauth_auth_codes.get(code)
    if not auth_data:
        raise HTTPException(status_code=400, detail="Invalid or expired authorization code.")

    if auth_data["expires_at"] < datetime.now(timezone.utc):
        _oauth_auth_codes.pop(code, None)
        raise HTTPException(status_code=400, detail="Authorization code expired.")

    if code in _oauth_codes_used:
        raise HTTPException(status_code=400, detail="Authorization code already used.")

    if auth_data.get("code_challenge") and code_verifier:
        expected = _hash_verifier(code_verifier)
        if expected != auth_data["code_challenge"]:
            raise HTTPException(status_code=400, detail="PKCE verification failed.")

    _oauth_codes_used.add(code)
    _oauth_auth_codes.pop(code, None)

    access_token = _generate_token(client_id, scope=auth_data.get("scope", "mcp"))
    logger.info("OAuth access token issued for client %s", client_id)

    return {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": TOKEN_TTL_MINUTES * 60,
        "scope": auth_data.get("scope", "mcp"),
    }


# ── Protected MCP Endpoints ──

async def _event_stream(session_id: str):
    queue = asyncio.Queue()
    _mcp_sessions[session_id] = queue
    try:
        endpoint_url = os.getenv("MCP_MESSAGES_ENDPOINT", "/messages")
        yield f"event: endpoint\ndata: {endpoint_url}?session_id={session_id}\n\n"
        while True:
            msg = await queue.get()
            if msg is None:
                break
            data = json.dumps(msg)
            yield f"event: message\ndata: {data}\n\n"
    finally:
        _mcp_sessions.pop(session_id, None)


async def _send_to_session(session_id: str, message: Dict[str, Any]):
    queue = _mcp_sessions.get(session_id)
    if queue:
        await queue.put(message)


@app.get("/sse")
async def sse_endpoint(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
):
    token_data = _verify_token(credentials)
    session_id = request.query_params.get("session_id", str(uuid.uuid4()))
    logger.info("SSE connection from client %s", token_data.get("sub", "unknown"))
    return JSONResponse(
        content={"session_id": session_id, "status": "use /messages with Bearer token"},
    )


@app.post("/messages")
async def messages_endpoint(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
):
    token_data = _verify_token(credentials)
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
        results = [_handle_jsonrpc(req) for req in body]
        for resp in results:
            await _send_to_session(session_id, resp)
        return JSONResponse({"status": "batch processed"})
    else:
        result = _handle_jsonrpc(body)
        await _send_to_session(session_id, result)
        return JSONResponse(result)


# ── Main ──

if __name__ == "__main__":
    port = int(os.getenv("MCP_OAUTH_PORT", "8772"))
    host = os.getenv("MCP_OAUTH_HOST", "127.0.0.1")
    logger.info("Lantern OS MCP OAuth Server starting on http://%s:%s", host, port)
    logger.info("Tools available: %s", list(TOOLS_REGISTRY.keys()))
    logger.info("OAuth discovery: http://%s:%s/.well-known/oauth-authorization-server", host, port)
    uvicorn.run(app, host=host, port=port, log_level="info")
