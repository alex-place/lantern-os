"""
Dashboard / UX + PCSF config contract tests - Dream Journal v1.0.0

Test organisation:
  LANDING PAGE  - index.html surface contract
  SERVER        - modular route architecture + CORS/OPTIONS contract
  DREAM CHAT    - provider settings, stream guards, failure posture
  PCSF CONFIG   - config file existence, JSON schema, type-specific fields
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[1]
PCSF_DIR = ROOT / "data" / "pcsf"

REQUIRED_PCSF_FILES = [
    "narrator.pcsf.json",
    "agent.pcsf.json",
    "model.pcsf.json",
    "settings.pcsf.json",
]

PCSF_BASE_SCHEMA = {"pcsf_type", "pcsf_version", "state", "description"}

# Verified against actual file structure in data/pcsf/
PCSF_TYPE_SCHEMA = {
    "narrator":  {"narrators"},
    "agent":     {"agents", "default_agent_id"},
    "model":     {"models"},
    "settings":  {"ui", "features", "operator"},
}

VALID_STATES = {"available", "stopped", "degraded", "maintenance"}


# ---------------------------------------------------------------------------
# Module-scoped fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def index_html():
    return (ROOT / "apps/lantern-garage/public/index.html").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def server_js():
    return (ROOT / "apps/lantern-garage/server.js").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def files_route_js():
    return (ROOT / "apps/lantern-garage/routes/files.js").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def dream_chat_html():
    return (ROOT / "apps/lantern-garage/public/dream-chat.html").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def dream_chat_js():
    return (ROOT / "apps/lantern-garage/public/js/dream-chat.js").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def pcsf_docs():
    """Return all required PCSF docs as {filename: parsed_json}."""
    docs = {}
    for name in REQUIRED_PCSF_FILES:
        path = PCSF_DIR / name
        assert path.exists(), (
            f"Required PCSF config file missing: data/pcsf/{name}\n"
            "  This is a tracked config file, not a runtime artifact.\n"
            f"  Fix: git add -f data/pcsf/{name}"
        )
        docs[name] = json.loads(path.read_text(encoding="utf-8"))
    return docs


# ---------------------------------------------------------------------------
# LANDING PAGE
# ---------------------------------------------------------------------------


class TestLandingPage:
    """index.html must be a clean Dream Journal marketing/launch page."""

    def test_branding(self, index_html):
        assert "Dream Journal" in index_html, "Product name 'Dream Journal' missing"
        assert "Lantern OS" in index_html, "Brand 'Lantern OS' missing"

    def test_cta_links(self, index_html):
        assert "dream-chat.html" in index_html, "Missing link to dream-chat.html"
        assert "patreon.com" in index_html, "Missing Patreon CTA"
        assert "github.com" in index_html, "Missing GitHub link"

    def test_links_to_full_journal(self, index_html):
        assert "dream-journal" in index_html

    def test_health_endpoint_wired(self, index_html):
        assert "/api/health" in index_html

    def test_old_inline_journal_removed(self, index_html):
        assert 'id="entryForm"' not in index_html, "Legacy entryForm present"
        assert 'id="micBtn"' not in index_html, "Legacy micBtn present"
        assert "chat-card" not in index_html, "Legacy chat-card present"

    def test_no_internal_security_symbols(self, index_html):
        assert "model-bundle" not in index_html
        assert "reactor-core" not in index_html

    def test_markdown_links_use_formatted_reader(self, index_html):
        raw_md = re.findall(r'href="/repo/[^"]+\.md"', index_html)
        assert raw_md == [], f"Raw .md links bypass viewer: {raw_md}"


# ---------------------------------------------------------------------------
# SERVER ARCHITECTURE
# ---------------------------------------------------------------------------


class TestServerArchitecture:
    """server.js must be a thin HTTP orchestrator, not a monolith."""

    def test_cors_and_options_present(self, server_js):
        assert "Access-Control-Allow-Origin" in server_js
        assert "OPTIONS" in server_js

    def test_routes_are_modular(self, server_js):
        for mod in ("./routes/status", "./routes/dream", "./routes/dreamer"):
            assert f'require("{mod}")' in server_js, f"Missing require for {mod}"

    def test_no_inline_route_blocks(self, server_js):
        assert 'url.pathname === "/api/dream/create"' not in server_js
        assert 'url.pathname === "/api/dream/stats"' not in server_js

    def test_view_route_in_files_module(self, files_route_js):
        assert 'url.pathname === "/view"' in files_route_js
        assert "renderMarkdownDocument" in files_route_js


# ---------------------------------------------------------------------------
# DREAM CHAT
# ---------------------------------------------------------------------------


class TestDreamChat:
    """dream-chat.html + dream-chat.js surface contracts."""

    def test_settings_drawer_present(self, dream_chat_html):
        assert "settings-drawer" in dream_chat_html
        assert "settings-btn" in dream_chat_html

    @pytest.mark.parametrize("env_var,console_url", [
        ("ANTHROPIC_API_KEY", "console.anthropic.com"),
        ("GEMINI_API_KEY",    "aistudio.google.com"),
        ("OPENAI_API_KEY",    "platform.openai.com"),
        ("XAI_API_KEY",       "console.x.ai"),
    ])
    def test_all_providers_wired(self, env_var, console_url, dream_chat_html):
        assert env_var in dream_chat_html, f"Provider env var {env_var!r} not referenced"
        assert console_url in dream_chat_html, f"Get-key link for {console_url!r} missing"

    def test_stream_reader_is_guarded(self, dream_chat_html, dream_chat_js):
        combined = dream_chat_html + dream_chat_js
        assert "streamFinished" in combined
        assert "processLines" in combined

    def test_no_hardcoded_offline_fallback(self, dream_chat_html, dream_chat_js):
        combined = dream_chat_html + dream_chat_js
        assert "The flame holds steady" not in combined

    def test_failure_state_handled(self, dream_chat_html, dream_chat_js):
        combined = dream_chat_html + dream_chat_js
        assert "failed" in combined
        assert "source-badge" in combined


# ---------------------------------------------------------------------------
# PCSF CONFIG CONTRACT
# ---------------------------------------------------------------------------


class TestPCSFConfig:
    """Convergence-fitted PCSF config files must satisfy the full schema contract."""

    @pytest.mark.parametrize("filename", REQUIRED_PCSF_FILES)
    def test_file_exists(self, filename):
        path = PCSF_DIR / filename
        assert path.exists(), (
            f"Missing: data/pcsf/{filename} (tracked config - not runtime state)"
        )

    @pytest.mark.parametrize("filename", REQUIRED_PCSF_FILES)
    def test_valid_json(self, filename):
        path = PCSF_DIR / filename
        if not path.exists():
            pytest.skip(f"{filename} missing - existence checked separately")
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            pytest.fail(f"{filename}: invalid JSON: {exc}")

    @pytest.mark.parametrize("filename", REQUIRED_PCSF_FILES)
    def test_base_schema(self, filename, pcsf_docs):
        missing = PCSF_BASE_SCHEMA - pcsf_docs[filename].keys()
        assert not missing, f"{filename} missing base keys: {sorted(missing)}"

    @pytest.mark.parametrize("filename", REQUIRED_PCSF_FILES)
    def test_version_format(self, filename, pcsf_docs):
        """pcsf_version must be X.Y.Z."""
        version = pcsf_docs[filename].get("pcsf_version", "")
        assert re.fullmatch(r"\d+\.\d+\.\d+", version), (
            f"{filename}: pcsf_version {version!r} is not X.Y.Z"
        )

    @pytest.mark.parametrize("filename", REQUIRED_PCSF_FILES)
    def test_state_is_valid(self, filename, pcsf_docs):
        state = pcsf_docs[filename].get("state", "")
        assert state in VALID_STATES, (
            f"{filename}: state {state!r} not in {sorted(VALID_STATES)}"
        )

    @pytest.mark.parametrize("filename", REQUIRED_PCSF_FILES)
    def test_type_specific_schema(self, filename, pcsf_docs):
        doc = pcsf_docs[filename]
        pcsf_type = doc.get("pcsf_type", "")
        required_keys = PCSF_TYPE_SCHEMA.get(pcsf_type)
        if required_keys is None:
            pytest.skip(f"No schema defined for pcsf_type={pcsf_type!r}")
        missing = required_keys - doc.keys()
        assert not missing, (
            f"{filename} (type={pcsf_type!r}) missing keys: {sorted(missing)}"
        )

    def test_pcsf_types_are_unique(self, pcsf_docs):
        """Each file must declare a distinct pcsf_type."""
        types = [doc.get("pcsf_type", "") for doc in pcsf_docs.values()]
        seen = set()
        duplicates = [t for t in types if t in seen or seen.add(t)]
        assert not duplicates, f"Duplicate pcsf_type values: {duplicates}"

    def test_no_unexpected_pcsf_files(self):
        """Only known PCSF files should exist - unknown files are sprawl."""
        existing = {f.name for f in PCSF_DIR.glob("*.pcsf.json")}
        unknown = existing - set(REQUIRED_PCSF_FILES)
        assert not unknown, (
            f"Unexpected PCSF files: {sorted(unknown)}. "
            "Add to REQUIRED_PCSF_FILES if intentional."
        )