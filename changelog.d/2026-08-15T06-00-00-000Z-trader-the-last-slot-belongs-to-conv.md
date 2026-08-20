### Changed

- trader: the last concurrency slot is reserved for conviction (`TRADER_SLOT_RESERVE=1`, threshold `TRADER_SLOT_RESERVE_PWIN=0.55`) — sub-threshold signals fill only cap−1 slots, so weak probes can no longer starve a strong signal (2026-08-14: five slots of sub-0.50 probes refused a 0.61 SMH that ran +0.82%; the sub-0.50 cohort netted −$516 that week). Not lab-gateable (no p_win on daily bars) — every refusal writes an audit row carrying its own p_win so live data accumulates the counterfactual. Kill: `TRADER_SLOT_RESERVE=0`
