### Added

- trader: EOD de-carry (#3298-3) — from 15:50 ET, held leveraged names (the 8 gated 3x symbols) are flattened into the close with reason `eod_decarry`; stops cannot protect through a gap and 3x carries 3x overnight exposure at equal notional (64% of the 8/13→14 give-back was the gap). A pin overrides it (deliberate carry, narrated); 1x names hold freely; kill `TRADER_EOD_DECARRY=0`. Rider: sub-share dust rows render a "dust" chip instead of a Flatten button that cannot work (IBKR floors fractional to 0), and the Positions badge counts only real positions
