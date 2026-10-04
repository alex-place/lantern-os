### Changed

- trading: the entry re-quote shadow (TRADER_ENTRY_REQUOTE=shadow, journal-only) — a fresh print fetched beside every market buy, journaling the decision quote's age and drift, what a re-quote guard would have refused and whether a marketable limit at quote + cap would have filled; experiments/entry_requote_score.js scores it; market-data getQuotes gains a cache-bypassing fresh option
