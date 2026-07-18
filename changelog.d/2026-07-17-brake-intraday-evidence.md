Streaming-brake evidence run (ADR-0028 Phase-2 follow-up):
`experiments/brake_intraday_evidence.py` + committed results JSON answer "does
a faster (hourly) brake beat the daily brake, or does whipsaw eat the
benefit?" on a real 730-trading-day Yahoo hourly panel (8-ETF universe,
identical monthly tangency direction, identical costs — only brake cadence
differs; corrupt Yahoo stale wicks repaired by a revert-checked 4x-median
clamp, 131 repairs). Measured verdict: the hourly brake dominated the daily
brake on final equity, Sharpe, and bar-resolution maxDD at essentially
IDENTICAL total turnover (~15.9x each) — whipsaw did NOT eat the latency
benefit; on the worst day (2025-04-04 tariff crash, a Friday) it de-levered 6
trading bars / 71 wall-clock hours earlier, worth about +$612 on a $33k book
over the episode. Static 2x still finished highest in this bull window —
brakes cost upside in bulls; conclusions are mechanism-only (latency vs
whipsaw), with wide overlapping Lo-CIs stated. (Improves Verify — evidence
before any faster-brake product code.)
