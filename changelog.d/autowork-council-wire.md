### Wire the Σ₀ council into the autowork pipeline — Δ accrues on real decisions

Each successful self-coding run now scores its plan with `councilReview()` and tags the council
record with `{surface:"autowork", issue, pr}` via `opts.context` — the join key
`experiments/council_outcome_backtest.py` needs to compute "Δ predicts reverts". The record already
carries `delta` + an `outcome` slot the backtest labeller fills.

`execVerdict` is passed **only on a real test pass**, so an inconclusive (timeout) test falls through
to the text Δ rather than forcing a `refuted` verdict. The call is best-effort (try/catch) — a
scoring error never breaks the pipeline. The response and the `autowork-runs` step log now carry
`councilDelta` / `councilVerdict`.

This closes the instrumentation gap the backtest reported: council Δ now lands on revertable
decisions (autowork patches → PRs), not just chat replies. Verified at the mechanism level — a
`councilReview(..., {context:{surface:"autowork", issue, pr}})` call writes a record tagged with
exactly those fields; the predictive precision/recall lands once a few runs accrue and their PRs
resolve (merged / reverted).
