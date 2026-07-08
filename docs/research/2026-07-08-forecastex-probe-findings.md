# ForecastEx read-only probe — findings (#2216)

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

**2. Fill depth at the ~1¢ spread?** — **NOT MEASURED.** The `IND` underlying carries no
order book (snapshot returns symbol only, no bid/ask). The `EC` bucket ladder could not be
enumerated: `/iserver/secdef/info?conid=…&secType=EC&month=…` returned empty/timeout for
every month format tried (`JUL26`, `AUG26`, …), and `/secdef/strikes` (OPT) returned empty
`call/put` (these aren't options). **Open item:** find the correct EC month/maturity
parameter (daily contracts may only surface intraday near settlement), then snapshot a
bucket conid twice to warm the subscription. The 1¢ tick is confirmed; per-bucket depth is not.

**3. Does the account carry ForecastEx / EC trading permission?** — **UNCONFIRMED.** The
handshake authenticates and lists account DUR193395, and secdef/search returns the
contracts, but there is no explicit ForecastEx/event-contract permission flag in the
accounts/summary payload (search visibility ≠ trade permission). Confirm on IBKR's Trading
Permissions page before any order path.

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
