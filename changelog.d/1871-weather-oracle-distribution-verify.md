feat(kalshi): distribution-level Verify for the weather oracle (#1871)

kalshi-calibration.js (#1872) grades a single scalar — the held bucket's win-probability —
with Brier, and feeds back a global logit shift. Necessary but not sufficient: a scalar
Brier can't say whether the whole predictive DISTRIBUTION is calibrated, and a global shift
can't fix a forecast-CONDITIONAL error (fine on routine days, wrong in the ≥100°F tail).

New `lib/kalshi-weather-verify.js` scores the full distribution the oracle emits, over the
ordinal bucket ladder:
- **RPS** (Ranked Probability Score — discrete-CRPS analog): rewards mass NEAR the truth,
  reported against a climatological baseline as an RPS skill score (>0 beats know-nothing).
- **PIT** (Probability Integral Transform) + reduced-χ² uniformity: catches over-confidence
  (U-shaped), under-confidence (humped), and bias (leaning).
- **Reliability curve + ECE** on the held-bucket probability — the calibration curve the
  scalar Brier summarizes but never exposes.

Pure + deterministic + no network (same contract as kalshi-weather-edge.js); reads only the
paper ledger; degrades to an honest no-op under 20 settled distributions. The deck now stamps
the full predictive `dist` + `ladder` + `heldBucket` on each open row so settled positions
become gradeable at the distribution level, not just the scalar.

Verify: 13-case suite (`test/kalshi-weather-verify.test.js`) — point-mass RPS=0, nearness
ordering, PIT monotonicity/uniformity, ECE on calibrated pairs, sharp-correct forecast beats
climatology, over-confident-wrong loses and trips the PIT flag, honest under-sample no-op.
All pass; weather-edge + fees/EV self-tests still green.

Strengthens the **Verify** stage. End-to-end grading of live positions still needs the
settled-high (observed bucket) stamped at close — scoped follow-on in #1871.
