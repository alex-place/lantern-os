### Fixed

- trader-ui: a torn bar-cache read now retries (up to 3 reads, 120ms apart) before surrendering to the quote-derived reference — live at 04:57 the guard correctly refused a mid-rewrite read of GLD but the fallback quote was itself pre-roll-stale, reproducing the wrong figure by another road. Rewrites finish in milliseconds; the retry heals it. A missing cache file is a settled "no" and never retried
