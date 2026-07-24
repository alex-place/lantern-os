### Added

- docs/adr: **ADR-0032 — real-money trading onboarding** (Phase 3 of the Alpaca-first
  work). A design-only contract for how a user safely crosses from paper to live: live
  keys are a **separate, explicitly-entered credential** (never an auto-promotion of
  paper keys), enabling live is a **multi-step opt-in** behind the existing operator
  double-gate (`TRADER_LIVE=1` + `TRADER_ALLOW_LIVE_ACCOUNT=1`) plus a recorded risk
  attestation, **manual** live orders require per-order confirmation (never one-click),
  **autopilot** on real money stays gated on the ADR-0028 Sharpe-CI mandate, and the
  assistant never places trades. **No live trading is enabled by this ADR** — it's the
  contract the eventual implementation must satisfy. Indexed in `docs/adr/README.md`.
