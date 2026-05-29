# Polymarket Agents RAGDoll Convergence — 2026-05-29

## Boundary

This is a research-only convergence seed for Lantern OS / RAGDoll skills. It is not an autonomous trading instruction, not financial advice, and not a recommendation to gamble.

The uploaded Polymarket Agents reference states that the upstream `Polymarket/agents` repository was archived on 2026-05-11 and is now read-only. It also states that its Terms of Service prohibit U.S. persons and people in certain jurisdictions from trading on Polymarket through the UI, API, or agents developed by restricted persons. Treat this as a hard safety/compliance boundary.

## What can be reused safely

The useful parts are architectural, not executable betting behavior:

- market metadata scanning
- resolution-rule reading
- evidence collection
- local/remote RAG patterns
- probability brief generation
- bull/bear/contrarian review
- risk and hallucination auditing
- human approval gates

The upstream README describes a Python 3.9 framework with Polymarket API integration, local/remote RAG support, market/event metadata parsing, data sourcing, and CLI tooling. It also mentions autonomous trade execution, but Lantern OS should not promote or run autonomous trading.

## RAGDoll skill shape

Use this as a RAGDoll research skill, not a money-now autopilot.

```text
Market Scanner
  -> pulls public market metadata only
Resolution Agent
  -> reads exact settlement criteria
News / Evidence Agent
  -> gathers public sources only
Bull Agent
  -> argues why YES is underpriced
Bear Agent
  -> argues why NO is underpriced
Contrarian Agent
  -> attacks consensus and source duplication
Risk Agent
  -> blocks trades that rely on private info, unclear rules, thin liquidity, or restricted-jurisdiction risk
Human Operator
  -> final approval or no action
```

## Hard rules

1. Do not trade autonomously.
2. Do not trade from restricted jurisdictions.
3. Do not use private, leaked, employer, confidential, classified, medical, military, or insider information.
4. Do not treat common odds as edge.
5. Do not use this as the $200-now plan.
6. Prefer service revenue: repo audit, MCP audit, RAG cleanup, dashboard packaging, or Orion watch report packaging.

## Most common market-chance table for research triage

| Market family | Common chance zone | RAGDoll use | Risk note |
|---|---:|---|---|
| Sports favorites | 55-75% | liquidity and mechanics learning | low edge without domain model |
| Sports coin flips | 45-55% | spread calibration practice | fees/slippage can dominate |
| Politics / elections | 35-65% | resolution-rule study | emotional and jurisdictional risk |
| Crypto price targets | 20-80% | public-event monitoring | volatility can erase apparent edge |
| Fed / CPI / rates | 30-70% | public-calendar event briefs | late entry after news is usually stale |
| Awards / pop culture | 5-40% | long-shot calibration only | fandom is not probability |
| Geopolitics / war | 1-35% | normally skip | high ethical and info-risk |
| Viral/news markets | 5-60% | watchlist only until rules are clear | ambiguous resolution risk |
| Same-day binary events | 10-90% | source verification drill | rumor-risk and fast settlement |

## $200-now convergence

Polymarket research is not the fastest or safest way to get $200. The converged money path remains:

1. Package a $199 fixed-scope MCP / RAG / GitHub repo audit.
2. Use the fleet to find prospects with broken agent/MCP/GitHub automation docs.
3. Generate short personalized audit offers.
4. Human reviews and sends.
5. Deliver a one-page findings report plus optional cleanup PR.

This uses existing Lantern OS, RAGDoll, MCP, GitHub, and orchestration skills without requiring gambling, hardware shipping, or patent timelines.

## Skill label

`ragdoll.skill.polymarket_research_fleet.v0`

Status: research-only seed.
Promotion gate: only promote if legal/compliance review confirms allowed use in the operator jurisdiction and the workflow remains human-approved, public-source-only, and non-autonomous.
