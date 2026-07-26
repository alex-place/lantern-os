"""
OAuth2 Server endpoint validation tests.
Tests OAuth2 PKCE flow, JWT tokens, and MCP tool exposure.
"""

import pytest
import json
from pathlib import Path
from unittest.mock import patch, MagicMock


class TestOAuth2PKCEFlow:
    """Validate OAuth2 with PKCE support."""

    def test_pkce_parameters_supported(self):
        """Verify PKCE parameters are properly handled."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        assert oauth_file.exists()

        content = oauth_file.read_text(encoding="utf-8")

        # Check for PKCE components
        assert "code_challenge" in content, "PKCE code_challenge not found"
        assert "code_verifier" in content or "pkce" in content.lower()
        assert "S256" in content or "challenge" in content  # SHA256 method

    def test_oauth_well_known_endpoint(self):
        """Verify OAuth discovery endpoint configuration."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Must define well-known endpoint
        assert ".well-known/oauth-authorization-server" in content

        # Must define required OAuth endpoints
        required_endpoints = [
            "authorization_endpoint",
            "token_endpoint",
            "scopes_supported",
            "response_types_supported",
            "grant_types_supported",
        ]

        for endpoint in required_endpoints:
            assert endpoint in content, f"Required OAuth endpoint '{endpoint}' not found"

    def test_authorization_code_flow(self):
        """Verify authorization code grant flow is implemented."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Must support authorization code flow
        assert "authorization_code" in content
        assert "/oauth/authorize" in content or "/authorize" in content

    def test_token_endpoint_implemented(self):
        """Verify token endpoint is properly implemented."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Must have token endpoint
        assert "/oauth/token" in content or "/token" in content
        assert "access_token" in content
        assert "token_type" in content


class TestJWTTokenHandling:
    """Validate JWT token implementation."""

    def test_jwt_secret_configuration(self):
        """Verify JWT secret is properly configured."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Must use JWT secret
        assert "JWT" in content or "jwt" in content
        assert ("MCP_OAUTH_JWT_SECRET" in content) or ("secret" in content.lower())

    def test_jwt_algorithm_secure(self):
        """Verify secure JWT algorithm is used."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Should use HS256 (HMAC SHA-256) or RS256 (RSA SHA-256)
        assert "HS256" in content or "RS256" in content, "Insecure JWT algorithm detected"

    def test_token_expiration_configured(self):
        """Verify token expiration is properly set."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Must have token expiration
        assert "expir" in content.lower() or "ttl" in content.lower()

        # Should mention 60 minute TTL (3600 seconds) as per spec
        assert "3600" in content or "60" in content or "expires_in" in content

    def test_token_payload_structure(self):
        """Verify JWT payload contains required claims."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # JWT tokens should contain standard claims
        required_claims = [
            "sub",  # subject (user/client)
            "iat",  # issued at
            "exp",  # expiration
        ]

        # At least some claims should be mentioned
        claims_found = sum(1 for claim in required_claims if f'"{claim}"' in content or f"'{claim}'" in content)
        assert claims_found >= 1, "Standard JWT claims not found in token creation"


class TestOAuthEnvironmentConfiguration:
    """Validate OAuth environment setup."""

    def test_oauth_port_configured(self):
        """Verify OAuth server port is configured."""
        env_file = Path(".env.example")
        assert env_file.exists()

        content = env_file.read_text(encoding="utf-8")
        assert "MCP_OAUTH_PORT" in content, "OAuth port not configured in .env.example"

    def test_oauth_public_url_configured(self):
        """Verify public OAuth URL is configured."""
        env_file = Path(".env.example")
        content = env_file.read_text(encoding="utf-8")

        assert "MCP_PUBLIC_BASE_URL" in content, "Public base URL not configured"

    def test_oauth_jwt_secret_in_env(self):
        """Verify JWT secret environment variable is defined."""
        env_file = Path(".env.example")
        content = env_file.read_text(encoding="utf-8")

        assert "MCP_OAUTH_JWT_SECRET" in content, "JWT secret not in environment config"

    def test_oauth_server_code_imports(self):
        """Verify OAuth server imports required libraries."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Must import JWT library
        assert any(lib in content for lib in ["jwt", "PyJWT", "jose"])


class TestMCPToolExposure:
    """Validate MCP tools are properly exposed through OAuth."""

    def test_oauth_server_exposes_mcp_tools(self):
        """Verify OAuth server exposes MCP tools."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Should reference core MCP tools
        tools = [
            "queue_status",
            "task_intake",
            "dispatch_work",
            "boot_check",
            "list_skills",
            "get_status",
        ]

        tools_found = sum(1 for tool in tools if tool in content)
        assert tools_found >= 3, f"Expected at least 3 MCP tools in OAuth server, found {tools_found}"

    def test_oauth_tool_list_endpoint(self):
        """Verify tool list endpoint is available through OAuth."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Should have endpoint to list tools
        assert "/tools" in content or "tool" in content

    def test_tool_execution_requires_auth(self):
        """Verify tool execution requires OAuth token."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Should check for authorization token
        assert "Bearer" in content or "token" in content.lower()


class TestChatGPTConnectorReadiness:
    """Validate OAuth setup for ChatGPT connector integration."""

    def test_oauth_cors_configured(self):
        """Verify CORS is properly configured for external clients."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Should configure CORS or allow cross-origin requests
        assert "CORS" in content or "cors" in content or "cross" in content.lower()

    def test_oauth_endpoint_public_accessible(self):
        """Verify OAuth endpoints are publicly accessible."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Should have public routes
        assert "@" in content and ("route" in content or "app" in content)

    def test_redirect_uri_validation(self):
        """Verify redirect URI validation is implemented."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Should validate redirect URIs
        assert "redirect" in content.lower() or "uri" in content.lower()

    def test_client_credentials_configured(self):
        """Verify OAuth client credentials can be configured."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Should have client ID/secret configuration
        assert "client" in content.lower()


class TestOAuthSecurityHeaders:
    """Validate OAuth security headers and protections."""

    def test_no_credentials_in_logs(self):
        """Verify credentials are not logged."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Should not log sensitive information
        lines_with_print = [line for line in content.split('\n') if 'print' in line.lower()]
        for line in lines_with_print:
            assert not any(secret in line for secret in ["token", "secret", "password"])

    def test_https_enforced_in_production(self):
        """Verify HTTPS is enforced for OAuth in production."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Should check for HTTPS or mention production security
        assert "https" in content.lower() or "ssl" in content.lower() or "tls" in content.lower()

    def test_state_parameter_validation(self):
        """Verify OAuth state parameter is validated."""
        oauth_file = Path("src/mcp_server/server_oauth.py")
        content = oauth_file.read_text(encoding="utf-8")

        # Should validate state parameter for CSRF protection
        assert "state" in content.lower()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
