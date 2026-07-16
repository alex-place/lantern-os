# FOUNDRY Matrix RAG Dollhouse

Status: build candidate.

This is the local-first matrix for turning the server farm, PCs, phones, repos,
documents, and shareholder surfaces into one navigable RAG dollhouse. Risk is
used as routing metadata, not as a stop sign.

## Web Search Inputs

| Source | Signal | Decision |
|---|---|---|
| Ollama Windows docs, `https://docs.ollama.com/windows` | Windows local model server and `localhost:11434` API path | Use for primary PC and server nodes where suitable |
| Ollama API docs, `https://docs.ollama.com/api` | Stable local HTTP API plus Python/JavaScript libraries | Use as simple model-serving interface |
| Qdrant docs, `https://qdrant.tech/documentation/` | Dense, sparse, multivector, filtering, and open-source/private deployment | Use as default server-farm vector layer |
| Qdrant hybrid search docs, `https://qdrant.tech/documentation/concepts/hybrid-queries/` | Dense + sparse retrieval and re-ranking pipeline support | Use hybrid retrieval for precision |
| Apple Shortcuts + Apple Intelligence, `https://support.apple.com/guide/iphone/use-apple-intelligence-in-shortcuts-iph78c41eaf8/ios` | iPhone shortcuts can use on-device, Private Cloud Compute, or ChatGPT actions | Use iPhone as edge control/capture node |
| Apple iPhone/iPad secure boot, `https://support.apple.com/guide/security/boot-process-for-iphone-and-ipad-devices-secb3000f149/web` | iPhone boot chain is signed and verified | Do not treat iPhone as normal PC dual boot |

## Architecture

```text
FOUNDRY Matrix
  Rooms
    Repo Room
    PDF/Doc Room
    Windows Surface Room
    Dual-Boot Room
    Server-Farm Room
    iPhone Edge Room
    Shareholder Room
  Lanes
    Ingest -> Normalize -> Chunk -> Embed -> Index -> Retrieve -> Rerank
    Claim -> Evidence -> Confidence -> Decision -> Artifact -> Handoff
    Local Node -> Server Farm -> Edge Phone -> Operator Approval -> Push
```

## Node Matrix

| Node | Role | First Interface | RAG Duty | Action |
|---|---|---|---|---|
| Primary Windows PC | operator workstation | PowerShell + Windows surface | local ingest, testing, PDF generation | keep as control surface |
| Server farm | inference + vector pool | LAN service endpoints | embeddings, Qdrant, model serving, reranking | inventory before sizing |
| Son's PC | second dual-boot + edge worker | read-only readiness script | optional ingest/compute node | create readiness packet |
| iPhone | edge capture/controller | Shortcuts/web/SSH app | capture prompts, approve tasks, view results | build Shortcut/API path |
| Second phone | mobile edge candidate | unknown | capture/control after model identified | identify model/OS first |
| GitHub repos | source rooms | git/GitHub | code/doc evidence | crawl only with dirty-state guards |

## Dollhouse Rooms

| Room | Contents | Index Type | Output |
|---|---|---|---|
| Repo Room | code, manifests, git logs, issues | file path + symbol + commit | claim-linked engineering state |
| PDF/Doc Room | COMET LEAP PDFs, reports, screenshots | page + section + artifact hash | shareholder packets |
| Windows Surface Room | shortcuts, icons, launchers, scripts | asset + launcher metadata | installable local surfaces |
| Dual-Boot Room | readiness reports, hardware, rollback docs | machine + disk + gate state | operator install packet |
| Server-Farm Room | nodes, GPUs/NPUs, storage, services | node inventory + capacity class | local token capacity plan |
| iPhone Edge Room | shortcuts, captures, approvals | action + timestamp + device | mobile command lane |
| Shareholder Room | reports, money streams, confidence tables | claim + confidence + source | board-ready narrative |

## Retrieval Policy

1. Use hybrid retrieval when possible: lexical/sparse for exact names and dense
   vectors for semantic recall.
2. Store source path, repo, commit, page, line, hash, and evidence class as
   metadata on every chunk.
3. Retrieve more than needed, rerank, then compress down to a small evidence
   pack.
4. Never merge operator assertions with verified state without labeling them.
5. Keep offline/server-farm inference unmetered in token accounting; meter
   power, hardware, cooling, maintenance, and cloud escalation separately.

## First Build Loop

1. Inventory server-farm nodes: hostname, OS, CPU, RAM, GPU/NPU, storage,
   network, power/cooling notes.
2. Stand up one local model endpoint using Ollama or llama.cpp.
3. Stand up one vector endpoint using Qdrant.
4. Ingest only `lantern-os` first.
5. Add HFF scan and orchestrator as read-only source rooms after dirty-state
   snapshot.
6. Create iPhone Shortcut that sends a prompt/capture to the local endpoint or
   dashboard.
7. Create son's PC readiness packet and run read-only checks on that machine.
8. Generate a shareholder evidence packet from retrieved claims.
9. Fix first 2-4 failures and loop.

## Held Boundaries

- No destructive disk action on any PC without physical operator approval.
- No true phone dual boot without exact model, backup, boot path, risk, and
  rollback evidence.
- No cloud token burn claim without current provider pricing.
- No server-farm capacity claim without inventory.

## Next Artifact Targets

| Artifact | Path | Status |
|---|---|---|
| Server farm inventory schema | `manifests/foundry-server-farm-inventory.md` | next |
| iPhone edge-node checklist | `manifests/iphone-edge-node.md` | next |
| Son's PC dual-boot readiness packet | retired 2026-07-16 (in git history) | retired |
| Local RAG ingest script | `scripts/Invoke-FoundryRagIngest.ps1` | candidate |
