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

**Cross-family pass (same day):** extended beyond weather (10,190-series universe discovered,
candidates probed for settled depth). Adding MLB produced an apparent sports edge (+6.78c, t=21.5)
that was traced to a COLLECTION ARTIFACT: 88% of MLB markets hit the per-market trade cap,
capturing a median 1.6h of 75h markets (end-of-game only). Added C8 truncation guard (exclude
capped markets; collector now paginates 40x deeper and records completeness) and C9 minimum-n
generality gate (>=30 events/family, after the first verdict read "cross-family" off a 3-event
family). Corrected verdict: PARTIAL — holds in weather (200 events, t=3.09) and sports (60 events,
selection-caveated); macro underpowered.

**Fill simulation (final):** built free-data 1-minute bid/ask history (Kalshi candlesticks; the
public API serves no historical depth, so this is the OSS path commercial vendors sell) and
required a real buyer at our price before booking a fill. Result: DOES NOT SURVIVE — only the
latest decision point is positive, its t is degenerate (0 winners of 29 fills), ~50% of offers
never fill, and filled offers wait 1-2.5h. Same "latest-point-only" fragility that disqualified
buy-favourites. Simulated fills ignore queue priority/partial fills/impact, so this is an UPPER
bound on a result that already fails.

**Favourite side (literature-directed):** the academic synthesis identifies buying favourites — a
TAKER trade with structurally certain fills — as the retail-accessible expression of longshot bias.
Tested on real asks in liquid minutes: 75-95c nets +1.6 to +2.6c/contract, t=0.5-1.4 on ~115
events. Directionally right, NOT significant; needs ~2x the events. First candidate to end
underpowered rather than refuted. Two sampling corrections were load-bearing: real ask vs traded
price (+0.60c gap), and liquid-minutes-only (all-minutes sampling produced spurious significant
negatives from stale asks).

**External grounding + structural argument:** confronted the strongest counter-argument (datagolf:
FLB is a mechanical artifact of flat bookmaker margins, hence unexploitable). It does not transfer
to Kalshi, an EXCHANGE whose fee 7*P*(1-P) is convex and minimised at the extremes — measured 0.43c
at 90-97c vs 1.74c mid-book (4x). Decomposition confirms: buying deep longshots -4.82c (t=-4.18),
buying deep favourites +3.01c (t=2.29), middle is noise. Self-applied caveat: 8 bands tested, so
t=2.29 does NOT clear the Harvey-Liu |t|>3 multiple-testing bar. Pattern is defensible; the single
cell is not.
