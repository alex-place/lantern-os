---
author: Alex Place
created: 2026-06-23
updated: 2026-06-23
status: stub
---

# Keystone OS — Architecture (Current State)

> **Status: stub (Phase 2 of [#1083](https://github.com/alex-place/lantern-os/issues/1083)).**
> This document will be the canonical "what the system *is* today" snapshot, superseding the
> dated [ARCHITECTURE-AUDIT-2026-06-13.md](ARCHITECTURE-AUDIT-2026-06-13.md). It is not yet
> written — the [ADR practice](adr/README.md) (Phase 1) landed first so decisions have a home.

## Purpose

ARCHITECTURE.md answers **"what is true now"**; the [ADRs](adr/README.md) answer **"what did
we decide and why"**. Every important claim here must carry evidence (`file:line` / commit /
PR) per the Σ₀ External Reality Rule.

## Planned sections (Phase 2)

- System context — entrypoints (`apps/lantern-garage/server.js` @ 4177, `cloud-server.js` on
  Railway, dual-boot 4177/4178, gh-pages static)
- The one loop + four core objects (Memory / Task / Tool / Convergence Record) mapped to real
  modules, incl. [`src/convergence/kernel.py`](../src/convergence/kernel.py)
- Subsystems: garage server + `lib/*`, trading (`routes/trading.js`, kalshi-*), CSF/Tesseract
  storage (`src/csf/`), MCP server (`src/mcp_server/`), Σ₀/Ouro serving + training,
  orchestration/autowork/fleet, skills layer
- Persistence model (`data/*.json` + `*.jsonl` append + CSF archive)
- Provider abstraction + fallback chain
- Auth/security posture (Patreon OAuth flag, Cloudflare tunnel, operator gating)
- **Known divergences / debt** — named, not papered over

See [docs/adr/README.md](adr/README.md) for how the two documents relate.
