---
author: Alex Place
created: 2026-06-01
updated: 2026-06-20
---

# Repository Contract: SCM vs. Archive

**Effective:** 2026-06-11  
**Goal:** Keep repository lean (source + tests + deployment) while preserving historical context in archive

---

## What Stays in SCM (Repo Root)

### Code & Deployment (Required)
- `apps/` — Source code (all services)
- `src/` — Python services & MCP server
- `tests/` — Test suites
- `scripts/` — Deployment & automation scripts
- `.env.example` — Configuration template
- `Makefile` — Build automation

### Essential Docs
- `QUICKSTART.md`, `AGENTS.md`, `CLAUDE.md`, `PROVIDERS.md`, `SECURITY.md`
- `CONVERGENCE_COMPLETE.md` — Current status

### Active Data
- `data/conversations/`, `data/csf/` — Live state
- `data/contexts/` — Persona definitions

---

## Archive to D:\tmp (Not Active)

**Historical Docs:**
- ALEX-ASI-ARCHITECTURE.md, ACTION-POOLING.md, AGENT-SWARM-OPERATIONS.md
- BETTERSAFE*.md, CLEANUP.md, ARC-REACTOR*.md
- benchmarks/, old CODEMAP versions

**Generated Artifacts:**
- data/images/caadi/
- csf/ingest/ (old versions)
- manifests/old-*.json
- caad/ (v1-v6)

---

## Migration Steps

1. Create archive: `mkdir D:\tmp\lantern-os-archive-2026-06-11-consolidated`
2. Copy archived files to archive with structure preserved
3. Delete from repo
4. Commit: "chore: Archive historical docs to D:\tmp"
5. Push to master

---

## Result

✅ Repo lean (200MB → 120MB)  
✅ Full history preserved in D:\tmp  
✅ Git operations faster  
✅ Production-focused codebase
