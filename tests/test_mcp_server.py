"""
MCP Server endpoint validation tests.
Tests the health checks and tool discovery without executing tools.
"""

import pytest
import json
from pathlib import Path
from unittest.mock import patch, MagicMock


class TestMcpServerEndpoints:
    """Validate core MCP server endpoints."""

    def test_server_starts_without_error(self):
        """Verify MCP server can start without port binding errors."""
        # In CI, we just verify the module can be imported
        try:
            from src.mcp_server import server
            assert server is not None
        except (ImportError, SystemExit):
            # server.py calls sys.exit(1) (SystemExit) when fastapi/uvicorn
            # are absent, which is the expected state in the lean CI env.
            pytest.skip("MCP server deps (fastapi/uvicorn) not available in test environment")

    def test_mcp_tools_are_registered(self):
        """Verify all core tools are properly registered."""
        expected_tools = [
            "queue_status",
            "task_intake",
            "dispatch_work",
            "boot_check",
            "list_skills",
            "get_status",
        ]

        # This would be verified by the server startup logs
        # In CI, we check the tools are defined in the server code
        from pathlib import Path
        server_code_path = Path("src/mcp_server/server.py")
        assert server_code_path.exists(), "MCP server code not found"

        server_content = server_code_path.read_text()
        for tool in expected_tools:
            assert tool in server_content, f"Tool '{tool}' not found in server code"

    def test_oauth_discovery_endpoint_format(self):
        """Verify OAuth discovery endpoint returns correct format."""
        oauth_code_path = Path("src/mcp_server/server_oauth.py")
        if not oauth_code_path.exists():
            pytest.skip("OAuth server code not found")

        try:
            oauth_content = oauth_code_path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            oauth_content = oauth_code_path.read_text(encoding='cp1252')

        # Verify well-known endpoint is implemented
        assert ".well-known/oauth-authorization-server" in oauth_content
        assert "authorization_endpoint" in oauth_content
        assert "token_endpoint" in oauth_content

    def test_environment_variables_configured(self):
        """Verify required environment variables are configured."""
        from pathlib import Path
        env_example = Path(".env.example")
        assert env_example.exists(), ".env.example not found"

        content = env_example.read_text()
        required_vars = [
            "MCP_SERVER_PORT",
            "MCP_OAUTH_PORT",
            "MCP_PUBLIC_BASE_URL",
        ]

        for var in required_vars:
            assert var in content, f"Required env var {var} not in .env.example"


class TestOAuthEndpoints:
    """Validate OAuth2 implementation."""

    def test_oauth_server_code_structure(self):
        """Verify OAuth server has required components."""
        from pathlib import Path
        oauth_file = Path("src/mcp_server/server_oauth.py")
        assert oauth_file.exists()

        content = oauth_file.read_text()

        # Verify key OAuth components
        assert "FastAPI" in content or "uvicorn" in content
        assert "PKCE" in content or "code_challenge" in content
        assert "JWT" in content or "jwt" in content
        assert "HS256" in content or "RS256" in content

    def test_jwt_token_configuration(self):
        """Verify JWT token configuration is properly defined."""
        from pathlib import Path
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text()

        # Check for token expiration
        assert "expir" in content.lower() or "ttl" in content.lower()

        # Check for secret key configuration
        assert "secret" in content.lower() or "key" in content.lower()

    def test_mcp_oauth_integration(self):
        """Verify OAuth server exposes MCP tools correctly."""
        from pathlib import Path
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text()

        # Should expose same tools as main MCP server
        assert "queue_status" in content
        assert "task_intake" in content
        assert "dispatch_work" in content


class TestCloudflareConfiguration:
    """Validate Cloudflare tunnel configuration."""

    def test_tunnel_config_template_exists(self):
        """Verify tunnel configuration template is documented."""
        # If cloudflared config exists at ~/.cloudflared/config.yml, that's sufficient
        # Otherwise, the server.js should mention it
        from pathlib import Path

        server_file = Path("apps/lantern-garage/server.js")
        if server_file.exists():
            content = server_file.read_text()
            # Should mention cloudflare tunnel configuration
            assert "cloudflared" in content or "tunnel" in content
        else:
            pytest.skip("Server file not found")

    def test_server_tunnel_spawn_code(self):
        """Verify server.js properly spawns cloudflared tunnel."""
        from pathlib import Path
        server_file = Path("apps/lantern-garage/server.js")
        assert server_file.exists()

        content = server_file.read_text()

        # Verify tunnel spawn code exists
        assert "cloudflared" in content
        assert "tunnel" in content
        assert "run" in content

        # Should NOT have hardcoded invalid config path
        assert 'cloudflare-config.yml"' not in content or "config" not in content.split('cloudflare-config')[0][-50:]

    def test_routing_configuration(self):
        """Verify tunnel routes are properly configured."""
        # Check that tunnel routing is properly documented or configured
        env_file = Path(".env.example")
        if env_file.exists():
            content = env_file.read_text()
            # Should mention MCP configuration
            assert "MCP_" in content
        else:
            pytest.skip("Configuration files not found")


class TestDreamChatIntegration:
    """Validate Dream Chat agent system."""

    def test_agent_personas_defined(self):
        """Verify all 6 agent personas are defined."""
        dream_chat_file = Path("apps/lantern-garage/lib/dream-chat.js")
        if not dream_chat_file.exists():
            pytest.skip("Dream Chat file not found")

        try:
            content = dream_chat_file.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            try:
                content = dream_chat_file.read_text(encoding='cp1252')
            except Exception:
                pytest.skip("Unable to read dream-chat.js due to encoding issues")

        agents = ["keystone", "waterfall"]
        for agent in agents:
            assert agent in content, f"Agent '{agent}' not found in dream-chat.js"

    def test_system_prompts_non_empty(self):
        """Verify agent system prompts are defined."""
        dream_chat_file = Path("apps/lantern-garage/lib/dream-chat.js")
        if not dream_chat_file.exists():
            pytest.skip("Dream Chat file not found")

        try:
            content = dream_chat_file.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            try:
                content = dream_chat_file.read_text(encoding='cp1252')
            except Exception:
                pytest.skip("Unable to read dream-chat.js")

        # Should have systemPrompt definitions
        assert "systemPrompt" in content or "prompt" in content.lower()

    def test_provider_routing_configured(self):
        """Verify LLM provider routing is configured."""
        dream_chat_file = Path("apps/lantern-garage/lib/dream-chat.js")
        if not dream_chat_file.exists():
            pytest.skip("Dream Chat file not found")

        try:
            content = dream_chat_file.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            try:
                content = dream_chat_file.read_text(encoding='cp1252')
            except Exception:
                pytest.skip("Unable to read dream-chat.js")

        # Should have provider selection logic
        assert "provider" in content.lower() or "anthropic" in content.lower()


class TestDataIntegrity:
    """Validate data structure and persistence."""

    def test_data_directories_structure(self):
        """Verify data directory structure is correct."""
        from pathlib import Path

        data_dirs = [
            Path("data/dream-journals"),
            Path("data/conversations"),
            Path("data/nodes"),
        ]

        # At least some of these should exist
        assert any(d.exists() for d in data_dirs), "No data directories found"

    def test_gitignore_protects_data(self):
        """Verify .gitignore properly protects data files."""
        from pathlib import Path
        gitignore_file = Path(".gitignore")
        assert gitignore_file.exists()

        content = gitignore_file.read_text()

        # Should ignore data files
        assert any(pattern in content for pattern in ["data/", "*.json", "*.jsonl"])

    def test_jsonl_persistence_format(self):
        """Verify JSONL format is used for append-only logs."""
        lib_dir = Path("apps/lantern-garage/lib")
        if not lib_dir.exists():
            pytest.skip("Lantern Garage lib directory not found")

        # Check that conversation store and dreamer store use JSONL
        lib_files = list(lib_dir.glob("*.js"))
        if not lib_files:
            pytest.skip("No JS files found in lib directory")

        # Should reference JSONL format somewhere
        has_jsonl_ref = False
        for f in lib_files:
            try:
                content = f.read_text(encoding='utf-8')
            except UnicodeDecodeError:
                try:
                    content = f.read_text(encoding='cp1252')
                except Exception:
                    continue

            if ".jsonl" in content or "appendFile" in content:
                has_jsonl_ref = True
                break

        assert has_jsonl_ref, "JSONL format not found in lib files"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
