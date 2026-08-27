### Added

- **Four labs kept as the record of REJECTED findings**, each carrying its own limits in
  the header so the next person does not re-derive them:
  - `loss_cut_lab.js` — cutting losers early. Rejected on the daily/hourly holdout and
    again at 1-minute. MAE explains it: on 60 sessions winners dig −0.44% median against
    losers' −3.11%, so the existing −3% stop already sits on the boundary and 24% of
    winners dip past −1%.
  - `recycle_1m_lab.js` — 1-minute surface for changes the daily lab cannot represent
    (same-session re-entry, 85-minute scratch exits). Also the cautionary tale: T3 showed
    payoff 7.84 on **seven trades** here.
  - `reversal_60d_lab.js` — the same rules on 60 sessions, where T3 collapsed to +0.57%.
    Reversal confirmation halves winner MAE (−0.44% → −0.22%) and earns the same return on
    a quarter of the drawdown; that part still stands at reconstruction confidence.
  - `turn_consolidation_lab.js` — **SUPERSEDED.** Concluded persistence + falling_knife
    were destructive together; `replay_auto_trader.js` reversed every row. Header says so;
    do not quote its rankings.
