### Added

- **`TRADER_ENTRY_CONFIRM`** — require N rising closes on the momentum timeframe before
  an entry (1 = one up bar; 2 = two rising closes **and no new low under the turn bar**).
  **Default off.** Session-scoped in ET — yesterday's closes cannot confirm today's
  washout — and an unreadable window *refuses* rather than waves through. Every refusal
  journals `entry_confirm` with the closes it judged.

  Judged at engine fidelity by the replay harness, 60 sessions, in its new
  overnight-faithful mode (positions carry weekdays, engine's own `TRADER_EOD_FLAT=weekend`
  runs — matching #3453):

  | variant | return | trades | WR | payoff |
  |---|---|---|---|---|
  | armed today | −0.21% | 119 | 47% | 1.03 |
  | + T1 | −1.03% | 107 | 50% | 0.79 |
  | **+ T2** | **+0.45%** | 94 | **55%** | 1.02 |
  | T2, persistence off | +0.48% | 95 | 55% | 1.05 |

  Expectancy −0.13 → **+0.28%/trade**. T1 is *worse than nothing* — the no-new-low clause
  is where the edge lives. T2 with persistence off is identical to T2 with it, so T2
  subsumes the 2-scan persistence rule (left armed; removing it is its own decision).

- **The replay harness now holds overnight.** The daily force-flatten was the same
  same-day-close bias that retired the knife veto, it suppressed every variant's win rate
  (~46% vs the live 58–70%), and it did **not** bias variants equally — confirmation
  entries land later in the session, so the flatten cut them short more often. Friday
  flattening now belongs to the engine's own weekend logic; end-of-data positions are
  marked and tagged.
