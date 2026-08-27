### Added

- **`TRADER_P_MIN`** — the hit-rate floor in `convergence-ev.js` is readable from the
  environment instead of hardcoded. **Default unchanged at 0.45; this arms nothing.**

  `P_MIN` gates every entry (`decision = has_evidence && ev_r >= EV_MIN && p_win >= P_MIN`),
  so the single number deciding what the engine may buy could not be A/B'd without editing
  source. 84 live entries joined to their exits (both boxes, from 2026-08-10) say the band
  that floor admits is the losing one:

  | p_win band | n | WR | avg |
  |---|---|---|---|
  | **0.00–0.50** | 23 | **39%** | **−0.341%** |
  | 0.50–0.55 | 16 | 63% | +0.594% |
  | 0.55–0.60 | 20 | 85% | +0.639% |
  | 0.60–0.70 | 22 | 77% | +0.064% |

  Cutting below 0.50 keeps 61 of 84 trades and takes total return +14.38% → **+22.22%**
  with win rate 65% → 75%. It decays cleanly above that (0.52 → +14.20%, 0.55 → +12.72%,
  0.60 → −0.06%), so 0.50 is the edge of a bad band rather than a fitted peak.

  Garbage or out-of-range values fall back to 0.45 — a floor that silently became `NaN`
  would compare false against every `p_win`.

### Why a knob and not a new default

- n=84, one regime, and the entry→exit join is naive where a symbol was re-entered.
- **It cannot be settled by backtest.** The replay harness feeds a constant `p_win`, and
  reconstructing the real one from bars would neutralise **41%** of the model's weight —
  `grok` 0.09, `claude` 0.09, `news` 0.10, `earnings` 0.11, `sector` 0.08 of 1.16 total are
  not recoverable from price alone. Testing a threshold against a scorer 41% different
  from the live one is the mistake that produced four wrong findings this session.

  So the honest test is live and side by side, which is what the knob is for.
