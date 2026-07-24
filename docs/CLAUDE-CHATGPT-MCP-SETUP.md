# Connect Claude & ChatGPT to Lantern OS MCP Server

**Status:** Ready to connect  
**Services:** Running on localhost and via Cloudflare Tunnel  
**Last Updated:** 2026-06-13

---

## Service Status

All three services are running automatically when you start the main server:

```bash
npm start
```

| Service | Local | Public | Port |
|---------|-------|--------|------|
| **Dream Journal** | ✅ http://127.0.0.1:4177 | https://lantern-os.net | 4177 |
| **MCP (no-auth)** | ✅ http://127.0.0.1:8771 | https://mcp.lantern-os.net | 8771 |
| **MCP (OAuth2)** | ✅ http://127.0.0.1:8772 | https://mcp.lantern-os.net/oauth | 8772 |

---

## Claude Connection

Claude has native MCP support. Use this configuration:

### For Claude API + SDK

```python
from anthropic import Anthropic

client = Anthropic()

# Connect to local MCP server (no auth)
mcp_server = {
    "url": "http://127.0.0.1:8771",
    "type": "sse"
}

# Or use OAuth2 version
mcp_oauth = {
    "url": "http://127.0.0.1:8772",
    "type": "sse",
    "auth": {
        "type": "oauth2",
        "discovery_url": "http://127.0.0.1:8772/.well-known/oauth-authorization-server"
    }
}
```

### For Claude.ai Desktop App

1. Open **Claude.app** settings
2. Go to **Integrations** or **MCP Servers**
3. Add new connection:
   - **URL:** `http://127.0.0.1:8771` (or `http://127.0.0.1:8772` for OAuth)
   - **Name:** Lantern OS MCP
   - **Type:** SSE (Server-Sent Events)

---

## ChatGPT Connection (Custom MCP Connector)

### Step 1: Go to ChatGPT Connector Setup

1. Visit [ChatGPT Custom Connectors](https://platform.openai.com/app/connectors)
2. Click **Create new connector**
3. Fill in:
   - **Name:** `lantern-os`
   - **Description:** Lantern OS MCP Server with Dream Journal and AI routing
   - **Logo:** (optional)

### Step 2: Configure MCP Server URL

In the **Connection** section:

```
MCP Server URL: http://127.0.0.1:8772
```

Or for public access (via Cloudflare Tunnel, once running):
```
MCP Server URL: https://mcp.lantern-os.net/oauth
```

### Step 3: Set Up OAuth2 Authentication

Select **OAuth** in Authentication dropdown.

In **Advanced OAuth settings**, enter:

#### Client Registration: User-Defined OAuth Client

```
OAuth Client ID: chatgpt-lantern-os
OAuth Client Secret: (leave blank for PKCE)
Token endpoint auth method: none
```

#### OAuth Endpoints

Copy these values from the OAuth discovery response:

```
Auth URL:                http://127.0.0.1:8772/oauth/authorize
Token URL:               http://127.0.0.1:8772/oauth/token
Authorization server:    http://127.0.0.1:8772
Registration URL:        http://127.0.0.1:8772/oauth/register
```

Or public (via Cloudflare):
```
Auth URL:                https://mcp.lantern-os.net/oauth/authorize
Token URL:               https://mcp.lantern-os.net/oauth/token
Authorization server:    https://mcp.lantern-os.net
Registration URL:        https://mcp.lantern-os.net/oauth/register
```

#### Scopes

**Base scopes:**
```
mcp
```

**Default scopes:**
```
mcp
```

### Step 4: Test Connection

Click **Create**. ChatGPT will:
1. Discover the OAuth endpoints
2. Redirect you to authorize
3. Register as an OAuth client
4. Store your access token

### Step 5: Add Tools to Your GPT

In your Custom GPT configuration, select which tools you want to expose:

**Available tools:**
- `queue_status` — Get pending work queue
- `task_intake` — Submit new task
- `dispatch_work` — Route task to agent
- `boot_check` — System health
- `list_skills` — Available skills
- `get_status` — Real-time metrics
- `fleet_status` — Agent fleet status
- `mesh_register_peer` — Register mesh peer
- `mesh_status` — Peer topology
- `web_search` — Search the web

---

## OAuth2 Server Details

### Discovery Endpoint

```
GET http://127.0.0.1:8772/.well-known/oauth-authorization-server
```

**Response:**
```json
{
  "issuer": "lantern-os-mcp-oauth",
  "authorization_endpoint": "http://127.0.0.1:8772/oauth/authorize",
  "token_endpoint": "http://127.0.0.1:8772/oauth/token",
  "registration_endpoint": "http://127.0.0.1:8772/oauth/register",
  "scopes_supported": ["mcp"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

### MCP Metadata Endpoint

```
GET http://127.0.0.1:8772/.well-known/mcp
```

**Response:**
```json
{
  "name": "Lantern OS MCP",
  "version": "1.0.0",
  "protocol_version": "2024-11-05",
  "transport": {
    "type": "sse",
    "url": "http://127.0.0.1:8772/sse"
  },
  "authentication": {
    "type": "oauth2",
    "url": "http://127.0.0.1:8772/.well-known/oauth-authorization-server"
  }
}
```

### Token Endpoint

```
POST http://127.0.0.1:8772/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
code=<auth_code>
code_verifier=<pkce_verifier>
client_id=<your_client_id>
```

**Response:**
```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

---

## Environment Variables

Optional configuration in `.env.local` or `.env`:

```bash
# Disable auto-start of MCP servers (default: true)
LANTERN_MCP_SERVER=true
LANTERN_MCP_OAUTH=true

# OAuth2 configuration
MCP_OAUTH_PORT=8772
MCP_OAUTH_HOST=127.0.0.1
MCP_OAUTH_JWT_SECRET=your-secret-here
MCP_OAUTH_ISSUER=lantern-os-mcp-oauth
MCP_OAUTH_TOKEN_TTL=60
```

---

## Testing

### Test Local MCP (No Auth)

```bash
curl http://127.0.0.1:8771/health
```

### Test OAuth2 Server

```bash
# Health check
curl http://127.0.0.1:8772/health

# Discovery
curl http://127.0.0.1:8772/.well-known/oauth-authorization-server

# MCP metadata
curl http://127.0.0.1:8772/.well-known/mcp
```

### Test Public URLs (via Cloudflare Tunnel)

```bash
# Dream Journal
curl https://lantern-os.net/health

# MCP
curl https://mcp.lantern-os.net/health

# OAuth2 MCP
curl https://mcp.lantern-os.net/oauth/health
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Connection refused" on port 8772 | Ensure `npm start` is running and MCP server started. Check logs: `[MCP OAuth Server] Starting on port 8772...` |
| OAuth discovery returns 404 | Use correct endpoint: `/.well-known/oauth-authorization-server` (not `/oauth/discover`) |
| ChatGPT says "Invalid URL" | Verify port 8772 is accessible locally or Cloudflare tunnel is running |
| "Only one usage of each socket address" | Port 8772 already in use. Kill previous processes and restart. |
| OAuth token invalid after restart | Set `MCP_OAUTH_JWT_SECRET` in `.env` to persist across restarts |

---

## Next Steps

1. **Start servers:** `npm start`
2. **Test OAuth:** `curl http://127.0.0.1:8772/.well-known/oauth-authorization-server`
3. **Claude API:** Connect using the SDK configuration above
4. **ChatGPT:** Follow the connector setup steps with the OAuth endpoints
5. **Cloudflare:** Deploy publicly once tested locally (see [CLOUDFLARE-TUNNEL-DEPLOYMENT.md](./CLOUDFLARE-TUNNEL-DEPLOYMENT.md))

---

## Resources

- [OAuth 2.0 Authorization Code Flow with PKCE](https://tools.ietf.org/html/rfc7636)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
- [OpenAI Custom Connectors](https://platform.openai.com/docs/guides/connectors)
- [Claude Models API](https://docs.anthropic.com/en/docs/about-claude/latest-claude)
