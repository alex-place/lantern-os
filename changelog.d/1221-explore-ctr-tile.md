feat(metrics): Explore-feed CTR tile + trader "Explore" nav (#1221, #1581)

The metrics dashboard now surfaces the Explore feed's Converge-stage signal:
a live "Explore feed CTR" tile reads `/api/explore/metrics` and shows
engagements ÷ impressions, exploration share, dismiss rate, and unique-card
coverage over the last 7 days. CTR gets a neutral accent (not the 75%-green
pass bar) since single/low-double-digit CTR is healthy for a content feed.

Trader pages now link to "Explore" (preset to the finance topic) instead of
the retired "News" button, unifying discovery on the single PCSF-ranked feed.
