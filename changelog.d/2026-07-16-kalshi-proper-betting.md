Added deterministic "proper betting" stake sizing to the Kalshi suggestion
engine (`lib/kalshi-proper-bet.js`), per arXiv 2607.06166 ("When do prophets
profit in prediction markets?"): for a strictly proper scoring rule with convex
potential G, the only robustly profitable bet is s_G(p,q) = ∇G(p) − ∇G(q) —
Brier variant sizes ∝ |p − q|, log variant ∝ |logit(p) − logit(q)| — with
positive expected profit whenever the forecast p outperforms the price q under
the rule and the book is liquid enough. Every entry card now carries an
ADVISORY `properBet` block (both rules: side, contracts, stake vs. a
`KALSHI_PROPER_BET_BANKROLL` advisory bankroll, scoring-rule edge S(p) vs S(q)),
computed from the proven resolved-ledger win rate only — honest zero stake when
there is no edge, inside the bid-ask deadband, or the ledger is unproven.
No conviction floors, order logic, or execution paths changed; live trading
stays behind the existing dry-run/kill-switch gates. Offline unit tests:
`tests/test_kalshi_proper_bet.js`.
