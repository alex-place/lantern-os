### FLB backtest rebuilt on a reproducible chain (#2954): signature replicates, sign flip explained

Regenerated the missing source data via a committed collector (1,228 single-event settled markets,
1.22M trades, 12 series) and rebuilt the analysis with all six corrections (decision-point
conditioning, event clustering, maker-seller accounting, parlay exclusion, adverse-selection
measurement, Wilson CIs + degeneracy flags). The FLB signature replicates out-of-sample — longshot
buyers lose (1-5c: -1.13c, t=-3.84), favourite buyers win — and the old whole-life method's
wrong-sign +5.56c low bucket is explained as selection-on-ever-touching. Adverse selection runs in
the seller's favour (taker-buys-yes: maker +1.77c, actual 4.1% vs implied 6.2%), reconciling with
the earlier maker refutation (different trade, different band). Generality remains UNPROVEN:
10/12 series are weather, ~203 effective events, 2 series negative, fills unsimulated.
