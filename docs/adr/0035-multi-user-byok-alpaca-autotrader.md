---
adr: 0035
title: Multi-user BYOK Alpaca autotrader — per-account tenancy, per-user settings inside platform limits
status: Proposed
date: 2026-09-30
deciders: Alex Place (pending)
approved-by: pending   # only Alex Place flips this; agents leave it `pending`
supersedes: none
superseded-by: none
---

<!--
  APPROVAL GATE: leave status `Proposed` and approved-by `pending`. An ADR is not
  binding until Alex Place explicitly approves it; only then set status `Accepted`
  and approved-by `Alex Place (YYYY-MM-DD)`. Never self-approve.
-->

# ADR-0035: Multi-user BYOK Alpaca autotrader — per-account tenancy, per-user settings inside platform limits

## Status

Proposed

**Loop stage:** Act (contained execution per account) + Verify (per-account guard, journal and audit).
**Relates to:** ADR-0027 (per-user Alpaca connect, Accepted), ADR-0032 (live-money onboarding, Proposed), ADR-0018 (hosted multi-tenant web tier, Accepted), ADR-0020 (live order gating, Proposed).

## Context

**The goal (operator, 2026-09-30):** the autotrader is a multi-user system. Each user is a
bring-your-own-key (BYOK) consumer of **their own** Alpaca account. The engine trades each
account on that user's behalf, with that user's settings, isolated from every other user.

**What exists today.** The skeleton is multi-user; the engine is not:

- **Per-user connect and choice.** A user connects their own Alpaca account, either by pasting
  keys (paper only) or with ADR-0027's OAuth once Alpaca activates the app. Keys are stored
  encrypted per user. The user then picks a mode (`off`, `stock` day-trader, `champion`), an
  account mode (demo/paper), a broker preference, and a tradelist and watchlist.
  `docs/TRADER-GUIDE.md` documents that journey.
- **One loop drives every connected account.** Each tick it walks every user with stored
  credentials, skips anyone below the Pilot tier or in mode `off`, takes a per-account lock,
  and runs the same engine on each.
- **Everything else is one global configuration.** The engine path reads **128 settings from
  environment variables; 19 are documented anywhere** (`.env.example` and the trading docs).
  All of them apply to every user: sizing, stops, caps, entry and exit rules, extended hours,
  and arming. A user's `stock` mode trades only if `TRADER_AUTO_EXECUTE=1` is set for the
  whole server.
- **Engine memory is keyed by ticker, not by account.** Cooldowns, trailing peaks, exit
  debounce, the stop registry and deferred exits live in module-level maps keyed by symbol.
  So two users trading the same ETF share, and overwrite, each other's position state.
- **Per-user state lives beside the code, not under the state root.** On the hosted
  deployment the persistent volume is the state root. Credentials, modes, broker preference,
  tradelists, engine state and the trade journal are written under the application folder
  instead, so they are replaced on every deploy.

**Why now.** Paying Pilot users can connect today, and the design goal is many of them. Every
gap above is invisible with one account and becomes a correctness, isolation or support
problem with the second.

## Decision

We will make the **broker account** the tenancy unit of the autotrader and give each user a
configuration they own, bounded by limits the operator owns.

1. **Tenancy unit = (user, broker account).**
   - Every piece of engine state is keyed by account and symbol, never symbol alone. That covers
     cooldowns, peaks and troughs, the exit debounce, the stop registry, deferred exits,
     breakers, the persistence counters and the ledger cursor.
   - Each account's state lives under the state root at `trading/users/<userId>/`, with its own
     engine state file and its own append-only journal. The shared journal becomes a derived
     view.
   - One account's pass can read or change only that account's state.
2. **BYOK Alpaca is the multi-user broker.**
   - A user's autopilot trades only the Alpaca account that user connected, with that user's
     own key or OAuth token. It never uses server or operator keys, and never falls back to
     another broker, account or practice ledger.
   - If the pinned account can't be read, that user's pass stands down. A failed read is
     "unknown", never "empty".
   - Credentials are encrypted at rest under a **dedicated** key (not the session secret) and
     stored under the state root.
   - IBKR stays an operator and power-user connection (ADR-0022). It is not part of the
     multi-user autopilot in this decision.
3. **Two-level configuration from one schema.**
   - A single module declares every setting: name, type, default, bounds, scope, and a one-line
     description.
   - **Scope `platform`** (operator only, via env or admin settings): engine on/off, platform
     kill switch, maximum risk per trade, maximum position % of equity, maximum concurrent
     positions, maximum gross exposure, the allowed symbol universe, whether extended hours
     may be enabled, and the leverage and inverse-ETF policy.
   - **Scope `user`** (each user, on their settings page): strategy, arm on/off, risk per trade,
     position size %, stop %, maximum positions, symbols chosen from the allowed universe,
     and the extended-hours opt-in. Each value is validated against the platform bound. A user
     can make their own risk smaller than the platform limit, never larger.
   - **Scope `internal`**: engine constants that are not settings. They leave the env surface.
   - The same schema generates the configuration reference (`docs/TRADER-CONFIG.md`), so the
     docs can't drift from the code.
4. **Arming is per user.**
   - An account trades only when all four hold: the platform engine switch is on, the user has
     the Pilot capability, the user has armed their own account, and their settings validate.
   - The Pilot check fails closed.
   - The existing global switches become the platform engine switch.
5. **The guard applies to every order, paper included.**
   - It uses the tighter of the user's and the platform's limits.
   - Kill switches exist at two levels: the platform (all accounts) and the user (their own
     account).
   - A halt stops new entries and never cancels a protective stop.
6. **One scheduler, isolated passes.**
   - The scan loop and the fast-exit loop share one per-account lock.
   - Users are processed with bounded concurrency.
   - An error in one user's pass is contained and logged against that user.
7. **Per-user observability.**
   - Journal, P&L, scorecard and health are per account, and each user sees only their own.
   - Any public or demo surface shows only the operator's demo account.
8. **Live money is out of scope here.** Paper first; ADR-0032 governs when a user's own live
   account may be traded, and this decision does not change it.

## Consequences

- **Positive:**
  - Users can't interfere with each other.
  - Each user controls their own risk inside a platform envelope the operator sets.
  - Connections and engine memory survive deploys.
  - The configuration is documented, and the docs are generated from the same schema the
    code validates against.
  - Support questions ("why didn't my account trade?") get an answer from that user's own
    journal.
- **Negative / trade-offs:**
  - **A migration.** State moves under the state root, and existing single-account state is
    re-keyed to its account.
  - **A one-time reconnect on the hosted deployment**, unless the live files are copied onto
    the volume before the first deploy that reads the new paths.
  - **A bigger test matrix:** settings multiply the paths the guard must cover.
  - **Scan time grows with the number of users.** Bounded concurrency is needed, and each
    user's Alpaca rate limit is their own.
  - **Some of the 128 settings will be demoted** to constants or deleted, which changes local
    tuning habits.
- **Follow-ups:**
  1. **Safety prerequisites:**
     - move the trading stores under the state root, with the one-time migration;
     - a halt never cancels a stop;
     - a deferred exit really waits;
     - a failed read is "unknown", not "empty";
     - one lock across the scan and fast-exit loops.
  2. **Tenancy:** account-keyed engine state and per-account state files and journal; broker
     pinning with no fallback; the guard on paper orders; a dedicated credential key.
  3. **Settings:** the schema module with validation, per-user arming, the settings page and
     the generated `TRADER-CONFIG.md`.
  4. **Observability:** a per-account journal, P&L and scorecard, an operator runbook, and the
     demo-only public feed.

## Alternatives considered

- **One container per user.**
  - Strongest isolation, but it multiplies hosting cost and deploy complexity.
  - The shared engine with account-keyed state gets the needed isolation inside one service.
  - Revisit if tenants need different code versions.
- **Keep one global configuration and add per-user overrides ad hoc.**
  - That is how the 128 undocumented settings came about.
  - Without a schema, bounds and generated docs, per-user overrides would repeat the drift.
- **Users self-host.** This contradicts the hosted product and the Pilot tier.
- **A multi-broker aggregator (for example SnapTrade).** Deferred by ADR-0027: it adds
  per-account vendor cost and doesn't trade every broker. BYOK Alpaca covers the goal directly.
- **Do nothing.**
  - It works for one account.
  - With two or more armed accounts, users overwrite each other's position state, and every
    deploy disconnects everyone.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| The loop trades every user with stored credentials | `apps/lantern-garage/routes/trading.js:164-166` (`TRADER_AUTO_USER` or `ibkrCreds.listUsers()` + `alpacaCreds.listUsers()`) | high | code read, master@49695e76 |
| Pilot tier gate, fails open on a profile-store error | `routes/trading.js:183-190` (`roleHasCapability(role, 'ai_trader')`; the `catch` falls through) | high | code read |
| Per-user mode exists; arming is a global switch | `routes/trading.js:207-213` (`traderMode.get(uid)`; `_canAct` reads `TRADER_AUTO_EXECUTE` / `SIGMA_ARM`); `lib/trader-mode.js:36` (`off`, `stock`, `champion`) | high | code read |
| Engine position state is keyed by symbol | `apps/lantern-garage/lib/auto-trader.js:483-536` (`_lastOrderAt`, `_entryAt`, `_peak`, `_exitAt`, … as `sym → …` maps) | high | code read |
| Per-user stores default beside the code | `lib/alpaca-credentials.js:26-28`, `lib/trader-mode.js:28-30`, `lib/trading-account-mode.js:40-42`, `lib/broker-preference.js:23-25`, `lib/auto-trader.js:14-16` | high | code read |
| The hosted volume is the state root | `.railwayignore:28-30` (volume at `/app/state`, `UNISONA_STATE_DIR=/app/state`); `lib/app-paths.js:62` | high | code read |
| BYOK connect is paper-only today | `routes/broker-alpaca.js:283-293` (`live_not_supported`) | high | code read |
| 128 engine settings, 19 documented | `process.env.*` reads across `auto-trader.js`, `trading-guard.js`, `alpaca-adapter.js`, `broker-facade.js`, `trading-api-bridge.js`, `routes/trading.js`, `overnight-trader.js`, `signal-engine/*`, `two-sleeve/*`, matched against `.env.example`, `TRADER-GUIDE.md`, `trading-api-reference.md`, `two-sleeve-engine.md` | medium (counting method) | grep, 2026-09-30 |
| The user journey is documented | `docs/TRADER-GUIDE.md` (connect → choose → run → stop → troubleshoot) | high | doc read |
