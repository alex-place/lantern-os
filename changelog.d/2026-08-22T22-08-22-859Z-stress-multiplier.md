### Added

- TRADER_STRESS_MULT (default off): size up when the prior VIX close is at/above TRADER_STRESS_VIX (20) or SPY session IBS is at/below TRADER_STRESS_SPY_IBS (0.3) — the gates/caps lab (Nagel 2012) measured ×1.5 on VIX ≥ 20 at +89% holdout return with unchanged drawdown; scales the risk target and the notional cap together; entries journal stress_mult/stress_why/vix_prior
