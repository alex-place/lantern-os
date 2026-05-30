# Kalshi Bayesian `$50` Paper Budget Brief - 2026-05-30

Status: paper-only operator brief. No live order, no authenticated Kalshi
request, no custody, no guaranteed profit, and no investment advice.

## What It Is Betting On

The current public-data queue is not only sports. It contains event contracts:

| Lane | Examples in current queue | Meaning |
|---|---|---|
| MLB totals/spreads | Kansas City vs Texas total runs; New York Yankees vs A's total runs; Atlanta by more than 1.5 runs | Yes/no event contracts tied to game outcomes. |
| Weather | Phoenix high temperature band; Denver low; Atlanta high | Yes/no event contracts tied to reported weather outcomes. |
| Music/chart | Top USA song on Spotify | Yes/no event contract tied to a chart result. |
| HFT research | Tennis match and other spread-aware rows | Paper-only maker/spread research, not live execution. |

## When We Know

Each ticket now stores `closeTime`, `daysToClose`, and `whenKnown`.

Close time is the earliest useful clock for review, not a guarantee that money
is final. Final truth depends on the market rules and settlement source. Before
any real account action, open the market rules page and confirm the settlement
source, close time, and appeal/finalization behavior.

## Bayesian World Model Math

Use the market price as a prior, then update only with evidence:

```text
p_market ~= yesMid or yesAsk after fee/spread adjustment
prior_odds = p_market / (1 - p_market)
posterior_odds = prior_odds * likelihood_ratio_evidence
logit(posterior) = logit(prior) + sum(weight_i * feature_i)
EV_yes_per_contract = p_posterior - price_yes_before_fees
kelly_fraction = max(0, (p_posterior - price_yes) / (1 - price_yes))
```

For sports, evidence can include team strength, starting pitchers/lineups,
injuries, weather, travel/rest, market movement, and historical distribution of
similar totals. For weather, evidence can include official forecasts, ensemble
spread, station history, and time-to-event. For music/chart events, evidence can
include public chart position, stream velocity, release timing, and platform
rules.

Current posterior status: `not_estimated`. The queue has data-quality scores,
not outcome probabilities.

## `$50` Paper Budget

With a `$50` bankroll assumption:

| Rule | Value |
|---|---:|
| Live spend now | `$0` |
| Paper daily max loss | `$5.00` |
| Paper max per market | `$1.00` |
| Contract count per paper ticket | `1` |
| Required before live | independent posterior probability, fees/slippage, orderbook depth, max-loss note, human approval |

This means Lantern can paper-test the current queue without pretending the full
`$50` should be deployed. The correct live answer remains `$0` until posterior
probabilities and approval exist.

## Current Decision

If the operator has `$50`, use it as a bankroll model, not as a spend command.

Allowed now:

- refresh public data;
- generate paper tickets;
- build posterior probability notes;
- compare paper results to settlement outcomes.

Blocked now:

- live orders from chat;
- automated sports/game betting;
- custody or key storage in RAG;
- staking all `$50`;
- claiming edge from market liquidity alone.

## Reader Link

```text
http://127.0.0.1:4177/view?path=manifests/evidence/kalshi-bayesian-50-dollar-brief-2026-05-30.md
```
