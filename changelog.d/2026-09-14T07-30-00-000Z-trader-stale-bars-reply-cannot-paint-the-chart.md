### Fixed

- trader: **a late reply for an interval you already left no longer paints the chart.** Switch from D to 1m quickly and the daily reply could land after the 1-minute one, leaving daily candles under a "1m" label (2 of 3 tries in QA). A reply now belongs to the interval it was asked for; if the interval changed while it was in flight it is dropped.
