import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_chat_is_first_class_above_controls() -> None:
    html = read("apps/lantern-garage/public/index.html")
    assert html.index('Dream Journal Chat') < html.index('aria-label="Primary controls"')
    assert 'chat-card' in html
    assert "dream journal" in html.lower()
    assert "model-bundle" not in html
    assert "reactor-core" not in html
    assert "Local front door:" not in html


def test_dashboard_uses_plain_console_skin() -> None:
    css = read("apps/lantern-garage/public/styles.css")
    required = [
        'body[data-style="plain-dashboard"]',
        "--paper: #f6f2ea",
        "no theme-park skin",
        "border-radius: 24px",
        "font-family: \"Aptos\"",
        "grid-template-columns: repeat(3, minmax(0, 1fr))",
        ".current-model-strip",
    ]
    missing = [phrase for phrase in required if phrase not in css]
    assert missing == []


def test_markdown_links_use_formatted_reader() -> None:
    html = read("apps/lantern-garage/public/index.html")
    raw_doc_links = re.findall(r'href="/repo/[^"]+\.md"', html)
    assert raw_doc_links == []


def test_file_preview_routes_api_to_local_app() -> None:
    js = read("apps/lantern-garage/public/app.js")
    assert 'window.location.protocol === "file:"' in js
    assert "http://127.0.0.1:4177" in js
    assert "normalizeInternalLinks();" in js


def test_primary_controls_have_handlers() -> None:
    js = read("apps/lantern-garage/public/app.js")
    for control_id in [
        "refresh",
        "runLoop",
        "localControls",
        "flatRagIngest",
        "autoUpdate",
        "conversationForm",
        "ragForm",
        "noteForm",
        "dispatchAll",
    ]:
        assert f'$("#{control_id}")' not in js
        assert f'("{control_id}")' in js
    assert "/api/command" in js
    assert "/api/actions/local-controls" in js
    assert "/api/actions/flat-rag-ingest" in js


def test_chat_understands_mining_safely() -> None:
    js = read("apps/lantern-garage/public/app.js")
    assert "Rock and stone" in js
    assert "CPU routes to Monero" in js
    assert "BTC only belongs on owned SHA-256 ASIC hardware" in js
    assert "No wallet cracking" in js


def test_chat_has_pending_response_queue_and_mcp_route() -> None:
    js = read("apps/lantern-garage/public/app.js")
    css = read("apps/lantern-garage/public/styles.css")
    server = read("apps/lantern-garage/server.js")
    required_js = [
        "Waiting for Lantern response",
        "queued for MCP/local reply",
        "updateBubble(waitingBubble",
        "aria-busy",
        "chat-message-text",
    ]
    missing_js = [phrase for phrase in required_js if phrase not in js]
    assert missing_js == []
    assert ".chat-bubble.pending" in css
    assert "tryMcpChatReply" in server
    assert "get_mcp_feature_overview" in server
    assert "Model Context Protocol, not Multi-Chain Protocol" in server
    assert 'const wantsFleet = lower.includes("fleet") || lower.includes("agent")' in server
    assert "mcpReadOnlyTimeoutMs" in server
    assert "Read-only chat path only" in server


def test_server_has_formatted_reader_and_cors_for_preview() -> None:
    server = read("apps/lantern-garage/server.js")
    assert 'url.pathname === "/view"' in server
    assert "renderMarkdownDocument" in server
    assert "Access-Control-Allow-Origin" in server
    assert "OPTIONS" in server


def test_orchestrator_dependency_contract_is_visible_and_read_only() -> None:
    html = read("apps/lantern-garage/public/index.html")
    js = read("apps/lantern-garage/public/app.js")
    css = read("apps/lantern-garage/public/styles.css")
    server = read("apps/lantern-garage/server.js")
    manifest = read("manifests/orchestrator-dependency.json")
    docs = read("docs/LANTERN-ORCHESTRATOR-DEPENDENCY.md")
    script = read("scripts/Test-LanternOrchestratorDependency.ps1")
    required = [
        "Orchestrator Dependency",
        "orchDepStatus",
        "orchDepTools",
        "orchDepFleet",
        "orchDepNext",
        "renderOrchestratorDependency",
        ".dependency-panel",
        "getOrchestratorDependencyStatus",
        "/api/orchestrator-dependency",
        "staleSlotsAreNotAvailable",
        "lantern-codex-impl",
        "mcp_ready_fleet_rebuild_required",
        "canDispatchAgents = $false",
    ]
    haystack = "\n".join([html, js, css, server, manifest, docs, script])
    missing = [phrase for phrase in required if phrase not in haystack]
    assert missing == []


def test_fleet_dispatch_is_preflight_guarded() -> None:
    server = read("apps/lantern-garage/server.js")
    js = read("apps/lantern-garage/public/app.js")
    required_server = [
        "summarizeDispatchFleet",
        'callMcpTool("get_agent_status", {}, mcpReadOnlyTimeoutMs)',
        "Dispatch held: no safe agent slots available.",
        "canDispatch: false",
        "runAgentDispatchBatch(now, dispatchableSlots)",
        "nextHumanAction",
    ]
    required_js = [
        "dispatch.disabled",
        "Dispatch Held",
        "result.held",
        "No safe agent slots are available.",
    ]
    missing = [phrase for phrase in required_server if phrase not in server]
    missing += [phrase for phrase in required_js if phrase not in js]
    assert missing == []
