# MCP Client Setup

Connect Lantern OS tools to ChatGPT, Grok, Claude Desktop, and Cursor.

**Base URL:** `https://mcp.lantern-os.net`

---

## ChatGPT (OAuth 2.1 + PKCE)

ChatGPT requires OAuth — it does not support static Bearer tokens.

1. Open [ChatGPT](https://chatgpt.com) → **Explore GPTs** → **Create a GPT** (or open an existing one)
2. Go to **Configure → Actions → Add action**
3. Click **Import from URL**, enter:
   ```
   https://mcp.lantern-os.net/.well-known/oauth-authorization-server
   ```
   ChatGPT will auto-detect the OAuth metadata.
4. Set **Authentication** to **OAuth**:
   - Authorization URL: `https://mcp.lantern-os.net/oauth/authorize`
   - Token URL: `https://mcp.lantern-os.net/oauth/token`
   - Client ID: `chatgpt` (must match `MCP_OAUTH_CLIENT_ID` in your `.env`)
   - Client Secret: *(leave blank — public client, PKCE only)*
   - Scope: `mcp`
5. Point the action at: `https://mcp.lantern-os.net/mcp`
6. Save — ChatGPT will redirect you through the approval page the first time.

---

## Claude Desktop (Bearer token)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "lantern-os": {
      "url": "https://mcp.lantern-os.net/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

Leave `Authorization` out if `MCP_API_KEY` is not set (open mode).

---

## Grok

In Grok settings → **Connectors** → **Add connector**:

- **Type:** MCP (Streamable HTTP)
- **URL:** `https://mcp.lantern-os.net/mcp`
- **Auth:** Bearer token → `YOUR_MCP_API_KEY` (or leave blank if open)

---

## Cursor

In `.cursor/mcp.json` at repo root:

```json
{
  "mcpServers": {
    "lantern-os": {
      "url": "https://mcp.lantern-os.net/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

---

## Available tools

| Tool | Description |
|------|-------------|
| `get_status` | System health + uptime |
| `queue_status` | View work queue |
| `task_intake` | Submit a task |
| `dispatch_work` | Dispatch to an agent |
| `list_skills` | List available skills |
| `boot_check` | Orchestrator boot status |
| `fleet_status` | Agent fleet slot counts |
| `web_search` | DuckDuckGo search |
| `mesh_status` | P2P mesh topology |
| `update_lantern_os` | Pull + restart server |

---

## Local dev

For local testing without the tunnel, point clients at `http://127.0.0.1:8771/mcp`.
Auth is bypassed when `MCP_API_KEY` is unset.
