refactor(trading): split 2725-line routes/trading.js into a dispatcher + 9 endpoint modules (#2316)

Behavior-preserving decomposition so agents load focused files instead of a
2.7k-line monolith. All stateful/side-effecting module-level code (imports,
the `traderAgent`/`_priceFeed` singletons, the autoscan loop + timers, proxy
consts) stays in `trading.js` untouched; the exported `tradingRoutes` builds a
`ctx` object and delegates to `routes/trading/{market,orders,watchlist,
dashboard,ibkr,kalshi,ai-trader,news,misc}.js`. Endpoint branch bodies moved
verbatim. The one branch that mutates module-level `_scanWhenClosed`
(overnight-scan) stays inline. trading.js 2725 -> 281 lines.

Verified: `node --check` on all 10 files; route-literal invariant identical
(107 pathname matchers, empty diff vs pre-split baseline); every lib require
resolves at the new depth; ctx carries all 23 module-level bindings the moved
branches use. Full live-endpoint runtime verification needs the trading stack
(Python subprocess + broker keys) not available in CI. Improves Reason/Act.
