### Added
- **Quickboot can bring up the local Sigma-0 model server (Ouro-1.4B) — opt-in.**
  `scripts/Start-DualServers.ps1` now launches `scripts/ouro_serve.py` on `:11434`
  (Ollama-compatible, `OURO_4BIT=1` → ~1.85 GB VRAM) when `KEYSTONE_SERVE_OURO=1`, so the
  local model comes up as part of the dual-boot quickstart instead of never starting.
  Off by default; idempotent (skips if `:11434` is already listening); best-effort (a
  model-server hiccup never blocks the web servers). It loads at boot when free RAM is
  highest — the fp16→4-bit *load* transient is what OOMs an already-busy desktop, not the
  small resident footprint. The 7.6B `keystone-sigma0-plt` is deliberately **not**
  auto-served here: it needs a ≥24 GB GPU box (see `models/keystone-sigma0-plt/README.md`)
  and RAM-thrashes an 8 GB/12 GB machine. Improves the **Reason** stage — a local model
  backend actually reachable on boot (ADR-0005 interchangeable providers, ADR-0011).
