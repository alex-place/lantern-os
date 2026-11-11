### Fixed

- IBKR accounts with a non-USD base currency (stable's IB-CAN paper account, CA$1M) are now read in USD: equity, cash, buying power and P&L are restated at the ledger's own exchange rate, so sizes, caps, the cash reserve and the session row stop mixing CAD totals with USD positions (stable had been sizing ~1.42x and its session rows showed a fake 'equity gap'). The day's equity change restates the previous CAD session row; IBKR_REPORT_CURRENCY=base keeps the old behaviour.
