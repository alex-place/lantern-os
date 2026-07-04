### Fixed — stock trader Day P&L / Realized now populate (broker-authoritative)

The Node/IBKR trader's account object returned only `{equity, cash, buying_power, unrealized}`,
but the UI reads `pnl_today` and `realized_today` — so the header **Day P&L** always showed
`+$0` and the panel **Realized P&L** was blank. Added `ibkr-cpapi.getPnl()`
(`/iserver/account/pnl/partitioned` → `dpl`/`upl`/`rpl`, IBKR's authoritative DAY P&L that
reconciles with the day's equity change) and wired `pnl_today` (dpl), `unrealized` (upl), and
`realized_today` (dpl − upl) into the account so the panel adds up: **Realized + Unrealized =
Day P&L**. When the pnl endpoint is unavailable the fields are honestly `null` (header shows
`—`, not a fake `+$0`). Also fixed the header showing a loss as `$208` instead of `−$208`.
Unit-tested (3 cases).
