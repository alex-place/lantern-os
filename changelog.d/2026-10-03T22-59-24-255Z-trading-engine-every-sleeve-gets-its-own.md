### Changed

- trading engine: every sleeve gets its own brain instance — sleeves sharing an app tree (S, the noise leg, the close-IBS sleeve) no longer share the first sleeve's cooldowns, clocks, cadence decision, stop registry, journal and state file
