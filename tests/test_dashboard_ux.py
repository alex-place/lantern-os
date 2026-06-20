"""
Dashboard / UX tests — updated for Dream Journal v1.0.0 landing page.

Three xfail tests removed (tested removed features):
  - test_dashboard_uses_plain_console_skin       (old styles.css skin attributes)
  - test_chat_has_pending_response_queue_and_mcp_route  (Orion chat removed)
  - test_fleet_dispatch_is_preflight_guarded     (fleet dispatch removed)
"""
import re
from pathlib import Path
import pytest


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_landing_page_is_clean_sales_page() -> None:
    html = read("apps/lantern-garage/public/index.html")
    # Title and branding
    assert "Keystone OS" in html
    # CTA panels
    assert "dream-chat.html" in html
    assert "patreon.com" in html
    assert "github.com" in html
    # No old inline journal UI
    assert 'id="entryForm"' not in html
    assert 'id="micBtn"' not in html
    assert 'chat-card' not in html
    # No security pollution
    assert "model-bundle" not in html
    assert "reactor-core" not in html


def test_landing_page_links_to_full_journal() -> None:
    html = read("apps/lantern-garage/public/index.html")
    assert "dream-journal" in html


def test_landing_page_has_server_status() -> None:
    html = read("apps/lantern-garage/public/index.html")
    assert "/api/health" in html


def test_markdown_links_use_formatted_reader() -> None:
    html = read("apps/lantern-garage/public/index.html")
    raw_doc_links = re.findall(r'href="/repo/[^"]+\.md"', html)
    assert raw_doc_links == []


def test_server_has_formatted_reader_and_cors_for_preview() -> None:
    # /view route is now in routes/files.js (server was refactored into modules)
    files_route = read("apps/lantern-garage/routes/files.js")
    server = read("apps/lantern-garage/server.js")
    assert 'url.pathname === "/view"' in files_route
    assert "renderMarkdownDocument" in files_route
    assert "Access-Control-Allow-Origin" in server
    assert "OPTIONS" in server


def test_server_routes_are_modular() -> None:
    """server.js should be a thin orchestrator — no inline route handlers."""
    server = read("apps/lantern-garage/server.js")
    # Must require the route modules
    assert 'require("./routes/status")' in server
    assert 'require("./routes/dream")' in server
    assert 'require("./routes/dreamer")' in server
    # Must not contain inline route blocks (the old monolith pattern)
    assert 'url.pathname === "/api/dream/create"' not in server
    assert 'url.pathname === "/api/dream/stats"' not in server


def test_dream_chat_has_provider_settings() -> None:
    html = read("apps/lantern-garage/public/dream-chat.html")
    # Settings drawer present
    assert "settings-modal" in html
    assert "settings-btn" in html
    # All 4 providers wired
    assert "ANTHROPIC_API_KEY" in html
    assert "GEMINI_API_KEY" in html
    assert "OPENAI_API_KEY" in html
    assert "XAI_API_KEY" in html
    # Get key links
    assert "console.anthropic.com" in html
    assert "aistudio.google.com" in html
    assert "platform.openai.com" in html
    assert "console.x.ai" in html


def test_dream_chat_stream_reader_is_guarded() -> None:
    html = read("apps/lantern-garage/public/dream-chat.html")
    js = read("apps/lantern-garage/public/js/dream-chat.js")
    # streamFinished guard prevents double finishStream (JS lives in external file)
    assert "streamFinished" in html or "streamFinished" in js
    assert "processLines" in html or "processLines" in js
    # No canned offline fallback in client
    assert "The flame holds steady" not in html
    assert "The flame holds steady" not in js


def test_dream_chat_fails_fast_without_provider() -> None:
    html = read("apps/lantern-garage/public/dream-chat.html")
    js = read("apps/lantern-garage/public/js/dream-chat.js")
    # failed source is handled in finishStream (JS lives in external file)
    assert '"failed"' in html or "failed" in html or '"failed"' in js or "failed" in js
    assert "source-badge" in html or "source-badge" in js


def test_pcsf_files_exist() -> None:
    pcsf_dir = ROOT / "data" / "pcsf"
    required = ["narrator.pcsf.json", "agent.pcsf.json",
                "model.pcsf.json", "settings.pcsf.json"]
    for f in required:
        assert (pcsf_dir / f).exists(), f"Missing PCSF file: {f}"


def test_pcsf_files_are_valid_json() -> None:
    import json
    pcsf_dir = ROOT / "data" / "pcsf"
    for f in pcsf_dir.glob("*.pcsf.json"):
        data = json.loads(f.read_text(encoding="utf-8"))
        assert "pcsf_type" in data, f"{f.name} missing pcsf_type"
        assert "pcsf_version" in data, f"{f.name} missing pcsf_version"
        assert "state" in data, f"{f.name} missing state"
