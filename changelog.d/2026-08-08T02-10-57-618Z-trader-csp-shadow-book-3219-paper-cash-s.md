### Changed

- trader: CSP shadow book (#3219) — paper cash-secured put recorded per live IBS entry (nearest weekly at washout strike, quoted bid), resolved at expiry vs the underlying; paired journal csp-shadow.jsonl; observer only, TRADER_CSP_SHADOW=0 kills
