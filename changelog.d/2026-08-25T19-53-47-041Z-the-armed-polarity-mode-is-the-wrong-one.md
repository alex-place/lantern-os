### Changed

- **Nothing armed — a finding, and a correction to `#3456`.** That lab modelled the
  polarity rule as "the underlying sits at its session top" (`TRADER_SHORT_EDGE=1`).
  The boxes run `TRADER_SHORT_EDGE=selective`, which never evaluates the underlying's
  IBS at all — `#3349` asks two different questions (has the wrapper already
  collapsed, is the underlying ripping). So `#3456`'s headline described a rule that
  is not running.
- `experiments/polarity_mode_lab.js` runs all four modes over one universe and the
  same windows. `top` beats longs-only on **every** window (h1 ÷6.96 vs ÷5.52,
  h2 ÷13.92 vs ÷11.09, daily holdout ÷6,855 vs ÷405) and in **7 of 8 holdout years**,
  never worse. The armed `selective` rule is **worse than longs-only on return/DD in
  both hourly halves** (÷2.28/÷5.51 vs ÷4.03/÷7.31): it admits inverses at
  0.042%/trade where `top` admits them at 0.155%.
- On the down-day question that started this: longs-only −0.085%/trade,
  `selective` +0.093%, `top` +0.208%.
