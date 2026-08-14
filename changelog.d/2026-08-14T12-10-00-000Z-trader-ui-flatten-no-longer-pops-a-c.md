### Changed

- trader-ui: Flatten no longer pops a confirm for IBKR warnings when the server can verify the sell reduces the held position (qty ≤ |held|) — verified risk-reducing sells auto-accept, the same policy the engine's own exits have used since 2026-07-27, with `auto_warnings:'risk_reducing_sell'` on the response for the audit trail. The confirm remains only for the unverifiable case (feed unreadable, size mismatch, symbol not held) and now says why it appeared. Oversells, unknown symbols, dust-only positions, and all buys still never auto-clear
