### Fixed

- trader-ui: manual orders now work outside regular hours. Flatten and the dust probe sent plain MARKET orders, which do not execute outside RTH — so a pre-market Flatten sat until the 09:30 auction while the toast said "✓ Flattened", and the dust probe's accepted order went Inactive at the broker with no row anywhere. The engine has converted since 2026-08-12; the manual paths now do the same (marketable limit ±0.2% with `outsideRth`), the weekend case says the order QUEUES rather than claiming success, and the dust probe records its order so it appears in the Orders tab
