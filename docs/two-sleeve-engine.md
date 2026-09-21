# The two-sleeve engine

One trader, one engine, one account, built from the two ecologies that were measured to be a
team (issue #3656; ledger rows `sleeve-teamwork-levers`, `two-sleeve-engine-v2`).

## What it is

- **Sleeve S** — master's `lib/auto-trader.js` with the stable box's environment: intraday
  bias, T2 confirmation, inverse gate, morning gate, decarry, weekend-flat.
- **Sleeve R** — the race hybrid brain (branch `kriskin/week1-hybrid`, loaded by path) with the
  race box's environment: IBS 0.15, zone ladder, max-hold, carries kept, plus the two grafts
  measured 2026-09-18 (`TRADER_NO_FRIDAY_ENTRIES=1`, `TRADER_FRESHLOW_SIZE_MULT=1.5`).
- **One account.** The sleeves share equity under **symbol ownership**: whoever opens a name
  owns its exits; a buy on a name the other sleeve holds is refused and counted as a collision.
  Each sleeve's broker view shows only what it owns.
- **Order.** Sleeve S ticks first — it claims a shared washout at a small budget (2 slots at
  4%), and R takes the next name (4 slots at 8%). Race-first measured worse on every teamwork
  metric (correlation 0.62 vs 0.39, coverage 50% vs 75%).
- **No partition.** Both sleeves see their full live universe; instrument-class splits measured
  worse on every axis.

Measured on the faithful harness (60 sessions, live universes, mark-to-market daily scoring):
9.91% return, max drawdown 1.72%, win rate 72%, 93% positive weeks, worst week −0.02%, sleeve
correlation 0.39. Race alone at the same budget: 9.35% / 1.56% / 86% / −0.22%. In-sample, and the
grafts were selected on this window — the out-of-sample window is accumulating from the daily
5-minute bar collector.

## The parts

| file | role |
|---|---|
| `apps/lantern-garage/lib/two-sleeve/engine.js` | the core: per-sleeve env isolation, the ownership bridge, the tick in sleeve order |
| `apps/lantern-garage/lib/two-sleeve/ownership.js` | the persisted symbol → sleeve and order → sleeve registry; reconcile / adopt / release |
| `experiments/replay_two_sleeve.js` | the faithful replay, now driving the core with a mock account — the validation gate |
| `apps/lantern-garage/scripts/two-sleeve-runner.js` | the headless live runner: broker facade, scanner, account lock, tick loop, heartbeat |
| `apps/lantern-garage/scripts/two-sleeve.config.example.json` | the measured design as a config |
| `apps/lantern-garage/test/two-sleeve-engine.test.js` | the contracts: refusal, ownership order, per-sleeve views, env isolation, adopt/release, fail-soft |

## Env isolation

Each sleeve has an env map (the `TRADER_*` lines of its box's `.env.local`, overlaid with the
sleeve's own budget and grafts). Before a sleeve's tick every key named by *any* sleeve map is
deleted from `process.env` and the sleeve's own map applied, so a knob one sleeve sets and the
other omits is absent for the other (harness bug #6 was exactly that leak). After the tick loop
the baseline values come back. Both brains evaluate `cfg()` per call, so the swap is honoured on
every tick. Keys no sleeve names (`TRADER_AUTO_EXECUTE`, `TRADER_LIVE`, journal and state paths)
are process-level and untouched.

This is why the runner is **headless**: in a web server an HTTP handler could read the wrong
sleeve's knobs between awaits; in a process whose only work is the tick loop nothing else does.

## Ownership

Broker positions carry no owner tag, so the registry (`two-sleeve/ownership.json`) is the
source of truth and is written on every change. Each tick reconciles it with the broker: a
symbol whose position left the book is released; a held symbol nobody claimed (a manual buy, a
foreign engine, a lost file) is **adopted** by the default sleeve (S, whose exits are safer) and
journaled. Orders are tagged with the sleeve that placed them; an untagged resting order falls
back to its symbol's owner, then to the default sleeve.

## Running it

```bash
# validation: the engine core must reproduce the harness numbers (same 60 sessions)
REPLAY_VARIANTS=variants.json REPLAY_DUMP=out node experiments/replay_two_sleeve.js

# unit contracts
node apps/lantern-garage/test/two-sleeve-engine.test.js

# live, on a box: copy the example config, point envFile at the box env files, then
node apps/lantern-garage/scripts/two-sleeve-runner.js --dry --once   # boot + one tick, no orders
node apps/lantern-garage/scripts/two-sleeve-runner.js --dry          # a dry session: every order journaled and refused
node apps/lantern-garage/scripts/two-sleeve-runner.js                # armed

# after-hours smoke of a DRY runner with its clock pinned inside a session: workers boot in
# their own trees, both brains tick armed behind the dry wall, the journals fill
TWO_SLEEVE_FAKE_NOW=2026-09-21T18:12:00Z node apps/lantern-garage/scripts/two-sleeve-runner.js --dry --once
```

An armed runner takes the account lock as the **armed** holder. A web server on the same account
must run disarmed (`TRADER_AUTO_EXECUTE=0`, `TRADER_MANAGE_EXITS=0`): it keeps serving the
dashboard and never touches the lock. A `--dry` runner places nothing and therefore never
contends for the lock: it can shadow an armed server on the same account, or run alone on a
disarmed one, journaling every order it would have placed as `dry_order`.

**What a dry run is (2026-09-21).** The brains are armed in-process in every mode; dry-ness lives
in the facade, which forwards the five reads, refuses and journals the two writes, and exposes
nothing else (`lib/two-sleeve/runner-support.js`). The first dry session (Monday 2026-09-21,
race's account) had it the other way round: `--dry` exported `TRADER_AUTO_EXECUTE=0`, both brains
returned "nothing to do" before reading the account or journaling a skip, and 400 error-free
ticks produced not one brain row. The plumbing was proven (lock, facade, reconcile, the SQQQ
stop-out adopted at 09:05 and released at 09:34 after the real fill); the decisions were not.
A dry day is evidence only if `<id>.autopilot-trades.jsonl` fills with each brain's own skips
and every `tick` row in `engine.jsonl` carries per-sleeve `signals` / `enters` / `skipped` and
no `reason`.

**Scans are per sleeve.** Each sleeve's signals come from a forked scan worker
(`lib/two-sleeve/scan-worker.js`) that loads that sleeve's app tree under that sleeve's env file
and universe: the stable sleeve scans with this tree's signal engine at stable's thresholds
(IBS 0.30, P_MIN 0.50, `selective`), the race sleeve with race's own `scan.js` at race's
(IBS 0.15). Monday's single shared scan ran master's engine under race's env, so the stable sleeve
never saw the TLT washout (IBS 0.29) that stable's live brain bought at 14:12. `convergence-ev`'s
`P_MIN` is a module-load constant, which is why this takes a process per sleeve rather than an env
swap. Each worker reports its thresholds on boot (`scan_worker_ready` in `engine.jsonl`);
`TWO_SLEEVE_SCAN=shared` keeps the old single in-process scan for smokes only.

Set `defaultOwner`
in the config to the sleeve that should adopt positions already in the account when the engine
takes over (`"R"` when it inherits race's book), and copy that box's `trader-state.json` to
`two-sleeve/<id>.state.json` so the sleeve keeps its hold clocks and stop records. Per-sleeve journals and state live under
`data/lantern-garage/trading/two-sleeve/` (`S.autopilot-trades.jsonl`, `R.autopilot-trades.jsonl`,
`engine.jsonl`, `heartbeat.json`, `ownership.json`); the transparency page and the ledger scorer
read the sleeve journals like any autopilot journal.

## Before it trades

1. The engine-core replay reproduces the sweep numbers on the same 60 sessions (this is the gate
   the ledger row `two-sleeve-engine-v2` scores).
2. A dry session on a real account with brain rows in both sleeve journals and per-sleeve signal
   counts on every tick: orders journaled as `dry_order`, none placed, lock semantics observed.
   Monday 2026-09-21 does not count (see above); the repaired runner's first full dry day is
   the gate, scored by the ledger row `two-sleeve-dry-day-2-fidelity`.
3. Paper for at least three weeks, scored against the ledger row, on a third account or replacing
   race — the operator's call.

Out of scope, deliberately: regime switching between sleeves. No real-time detector exists (the
first-30-minute read missed both September trend-downs), so the engine runs both sleeves always
and lets the budget carry the regime exposure.
