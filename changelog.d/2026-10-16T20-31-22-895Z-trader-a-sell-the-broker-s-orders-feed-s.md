### Fixed

- Trader: a sell the broker's orders feed shows FILLED in a scan no longer gets a second sell in that same scan (stop-size, ratchet, gap-auction, re-protect and held-exit passes skip it). The positions snapshot lags the orders feed; on 2026-10-16 stable re-stopped XLE after its step-floor stop had filled and went short 2,628 shares
