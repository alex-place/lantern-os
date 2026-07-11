# ForecastEx read-only probe — findings (#2216)

> **ADDENDUM 2026-07-10** — the follow-up
> [2026-07-10-forecastex-uhlga-settlement-and-klga-fit.md](2026-07-10-forecastex-uhlga-settlement-and-klga-fit.md)
> confirms the LGA station call from primary sources (CFTC U-contract terms + the venue's
> own product list) and adds two facts this probe couldn't see: (1) the U-series settles on
> **Weather Underground** (≡ round(max METAR tmpf), measured 14/14) — **not** the NWS CLI;
> (2) the full board incl. settlements is **public** at `forecastex.com/api/download`, so
> the Observe leg does not need the EC entitlement (orders still do). The KLGA re-fit this
> note called for is done and committed (`weather-oracle-params-klga.json`, 30% OOS gain,
> no measurable ≥100 ceiling).

**Date:** 2026-07-08 · **Account:** DUR193395 (IBKR paper) · **Method:** live read-only
CPAPI calls via `experiments/forecastex_probe.js` (OAuth1, `local-owner` creds). No order
code was run.

## TL;DR

ForecastEx **is** reachable from this account via `/iserver/secdef/search`, and it lists NYC
+ Chicago/Denver/Miami temperature contracts and CPI/Unemployment/GDP/Fed-Funds econ
contracts. **But the headline premise of the port is wrong: ForecastEx NYC daily-high
settles on LaGuardia (symbol `UHLGA`), not Central Park / KNYC.** Kalshi `KXHIGHNY` settles
on Central Park. They are *different* underlyings, so the "same contract, cheaper fee" and
"identical-settlement arb" framings do not hold as written.

## The four gating questions

**1. Are ForecastEx contracts listed via secdef/search, and what shape?** — YES.
- Only surface with `name: true` (search by economic NAME, not ticker — the old
  KNYC/HIGHNY guesses returned stocks). Matches carry exchange **FORECASTX**.
- Underlying = **secType `IND`**, `type: "Event"`, `hasOptions: true`, price increment
  **0.01 (1¢ tick)**. The tradeable buckets are **secType `EC`** (Event Contract).
- NYC daily high: symbol **`UHLGA`**, conid **853400786**, "New York City Daily
  Temperature High". 52 FORECASTX underlyings resolved across the searched names.

**2. Fill depth at the ~1¢ spread?** — **NOT RETRIEVABLE FROM THIS ACCOUNT — entitlement gap
(RESOLVED 2026-07-08).** The blocker is NOT the EC month parameter. Diagnosis:
- `/iserver/secdef/info?conid=…&secType=EC&month=…` returns a **persistent HTTP 503** (3/3
  retries, every month format) — the earlier "status 0" was just the 6 s client timeout
  truncating the 503.
- `/iserver/contract/853400786/info-and-rules` → **`has_related_contracts: false`**.
- `/iserver/marketdata/snapshot` on the underlying returns **no** bid/ask/last fields.
- `/portfolio/accounts` → **`tradingType: "STKNOPT"`** (DEMO, IB-CAN): this account is
  entitled to **Stocks + Options only**, not ForecastEx event contracts.

Together these are conclusive: **DUR193395 lacks ForecastEx (EC) entitlement**, so IBKR won't
serve the EC contract ladder or its market data from this session — no month string fixes
that. The 1¢ tick is confirmed (from the underlying `trsrv/secdef` increment rule); per-bucket
depth needs a **ForecastEx-permissioned account**. Note ForecastEx is a US CFTC-regulated
venue; an IB-CAN demo may not be eligible — an eligible US-entity account with the ForecastEx
permission enabled is the prerequisite to enumerate the ladder + depth.

**3. Does the account carry ForecastEx / EC trading permission?** — **NO (confirmed
2026-07-08).** `/portfolio/accounts` reports `tradingType: "STKNOPT"` (Stocks + Options only)
for DUR193395, and every EC contract-detail endpoint returns a persistent 503 with no market
data — search *visibility* of the contracts does not imply *trade/data* entitlement. A
ForecastEx-permissioned account is required before the port can proceed.

**4. Do the strikes line up with the oracle's bucket ladder?** — **CANNOT CONFIRM** (blocked
by #2, no EC ladder retrieved) — and **moot until the settlement-station issue is resolved**,
because a KLGA ladder is not what the KNYC-calibrated oracle expects.

## The decisive finding: settlement station mismatch

The symbols encode the settlement station: Chicago `UHMDW` (Midway), Miami `UHMIA`, and NYC
`UHLGA` — **LaGuardia**. NYC has *only* `UHLGA`/`ULLGA` (high/low); there is **no Central
Park / KNYC** ForecastEx series. Kalshi `KXHIGHNY` settles on **Central Park (KNYC)**.

Consequences for the epic:
- **#2221 (cross-venue arb) premise fails.** Kalshi (KNYC) and ForecastEx (KLGA) settle on
  *different* stations — LGA typically runs warmer than Central Park by a systematic 1–3°F.
  A position spanning them is **not** market-neutral; it carries KLGA↔KNYC basis risk. The
  monitor code stands, but "identical KNYC settlement" must be struck; reframe as a
  *basis* monitor, not an arb.
- **#2217 (port) needs a re-fit, not a fee swap.** The oracle's fitted params (coolBias
  −1.43, σ) are calibrated to **KNYC** (`kalshi-mos.js` station=KNYC). Trading them on a
  KLGA-settled contract is a train/serve station skew. ForecastEx NYC is a *new* market that
  needs its own KLGA fit (its own MOS station + settlement pairs) before any edge is claimed.
- **#2220 (multi-city) is corroborated and needs station codes.** Chicago/Denver/Miami all
  list — but as airport-settled series (MDW/…); the city registry's `station` must match the
  ForecastEx settlement, per venue.

## Net

The probe did its job: it de-risked the port *before* any order code by surfacing that
ForecastEx NYC ≠ Kalshi NYC. Recommended next steps, in order: (a) read the ForecastEx
contract spec to confirm KLGA settlement in writing; (b) resolve the EC month param to get
the ladder + depth; (c) confirm EC trading permission; (d) only then decide whether to fit a
separate KLGA oracle. The 1¢ rail is real and attractive — but on a different underlying than
we thought.
