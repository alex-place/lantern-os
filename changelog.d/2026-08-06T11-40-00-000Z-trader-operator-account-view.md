### Fixed

- trader UI: the dashboard showed $0.00 account value / $0 buying power for an admin while the autonomous trader was running a real IBKR account. The trader keys the operator account on the fixed id `local-owner`; the UI resolved the browser session's profile id. An admin whose own profile has no broker linked now falls back to the operator account (flagged `operator_view`), so the dashboard can see the book it exists to monitor.
