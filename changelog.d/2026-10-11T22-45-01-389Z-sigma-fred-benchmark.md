### Fixed

- sigma: the Fed-funds benchmark behind the Sigma book's financing estimate is fetched again. FRED never answers a request with no User-Agent, so every plan() waited out an 8-second timeout and then used a hard-coded 4.5% (the rate was 3.88% on 2026-10-11). The request now names itself and asks for a month of rows instead of every day since 1954: it answers in under 200 ms. Reporting only — the rebalance orders are computed before this figure.
