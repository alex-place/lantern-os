### Fixed
- **Exits on fractional positions no longer loop forever (first armed session
  finding).** IBKR CPAPI rejects fractional share orders: a 838.8-share SOXS
  take-profit was decided 4× and broker-canceled every time (28 canceled orders)
  while +44% ran to +50% unrealized. The bridge now floors IBKR order quantities
  to whole shares and reports the <1-share dust in the order reason; a dust-only
  position errors clearly instead of looping. 3 tests.
- **Runtime trading ledgers/state are now gitignored** (`data/**/trading`
  `*.jsonl` + `*-state.json`, both roots) — a dev-checkout sweep erased
  `overnight-state.json` mid-entry-window and the engine re-entered its option
  ladder (a real double fill on the paper account). Ignored files survive
  `git stash -u`/clean sweeps.
