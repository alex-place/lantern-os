Keystone Trader: the existing news feed now feeds the decisive deck. A new
`lib/news-signal.js` joins `data/lantern-garage/trading/news.jsonl` onto each Kalshi
market card (issuer-map for company-KPI markets + title token match; weather markets
get no join by design), attaching a `.news` signal and a small recency-weighted
conviction nudge. The terminal renders a `📰 ticker · impact · headlines` badge under
the Σ₀ line. Deterministic, local, no LLM — the semantic-embedding upgrade (Verso
parity) is tracked separately. (Observe→Reason)
