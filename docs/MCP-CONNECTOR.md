# Lantern OS MCP Connector

Status: candidate connector scaffold

This document defines the local-first MCP connector path for Lantern OS and the safe route into internal house RAG storage.

## Purpose

The connector exists to verify the real local MCP surface before any operator, Codex, Claude, GPT, Gemini-style, or automation agent trusts it.

It does not grant authority by itself. It records reachability, visible endpoints, safety boundaries, and next action.

## Work Split

MCP work is split in `manifests/MCP-WORK-SPLIT.md` across connector contract, connector probe, fleet count validation, runtime count report, tool descriptor review, RAG/memory routing, and OS issue review lanes.

The 12x3 convergence ring in `manifests/CONVERGENCE-LOOP-AGENT-FLEET.md` may review these lanes, but live MCP tool and live worker claims remain held until current local evidence exists.

## Commands

Verify local MCP health and tool discovery candidates:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-LanternMcpConnector.ps1
```

Write the latest validation JSON to:

```text
manifests/validation/MCP-CONNECTOR-LATEST.json
```

Validate the designed convergence fleet counts:

```powershell
python .\scripts\Test-ConvergenceAgentFleet.py --write-json .\manifests\validation\CONVERGENCE-FLEET-LATEST.json
```

Build the internal RAG-house index without copying file bodies:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Update-InternalHouseRag.ps1
```

Build the internal RAG-house index with selected text bodies:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Update-InternalHouseRag.ps1 -IncludeFileBodies
```

Outputs:

```text
data/internal-rag-house/LANTERN-OS-INTERNAL-HOUSE-RAG.flat.md
data/internal-rag-house/RAG-HOUSE-MANIFEST.json
data/internal-rag-house/RAG-HOUSE-MANIFEST.sha256
```

## Connector Safety Contract

Default policy:

- Use `http://127.0.0.1:8787`.
- Treat remote tunnels as untrusted until endpoint, auth, and exposed tools are verified.
- Do not run arbitrary shell through MCP.
- Do not accept advertised capability as proof.
- Do not mutate repos, disks, bootloaders, wallets, secrets, or private folders from connector discovery.
- List tools, inspect descriptors, verify parameters, then invoke the minimum safe tool.

## Evidence Classes

- `local_verified`: validation JSON, generated manifests, hashes, or local test output observed now.
- `github_metadata`: repository metadata from the GitHub connector.
- `source_repo_evidence`: inspected source files in this repository.
- `operator_asserted`: operator instruction not yet verified locally.
- `held`: blocked by secrets, physical access, destructive action, or missing local validation.

## What "Move Relevant Code" Means

Safe meaning:

1. Copy/promote selected code or docs into Lantern OS.
2. Record source path, hash, evidence class, and boundary status.
3. Build the internal RAG-house flat index and manifest.
4. Validate the promoted surface.
5. Only after review, retire or deprecate old source paths.

Unsafe meaning, not allowed by this connector:

- delete source repos;
- reset dirty worktrees;
- overwrite existing files blindly;
- import secrets or raw private data;
- claim that metadata-only repos were locally cloned;
- mark v1.0.0 ready without the convergence loop.

## Current Held Items

- Full local MCP JSON-RPC tool enumeration is held until the local MCP server is running and its discovery route is confirmed.
- Streaming chat to GPT/Codex/Claude is held until each endpoint, token, terms, and local bridge are verified.
- Linux/NixOS primary boot is held until physical boot state and rollback are verified.
- Removing Windows or mutating partitions remains blocked.
- Live 36-agent or 64-worker claims are held until a current local orchestrator count report exists.

## Promotion Gate

A connector update is shippable only when:

- `scripts/Test-LanternMcpConnector.ps1` runs and writes validation JSON;
- `scripts/Test-ConvergenceAgentFleet.py` validates the designed fleet counts;
- `scripts/Update-InternalHouseRag.ps1` generates the flat RAG file and manifest;
- no secrets or private folders are included;
- validation output is reviewed before any agent write action;
- the convergence loop is rerun.
