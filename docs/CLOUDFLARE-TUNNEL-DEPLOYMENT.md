# Lantern OS — Cloudflare Tunnel Deployment Guide

**Version:** 1.0  
**Status:** ⚠️ DEPRECATED — superseded by the GCE deployment (2026-07-18)  
**Last Updated:** 2026-07-18  

---

> **Deprecated — not the production path.** This guide describes the legacy model: a
> `cloudflared` tunnel from Cloudflare's edge to `server.js` running on the **local fleet
> host** (port 4177). Per **[ADR-0018 (Accepted)](adr/0018-web-tier-split-and-cloud-multi-tenancy.md)**,
> the production origin is now a **GCE VM** running `server.js`, with Cloudflare kept only as
> the **edge/CDN** in front of it. Deploy and operate production via the
> **[GCE Cloud Deploy Runbook](ops/gce-cloud-deploy-runbook.md)** — do not point live DNS at a
> local tunnel. This tunnel remains usable for **local dev exposure or as a fallback** only;
> the steps below are retained for that purpose and for historical reference.

---

## Overview

Lantern OS uses **Cloudflare Tunnel** to expose the Dream Journal and MCP server publicly via a custom domain (`lantern-os.net`) while keeping the local machine private.

**Benefits:**
- ✅ No port forwarding or router changes needed
- ✅ HTTPS/TLS encryption by default
- ✅ DDoS protection and WAF included
- ✅ Zero Trust access control (optional)
- ✅ Instant public access (no DNS propagation wait)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  LOCAL MACHINE (lantern-os)                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Port 4177 (Dream Journal)                                     │
│  │                                                             │
│  ├─→ Cloudflare Tunnel Agent                                 │
│      │                                                         │
│      └─→ HTTPS://lantern-os.net (Internet)                   │
│                                                                 │
│  Port 8771 (MCP Server)                                       │
│  │                                                             │
│  ├─→ Cloudflare Tunnel Agent                                 │
│      │                                                         │
│      └─→ HTTPS://mcp.lantern-os.net (Internet)              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Access Points

### Local (Development)

```
http://127.0.0.1:4177          — Dream Journal chat UI
http://127.0.0.1:4178          — Development server (if running)
http://127.0.0.1:8771          — MCP server (no auth)
http://127.0.0.1:8772          — MCP server (OAuth2 protected)
```

### Public (Production via Cloudflare Tunnel)

```
https://lantern-os.net         — Dream Journal chat UI + API
https://mcp.lantern-os.net     — MCP server (no auth, port 8771)
https://mcp.lantern-os.net/oauth — MCP server (OAuth2, port 8772)
```

---

## Setup Steps

### 1. Install Cloudflare Tunnel Agent (One-Time)

Download and install `cloudflared`:

```powershell
# Windows (Chocolatey)
choco install cloudflare-warp

# Or download directly
iwr https://github.com/cloudflare/cloudflared/releases/download/latest/cloudflared-windows-amd64.exe -OutFile $env:USERPROFILE\cloudflared.exe
```

### 2. Authenticate with Cloudflare

```powershell
cloudflared tunnel login
```

This opens a browser and asks you to:
1. Select your Cloudflare account
2. Authorize the tunnel agent
3. Choose the domain (must be a domain you own in Cloudflare DNS)

A certificate file is saved to: `~\.cloudflare\cert.pem`

### 3. Create a Tunnel

```powershell
cloudflared tunnel create lantern-os
```

Output:
```
Tunnel credentials written to ~/.cloudflare/lantern-os.json
Tunnel ID: <UUID>
Tunnel Name: lantern-os
Account Tag: <account_id>
```

### 4. Configure Tunnel Routes

Create or update `cloudflare-config.yml` in your lantern-os root:

```yaml
tunnel: lantern-os
credentials-file: ~/.cloudflare/lantern-os.json

ingress:
  # Dream Journal
  - hostname: lantern-os.net
    service: http://127.0.0.1:4177
    tlsSkip: false

  # MCP server (no auth)
  - hostname: mcp.lantern-os.net
    path: ^(?!/oauth).*
    service: http://127.0.0.1:8771
    tlsSkip: false

  # MCP server (OAuth2)
  - hostname: mcp.lantern-os.net
    path: /oauth.*
    service: http://127.0.0.1:8772
    tlsSkip: false

  # Fallback
  - service: http_status:404
```

### 5. Create DNS CNAME Records in Cloudflare Dashboard

In [Cloudflare DNS panel](https://dash.cloudflare.com), add:

```
Type    Name           Content                        TTL
-----   ----           -------                        -----
CNAME   lantern-os     <tunnel-id>.cfargotunnel.com  Auto
CNAME   mcp            <tunnel-id>.cfargotunnel.com  Auto
```

Replace `<tunnel-id>` with your actual tunnel ID from Step 3.

### 6. Start the Tunnel

```powershell
cloudflared tunnel run lantern-os
```

Or run in background:

```powershell
cloudflared tunnel run lantern-os --config cloudflare-config.yml
```

### 7. Verify Public Access

```bash
# Test Dream Journal
curl https://lantern-os.net/health

# Test MCP
curl https://mcp.lantern-os.net/health

# Test OAuth2 MCP
curl https://mcp.lantern-os.net/oauth/discover
```

---

## Autostart on Windows

Register the tunnel as a Windows service so it starts automatically:

```powershell
# Install as service
cloudflared service install --config cloudflare-config.yml

# Start service
net start cloudflared

# Check status
Get-Service cloudflared
```

To uninstall:
```powershell
cloudflared service uninstall
```

---

## Securing with Zero Trust (Optional)

### Enable Zero Trust Access

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com)
2. Navigate to **Access → Applications**
3. Create new application:
   - **Name:** Dream Journal
   - **Domain:** lantern-os.net
   - **Authorization:** Require authentication (email, GitHub, Discord, etc.)

4. Set policy to allow specific users/groups

This enforces login before accessing the service.

### OAuth2 Provider Setup (For OAuth2 MCP Endpoint)

The MCP OAuth2 endpoint at `https://mcp.lantern-os.net/oauth` is pre-configured to support:

**Google OAuth2**
```
Authorization URL: https://mcp.lantern-os.net/oauth/authorize?provider=google
Callback: https://mcp.lantern-os.net/oauth/callback/google
```

**GitHub OAuth2**
```
Authorization URL: https://mcp.lantern-os.net/oauth/authorize?provider=github
Callback: https://mcp.lantern-os.net/oauth/callback/github
```

**Discord OAuth2**
```
Authorization URL: https://mcp.lantern-os.net/oauth/authorize?provider=discord
Callback: https://mcp.lantern-os.net/oauth/callback/discord
```

See ``docs/OAUTH2-MCP-SETUP.md`` for full configuration.

---

## Monitoring & Logs

### View Tunnel Status

```powershell
cloudflared tunnel status lantern-os
```

### View Logs

```powershell
# Real-time logs
Get-EventLog -LogName "Cloudflare" -Newest 50

# Or via command line
cloudflared tunnel logs lantern-os
```

### Monitor in Dashboard

Go to [Cloudflare Dashboard → Tunnels](https://dash.cloudflare.com/tunnels) and click your tunnel to see:
- Connection status
- Recent requests
- Bandwidth usage
- Error rates

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Tunnel already running" | Kill previous process: `Get-Process cloudflared \| Stop-Process` |
| CNAME not working | Wait 5 minutes for DNS propagation; check TTL in Cloudflare panel |
| 502 Bad Gateway | Verify local server is running on port 4177; check firewall |
| Slow response | Check Cloudflare dashboard for rate limiting; increase plan if needed |
| Certificate errors | Ensure `tlsSkip: false` in config; check certificate renewal |

---

## URL Routing Reference

| Service | Local | Public |
|---------|-------|--------|
| Dream Journal UI | http://127.0.0.1:4177 | https://lantern-os.net |
| Dream API | http://127.0.0.1:4177/api/* | https://lantern-os.net/api/* |
| MCP (No Auth) | http://127.0.0.1:8771 | https://mcp.lantern-os.net |
| MCP (OAuth2) | http://127.0.0.1:8772 | https://mcp.lantern-os.net/oauth |

---

## Next Steps

1. **`Email Setup`** — Configure lantern-os.net email
2. **`OAuth2 MCP`** — Set up OAuth2 authentication
3. **[Zero Trust](https://developers.cloudflare.com/cloudflare-one/)** — Require login before access
4. **[Analytics](https://dash.cloudflare.com/analytics)** — Monitor traffic and performance

---

## Resources

- [Cloudflare Tunnel Documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
- [cloudflared GitHub](https://github.com/cloudflare/cloudflared)
- [Cloudflare Zero Trust](https://www.cloudflare.com/zero-trust/)
