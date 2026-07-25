### Added

- docs/adr: **ADR-0033 — the Apex trader** (design only). The operator-requested
  "maximize profitability at the highest **acceptable** risk" trader, designed from this
  session's measured results. Core argument: for an overnight book the binding risk is
  the **un-stoppable overnight gap**, not variance — Gaussian/Kelly sizing (~47×) is
  rejected and acceptability is defined by a stress bound (a −6% gap must cost ≤ ~20%
  equity ⇒ **hard 3× leverage cap**; the measured 5× ladder rung is explicitly rejected).
  Composition: SPY overnight vol-gated 3× core (measured Sharpe 2.77 / CAGR 11.3% at 3×)
  + QQQ calm-night complement (regimes fire on different nights) + T-bill carry on idle
  equity + a **measurement-gated** convex OTM-options sleeve (arms only on the
  options-shadow ledger's positive verdict). Brake-scaled leverage, consecutive-loss and
  monthly circuit breakers, kill-file honored; 3× ETFs / single stocks / the unproven
  intraday day-trader excluded (dominated or no edge). Paper-first; real money remains
  behind ADR-0028 + ADR-0032. Indexed in `docs/adr/README.md`.
