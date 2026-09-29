### Changed

- Refusals now read in plain English. The engine writes skip reasons for machines — regime_filter: not trend-aligned (need price>SMA50 & MACD hist>0) — which is precise and unreadable, so the page translates the ones it knows and keeps the exact rule on hover. An unrecognised reason is still shown verbatim rather than swallowed, because publishing the refusal is the point. The filter itself is untouched: it is the gate that flipped the backtested book from negative to positive expectancy.
