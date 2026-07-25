# Mesh Hub — N-User Contributor Mesh

Lantern OS supports any number of contributors, each running agents on their
own machine with their own provider keys and their own Claude Code login.
Capacity scales by adding nodes, not by sharing accounts.

Current members: **alex** (operator), **courtney**, **mookman11**, **kirskin** —
see `config/mesh-members.json` (archived 2026-07-24; mesh registry now empty by default).

## The capacity model

- **Each node uses its own keys.** Provider keys live in each machine's local
  `.env` — they are never shared or committed. Rate limits, billing, and
  Claude Code session limits are all per-person, so every node added is real,
  independent capacity.
- **Each member gets a sovereign branch lane.** The Triforce stream hooks treat
  every branch prefix as its own PR lane: `courtney/`, `mookman11/`, `kirskin/`
  work exactly like `claude/` or `codex/`. One open PR per lane; lanes run
  concurrently.
- **Do not share Claude.ai / Claude Code logins.** Per-account limits are
  per-person by design. API keys for a shared project are fine with the owner's
  consent — cleanest is one org with member workspaces.

## Joining the mesh (any new user)

1. **PR yourself into the registry.** Add an entry to
   `config/mesh-members.json` (id, displayName, branchPrefix, stream
   `COURAGE`, role `contributor`). That PR — opened from your own lane — is
   your first contribution. There is intentionally no registration API.
2. **Clone and hook up:**
   ```powershell
   git clone https://github.com/alex-place/lantern-os.git
   cd lantern-os
   git config user.name "<your-member-id>"
   powershell -ExecutionPolicy Bypass -File scripts/Install-MonoworkstreamHooks.ps1
   ```
3. **Add your own keys.** Copy `.env.example` to `.env` and fill in whichever
   provider keys you have (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …). Your
   node's server uses your keys only.
4. **Read the required docs** (enforced by hooks): `QUICKSTART.md`,
   `AGENTS.md`, `CLAUDE.md`, `PROVIDERS.md`, `SECURITY.md`.
5. **Work in your lane.** Branch as `<your-id>/<topic>`, open PRs to `master`.
   A second branch in your lane is blocked until your open PR merges.

## Presence — heartbeats

Member machines report in so the fleet view knows who's online:

```powershell
powershell -File scripts/Send-MeshHeartbeat.ps1 -Member courtney `
  -Agents claude-code,ollama -Providers anthropic -Note "refactor lane"
```

- Local hub: `http://127.0.0.1:4177` (default). Shared hub: pass
  `-Hub <railway-url>` to report into the cloud instance.
- Schedule it every few minutes (Task Scheduler) to stay "online" — the
  window is 5 minutes.
- Heartbeats from ids not in the registry are rejected.

## Hub API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/mesh/members` | GET | Full registry + presence (online, lastSeen, machine, agents, providers) |
| `/api/mesh/status` | GET | Compact aggregate — counts + online ids |
| `/api/mesh/heartbeat` | POST | `{ member, machine, agents[], providers[], note }` — member must be registered |

Heartbeats append to `data/mesh/heartbeats.jsonl` via the async file queue;
the latest per member is cached in memory and re-seeded from the log tail on
restart.

## Notes

- The `keystone-ft` managed agent and its memory store live on the operator's
  Anthropic account. Other members' keys fall back to the standard messages
  API for that provider — the connector handles this automatically.
- Multi-key rotation on a single server (pooling several members' keys in one
  `.env`) is intentionally **not** implemented — the mesh model makes it
  unnecessary, since each node brings its own keys.
