# auto-trader.js — rule history

The long comments that used to sit inside `apps/lantern-garage/lib/auto-trader.js`, moved here verbatim
(2026-11-11) so the code stays readable. Each rule's comment in the code now ends with its id, e.g. `(H38)`;
the entry below with that id holds the full story: the incident that caused it, the dates, the measurements and
the ledger rows. Line references are to the code as it was when the comments moved (master 5efd83686).

When you change a rule, put the short what/why in the code and add the history here under its id (or a new id).

## H0

Above `const TRADES_LOG = process.env.TRADER_TRADES_LOG`

    Per-trade outcome log (append-only JSONL) — the honest record that lets us
    MEASURE the autopilot's realized edge (win-rate / P&L) against the backtest,
    instead of eyeballing it. Resolved relative to this module so it's found
    regardless of the server's cwd (same reason as the credential store).
    TRADER_TRADES_LOG / TRADER_STATE_FILE override the paths so a test can exercise the
    real append + reconciliation without writing into the operator's live ledger.

## H1

Above `const { AsyncLocalStorage } = require('async_hooks');`

    PER-USER ATTRIBUTION. The autopilot drives every connected account, but the
    ledger was one undifferentiated book: a row said WHAT was traded and never FOR
    WHOM, so one user's journal could only ever be answered with everyone's. Each
    row now carries the account it was traded for.

    The acting user rides the pass's async context, not a module scalar (review M1,
    2026-09-29). The scalar assumed passes never overlap, but the fast-exit loop runs
    on its own timer beside the scan loop: an interleaved pass restored the wrong
    "previous" user and tagged rows with it, and the public demo feed decides what
    to show by exactly this tag.

## H2

Above `try {`

    Converge stage (#3286). Every entry is a falsifiable claim and every exit is
    the market's answer, so the pair belongs in the convergence store — which sat
    at 0 bytes while the trader took 118 entries over 24 sessions. Hooked HERE, at
    the single ledger write point, so no path can bypass it: the reconstructed
    `closed_externally` exits are graded too, and a future exit site inherits it.
    Fire-and-forget by design — a record must never delay or break a trade.

## H3

Above `try {`

    A CONFIRMED exit explains the position leaving the book, so the flat reading
    is no longer suspect (#3282). Hooked here, at the single ledger write point,
    so no exit path can miss it.

    ONLY A REAL FILL COUNTS. A `reconstructed` row is itself INFERRED from the
    same absence the veto exists to distrust — letting it clear the veto would
    be circular, and would defeat the fix precisely in the dropout case: the
    sweep would invent an exit, that invention would license a fresh entry, and
    the position would double exactly as it did on 2026-08-13. An estimate
    cannot corroborate itself.

## H4

Above `const DEFAULTS = {`

    auto-trader.js — autonomous stock EXECUTION over the Σ₀ scan (Act stage).

    The scan (signal-engine) produces ENTER/SKIP verdicts; this turns the ENTER
    ones into real orders on the user's connected IBKR account. It is the missing
    link that lets the AI trade on its own when the market opens.

    SAFETY (defense in depth — ALL must hold to place a real order):
      1. TRADER_AUTO_EXECUTE=1  — explicit opt-in, SEPARATE from manual TRADER_LIVE.
         Off by default: arming manual buy/sell must NOT silently arm the autopilot.
      2. Every order still passes the hard guard in trading-guard.js (TRADER_LIVE=1,
         caps, kill-switch, live-account double-opt-in) — auto-trade cannot bypass it.
      3. Position sizing is bounded by MAX_ORDER_NOTIONAL and TRADER_POSITION_PCT.
      4. One position per symbol (no pyramiding); a per-symbol cooldown stops churn.
      5. LONGS only by default (BULLISH→buy). A BEARISH signal only SELLS a long we
         already hold (a signal-based exit) — never opens a naked short unless
         TRADER_ALLOW_SHORTS=1.

    It is Σ₀-honest: every decision returns [action, evidence, confidence] and is
    logged, and it never fabricates a fill — the broker result is passed through.

## H5

Above `exitReattemptMin: 8,`

       stopPct). Backtests show this engine's winners don't run —
       a tight 1R target beat 2R/3R on every basket (leveraged/
       inverse ETFs: 55% win, PF 1.17 at 1R vs 33% / 0.77 at 2R).
       0 = off (let the trailing stop run instead).
    After firing an exit for a symbol, don't re-fire for this long. In extended hours an
    exit limit can sit unfilled, and without this the loop re-placed the SAME exit every
    scan — 30+ phantom "exit" log rows for one still-open position, and stacked orders.

## H6

Above `atrStops: process.env.TRADER_ATR_STOPS !== '0',`

    Zone-ladder exit (#3165, OOS-validated on SPY+QQQ only): sell at the first
    resistance zone unless price punches THROUGH it — then the second zone is the
    target and the first becomes the floor. Ladder symbols skip take-profit/trail/
    momentum/signal exits (the ladder + broker stop own the position).
    ATR-based protective stops (operator decision 2026-08-04): use the signal's
    own ATR/S-R trade-plan stop (what the backtests actually validated) instead of
    a flat stopPct, clamped to [atrStopMinPct, atrStopMaxPct]. The flat stopPct
    remains the fallback when a signal ships no plan. Kill: TRADER_ATR_STOPS=0.

## H7

Above `riskPct: n('TRADER_RISK_PCT', 0.06),`

    RISK-BASED SIZING (Phase 0, 2026-08-04). Notional sizing made risk-per-trade
    an accidental byproduct of two independent knobs (position% x stop%), so
    identical $36k positions carried 0.047%-0.068% risk purely because their stops
    differed. Size from RISK instead: qty = equity*riskPct / (entry-stop). Default
    0.06 is calibrated to today's MEASURED average risk — same exposure, uniform
    risk. Raising it is a separate, evidence-gated decision. 0 = legacy notional
    sizing. The maxPositionPct notional cap still binds on top.

## H8

Above `roomTier: process.env.TRADER_ROOM_TIER !== '0',`

    ROOM TIERING (magnitude study 2026-08-05, OOS-validated on 5 symbols):
    entries with the first resistance >= roomMinR away (in R) earn 3-10x more
    per trade (0.48-1.6R vs 0.08-0.16R). A-tier (room) gets full risk;
    B-tier (cramped) gets roomBMult x risk and keeps the tight R1 harvest.
    Total risk goes DOWN, expectancy concentrates where the room is.
    Kill: TRADER_ROOM_TIER=0 (all entries full risk).

## H9

Above `volAplus: n('TRADER_VOL_APLUS', 1.2),`

    A+ TIER (confluence study 2026-08-05): room AND volume expansion. Pooled
    OOS gate — fit +0.856R/trade, holdout +1.036R/trade vs +0.425R for room
    alone (2.4x), positive on all 5 symbols in both windows. Held at the SAME
    risk as A for now: 65 pooled trades is thin evidence for extra weight, so
    A+ must first prove itself in live logging (TRADER_APLUS_MULT raises it).
    Zone TOUCHES were tested alongside and FALSIFIED (+0.468R vs +0.425R at
    the corrected >=2 threshold) — a proxy for what room/volume already catch.

## H10

Above `tgtMinR: n('TRADER_TGT_MIN_R', 0.5),`

    TARGET SEPARATION (2026-08-05). Measured live, the FIRST resistance above
    price is routinely inside the noise — SMH +0.00%, QQQ +0.19%, IWM +0.20%,
    i.e. 0.0-0.25R. A zone that close is not a target, it IS the entry, and
    aiming the ladder there caps the trade at a scratch before it is placed no
    matter how good the setup. So resistances nearer than tgtMinR are treated
    as noise: skipped for BOTH the exit ladder and the room tier (they were
    also demoting good entries to B for lack of "room" that never existed).
    Nothing qualifying = blue sky overhead, which is the A-tier case already.
    OOS gate, 5 symbols, fit 2000-2014 / holdout 2015-2026:
      0 (old): fit +0.326R  holdout +0.383R
      0.5    : fit +0.334R  holdout +0.400R   <- better in BOTH windows
      1.0    : fit +0.314R  holdout +0.404R   (holdout-only; rejected)
    0.5 is chosen because it improves fit AND holdout — the signature of a
    structural effect rather than a fitted constant. Kill: TRADER_TGT_MIN_R=0.

## H11

Above `stopMinPct: n('TRADER_STOP_MIN_PCT', 3),`

    MINIMUM STOP DISTANCE, % of price (2026-08-06). Gated 2% vs 3% on 5
    symbols, fit 2000-2014 + holdout 2015-2026, 3bp costs, ranked by PERCENT
    CAPTURED PER TRADE (avg_R is normalised by stop width and inverts the
    ranking — the best-avg_R config captured the fewest dollars):
      floor 2%: fit +0.072%/trade  holdout +0.275%/trade
      floor 3%: fit +0.159%/trade  holdout +0.312%/trade   <- wins BOTH
    3% also lifts win rate (45% -> 59%) by not tagging out on noise. At the
    unchanged 7% notional cap that is ~$210/trade vs ~$85 today.
    NOTE: the gate covered UNLEVERAGED symbols (SPY QQQ GLD TLT SMH). On a 3x
    ETF a 3% stop is only a ~1% move in the underlying, so it is tighter in
    real terms there, not wider — see TRADER_STOP_MIN_PCT_BY_SYMBOL.

## H12

Above `eodDecarry: process.env.TRADER_EOD_DECARRY !== '0',`

    EOD DE-CARRY (#3298 finding 3). Stops cannot protect through a gap, and a
    3x wrapper carries 3x the overnight exposure at equal notional — 64% of
    the 2026-08-13→14 give-back happened before any stop could act. The
    operator ran this policy by hand twice (pre-open trim, weekend flat);
    this automates it: leveraged holdings are flattened into the close.

## H13

Above `eodFlat: String(process.env.TRADER_EOD_FLAT || 'off').trim().toLowerCase(),`

    SESSION-END FLAT (2026-08-24, operator: "never hold over the weekend").
    TRADER_EOD_FLAT: 'weekend' = flat EVERY held long into the close of the
    last session before a weekend; 'all' = flat every session close; unset/
    'off' = hold (the validated default). TRADER_EOD_FLAT_MIN is the ET minute
    it starts (default: the de-carry clock, 15:50). Measured on the four
    surfaces (experiments/overnight_policy_lab.js) under the armed stack:
      weekend  h1 36.1% div4.14 | d-fit 8,723% div800 | h2 53.1% div11.47 | 26y 15,405% div857  (+4% vs armed, better on BOTH holdouts)
      all      h1 25.1% div2.80 | d-fit 8,463% div760 | h2 50.2% div10.87 | 26y 14,622% div891  (costs 3 of 4 surfaces)
    The live book agrees: weekend holds are 8 trades for -$228, while weekday
    overnight holds are profit factor 2.58 and 71% of all profit — so the
    weekend leg is the part worth cutting, not the overnight leg.

## H14

Above `maxHoldSessions: n('TRADER_MAX_HOLD_SESSIONS', 0),`

    TRADER_MAX_HOLD_SESSIONS (2026-08-27, default OFF): flatten a position at the
    close of its Nth session. NOT a new idea — the lab config every armed number came
    from (armed_baseline MONDAY, the 2,866% 26y holdout) includes timeoutS: 5, "exit
    at the close of the 5th session", and the engine simply never implemented it.
    The gap has a live victim: SPXS on race sat 3 sessions in the DEAD ZONE — always
    reading BULLISH (a perma-washout as it fell) so the bearish branch never ran and
    the bounce exit was never evaluated; peak +0.64% never armed the +1% floor;
    -1.9% never hit the -3% stop. No rule could reach it. This one can.

## H15

Above `carryDownDayPct: (() => { const v = Number(process.env.TRADER_CARRY_DOWNDAY_SPY_PCT); return Number.`

    CARRY ON A DOWN DAY (2026-10-08, ledger tier0-inverse-carry-gated-by-entry-day): the de-carry stands aside for
    the symbols in TRADER_CARRY_DOWNDAY_SYMBOLS (default: the inverse family) when SPY's regular session (first
    5m close -> now) is at or below TRADER_CARRY_DOWNDAY_SPY_PCT (e.g. -1.5). The stop, the weekend flat and the
    signal exit are untouched: the breakdown rides the overnight gap and the next session's first bar sells it.
    Unset = off (every wrapper flat at 15:50, as before). Measured static on 43 windows: carries after a <= -1.5%
    SPY day earned +11.2k | +0.5k gross, carries after a milder down day -4.9k | -4.8k.

## H16

Above `regimeSizeMult: n('TRADER_REGIME_SIZE_MULT', 0),`

    REGIME SIZING (measured 2026-09-05, 60-session armed-parity replay with
    identical trade lists): SPY's first-30m close position <= regimeR30Max
    reads "trend-down day"; post-10:00 LONG entries then carry
    regimeSizeMult x risk for the rest of the session. Size only — entries
    are never blocked (the gate form of this read was measured dead;
    the dial form: 0.25x @ 0.15 gave +0.20pp return at maxDD 1.11->0.96%,
    and thresholds >= 0.20 LOSE — keep it tight). Inverse-family entries
    (WITH a falling tape) are exempt. (0,1) enables; 0/unset = off.

## H17

Above `stopScale: (() => {`

    Per-symbol stop tightening (OOS-validated 2026-08-05): scale the plan stop
    distance for listed symbols. SPY at 0.65x earned +30% more R per $ risked in
    BOTH the 2000-14 fit and 2015-26 holdout windows with flat drawdown; QQQ's
    equivalent was a drawdown trade-off and is deliberately NOT defaulted.
    Format: "SPY:0.65,QQQ:0.8". Kill: TRADER_STOP_SCALE_SYMBOLS="".

## H18

Above `supEntry: process.env.TRADER_SUP_ENTRY !== '0',`

    SUPPORT-ENTRY GATE (#3165 RR-geometry, OOS-validated on SPY+QQQ,
    operator green-light 2026-08-05): only enter AT the support zone (within
    supEntryAtr ATRs of its top) and put the protective stop UNDER the zone
    (bottom - 0.25 ATR) — structural: it has wiggle room below break-even and
    only triggers when the entry thesis actually failed (price broke the zone).
    Validated: RR flips 1:0.46 -> >1:1 in every window; QQQ holdout PF 2.06.
    Kill: TRADER_SUP_ENTRY=0. Scope: TRADER_SUP_ENTRY_SYMBOLS (validated names).

## H19

Above `zoneExitSyms: (String(process.env.TRADER_ZONE_EXIT_SYMBOLS || 'all').trim().toLowerCase() === 'all')`

    LADDER FOR EVERY ENTRY (#3285, 2026-08-14). The 9-symbol allowlist was a
    fossil from before the 27-symbol watchlist: SOXL/XLK/IWM/DIA/TQQQ and the
    sectors could never arm a ladder at all, so their exits fell through to
    first-weak-scan scratches. Live cost, 2026-08-14: a SOXL re-entry 0.08%
    off the session low — bounce +3.83% — was scratched at +$72 of a $1,036
    move. Default is now ALL entered symbols; set TRADER_ZONE_EXIT_SYMBOLS to
    a list only to restrict deliberately.

## H20

Above `ladderVolMult: n('TRADER_LADDER_VOL_MULT', 0),`

    EXPERIMENTAL vol-scaled rung tightening — FALSIFIED at defaults by the
    two-window sweep (37,518 trades: every ATR multiple and the MFE-adaptive
    variant lose BOTH windows on total income vs plan targets; monotonic —
    nearer full-exit targets amputate the winners' tail). OFF (0) by default;
    kept only for a future re-test with a partial-bank runner structure.

## H21

Above `momentumMinR: n('TRADER_MOMENTUM_MIN_R', 0.5),`

    Momentum-death needs a MINIMUM PROFIT before it may fire. Measured on 131 real
    filled exits: 31 of 33 sub-0.15% "wins" were momentum_died at RSI~50 — banking
    ~nothing, paying two commissions, then re-entering the same name hours later.
    A fading winner needs a winner to fade; below this floor the protective stop
    (capped at 1R) is the better risk manager. Expressed in R (x stop distance).

## H22

Above `entryConfirm: (() => { const v = Math.floor(Number(process.env.TRADER_ENTRY_CONFIRM)); return Number`

    TRADER_ENTRY_CONFIRM (2026-08-27, default OFF): require N consecutive rising
    closes on the momentum timeframe before an entry — the operator's reversal
    thesis ("it needs an actual sign of the reversal: hitting a low and starting
    to go up; bumps look different"). 1 = one up bar; 2 = the lab's T2 (two up
    bars, no new low between). Reconstruction evidence only, which is why it is
    a flag and not a default: on 60 sessions T2 halved winner MAE (-0.44% ->
    -0.22%) and earned baseline's return on a quarter of the drawdown — but the
    same harness produced four findings the real engine reversed, so this ships
    OFF, to be judged by the replay harness and a live A/B, not by its lab row.

## H23

Above `const STOP_WORKING = /submit|pending|presubmit|open|accepted|new|working|held/i;`

    Cancel any working orders for a symbol (chiefly a protective stop) so a stale
     stop can't fire on a flat/closed position and open an unintended short.
    STOP-ORDER STATUS VOCABULARY (#3352). Three sites ask "what state is this stop
    in?" and each carried its own regex. The dangerous one was the accumulation
    cap, which recognised FAILURE by an ALLOWLIST (inactive/reject/needs_confirm).
    A status in NEITHER vocabulary — an empty/absent status field, or any term the
    broker uses that we have not seen — is invisible to both checks: not working,
    so the re-protect pass places another; not a known failure, so the cap never
    trips. Unbounded. Live 2026-08-18 04:00: QQQ carried 1,200 shares of resting
    stops against 80 held and SPY 1,125 against 75 — exactly 15 duplicates each,
    while the cap sat at 3. Had one triggered, IBKR either sells shares we do not
    own (a short, on a longs-only strategy) or rejects and leaves the position
    naked.

    So classify by COMPLEMENT, never by allowlist: a stop is WORKING, or it is
    TERMINAL (cancelled/filled — lifecycle, not failure, per the 2026-08-10
    hardening that stopped counting our own cancel-first exits), or it is a FAILED
    placement. Unknown statuses land in the last bucket, which is the safe side:
    the cap stops adding and the ledger says why.

## H24

Above `async function _sellGate(bridge, userId) {`

    A STOP IS NEVER CANCELLED AHEAD OF AN ORDER THAT CANNOT GO OUT (review H1,
    2026-09-29). The hard guard refuses every order while a halt file is present, while
    the account is dry (TRADER_LIVE unset on IBKR, a live account without its opt-in) or
    its mode is unknown. A cancel is not an order, so it went through. Exits cancel the
    resting stop and then sell; the stop resize and the breakeven ratchet cancel and then
    re-place. With orders refused, the sell or the new stop never went out and the
    position was left with no stop at all: engaging the kill switch stripped protection
    from the very book it was meant to freeze.

    So a pass first asks the broker leg whether a sell can go out now. The leg answers,
    not the engine, because only the leg knows which guard applies to it (Alpaca paper
    orders skip the guard; the house ledger has none; demo is read-only). While the
    answer is no, the pass changes no stop and fires no exit, and the stops the broker
    already holds keep guarding the book.

## H25

Above `for (let attempt = 0; canceled.length && attempt < 3; attempt++) {`

    SETTLE BEFORE SELLING (#3407). A cancel is not instantaneous: Alpaca holds
    the order in pending_cancel while the shares stay reserved, so a market
    sell issued immediately after is rejected for insufficient quantity. That
    is exactly how the race book's eod_decarry errored TWICE on 2026-08-21
    and carried a 3x position into a weekend (and how the operator's manual
    champion flatten bounced on 08-20). Wait — bounded — until the canceled
    ids leave the working book; IBKR usually settles on the first check.

## H26

Above `function sizePosition({ equity, price, sizeMult = 1, positionPct = DEFAULTS.positionPct, maxPosition`

    Position size in whole shares. Pure + exported for tests.
      base notional = min(equity · positionPct%, maxNotional)   ← never exceeds the cap
      notional      = base · sizeMult (conviction, 0.5–1.5)
      qty           = clamp(floor(notional / price), 1, maxQty), then re-capped so
                      qty·price ≤ maxNotional.
    Returns 0 when unpriced/negative — the caller then skips.

## H27

Above `const _holdClockAt = new Map();  // sym -> ts max_hold first SAW an untracked position`

    ADOPTED HOLD CLOCK (2026-08-27). max_hold counts from _entryAt — but a position with
    no recorded entry time was IMMUNE forever, and the class is live: on the rule's first
    armed day, stable's state held TLT (entered by the engine at 12:10 that same day)
    with no persisted entryAt. Kept SEPARATE from _entryAt on purpose: adopting into
    _entryAt would make an old position look freshly entered to the maturity gate,
    min-hold and every other consumer of entry time. This clock feeds max_hold ONLY.

## H28

Above `const _unclosableRetryMs = () => Math.max(5, parseFloat(process.env.TRADER_UNCLOSABLE_RETRY_MIN) || `

    How long an unclosable freeze holds before ONE clean retry cycle is allowed.
    Permanent freezing turned a ~25-min transient order-path outage into positions
    stranded from every engine exit until they left the book (audit 2026-08-08);
    hourly retry bounds the churn for the genuinely-structural case (the 0.8-share
    SOXS class) to ~3 error rows/hour instead of the historical every-9-minutes.

## H29

Above `const _stopCooldownThrough = new Map();`

    POST-STOP RE-ENTRY COOLDOWN (2026-08-08 tail gate). After a protective stop
    fills, the symbol is barred from re-entry for the rest of that session plus
    TRADER_STOP_COOLDOWN_DAYS trading days. Lab (both windows, 19 symbols, live
    config): halves the holdout's worst day (-2.86% -> -1.40%) at -0.004%/trade.
    sym -> ET date string (inclusive) through which entries are refused.

## H30

Above `let _stopFillsDay = null;   // ET date the counter belongs to`

    DAILY CIRCUIT BREAKER (2026-08-08 tail gate #2). The 2008-class worst days
    were CROSS-symbol churn: stops freed slots, fresh symbols refilled them into
    the same crashing market. Once TRADER_STOP_BREAKER stop fills land in one ET
    session, entries are refused for the rest of it. Replay (both windows, on top
    of the cooldown): worst day -3.97% -> -1.40% (= the pure 4x0.35% structural
    bound) AND %/trade improved in both windows — crash-day refills were -EV.

## H31

Above `const _lastConfirmedHold = new Map();`

    STOP ATTRIBUTION THRESHOLD (#3281). A position that leaves the book outside our
    own exit path is reported only as an absence — "protective stop, manual close,
    or another engine" — so a stop-out arriving that way armed neither counter
    above. Treat the close as a stop when it gave up at least this fraction of its
    stop distance. 0.9 covers the real case (SQQQ left at -2.88% against a 3% stop,
    96%) with room for the mark lagging the trigger tick, while still ignoring an
    ordinary small-loss exit.

    Read per call, like cfg(), so the lab can sweep it without a reload. <= 0
    disables attribution entirely and restores the pre-#3281 behaviour — note the
    explicit > 0 guard at the use site: a bare `loss <= -(pct * 0)` is `loss <= 0`,
    which attributes EVERY loss. That inversion is the whole reason the check is
    spelled out rather than folded into the arithmetic.
    LAST CONFIRMED HOLDING (#3282). sym -> ms when the broker last reported a
    non-zero position in it.

    The `already long` guard trusts a single position snapshot. On 2026-08-13 the
    feed dropped SOXS for two scans — 11:13 held, 11:14 and 11:15 ABSENT, 11:16
    held again — with no exit of any kind on record. During the gap the engine
    evaluated SOXS as a fresh candidate and opened a full-size tier-A+ entry on
    top of the 1,490 shares it already had, taking the position to 3,057.8: twice
    the intended maximum, behind a stop sized for part of it. It happened to earn
    +$4,218; a double-size loss was equally available.

    A position leaving the book is normally EXPLAINED — our exit fills, or the
    external-close sweep reconstructs one. An absence with no exit row at all is
    the dropout signature, so this map is cleared by any exit row for the symbol
    (see logTrade) and otherwise stands as the reason to distrust a flat reading.

## H32

Above `const _trustedBook = new Map();   // user -> { held: Set<symbol>, suspectSince: ms or 0 }`

    ENTRIES WAIT OUT A BOOK THAT LOST POSITIONS (review H3, 2026-09-29). A read that
    FAILED is now "unknown" and stands the pass down. A read that succeeded but came back
    short (empty while this account held names on its last trusted read, or three or
    more gone at once) with no exit or fill on record is kept for exits, because an
    honest empty book must still clear exit freezes. Entries wait, though: sizing and the
    position caps count what the snapshot shows, so a dropout reads as free room. The
    per-symbol guard above (#3282) stops re-buying the same name; this stops the caps
    being filled with other names on top of the invisible ones.

    Per ACCOUNT, not per symbol: the symbol-keyed maps are shared by every account the
    loop drives (ADR-0035 step 2 re-keys them), and a per-symbol reading here would let
    one user's holdings stall another user's entries. Bounded by the same window as
    #3282; after that the reading is accepted.

## H33

Above `function _stressCfg() {`

    STRESS MULTIPLIER (#3428 gates/caps lab; Nagel 2012 "Evaporating Liquidity":
    short-term reversal returns rise strongly with VIX). Size UP when the tape is
    stressed — the other direction from the rejected regime-half sizing. Lab:
    12% -> 18% when the prior VIX close >= 20 lifted the 26y holdout from 445%
    to 841% at an UNCHANGED drawdown (-13.9%); the fit-chosen rule (VIX >= 20 OR
    SPY session IBS <= 0.3, x2) took holdout return/DD from 32 to 69 and tied
    the recent hourly half. Absolute drawdown grows with the multiplier — the
    operator picks the size.
      TRADER_STRESS_MULT     multiplier (default 1.5 = ON; set <= 1 to disable)
      TRADER_STRESS_VIX      prior-session VIX close at/above which it applies (default 25)
      TRADER_STRESS_SPY_IBS  SPY session IBS at/below which it also arms (default 0 = leg OFF)
    Either condition arms it (OR). It scales BOTH the risk target and the
    notional cap, like the room tier — otherwise the 12% cap binds and nothing
    changes. Conviction sizing (size_mult) is untouched. Entries only.
    DEFAULT ON (operator, 2026-09-18). The four-surface sweep (armed_baseline,
    VIX leg only, x1.5 at prior close >= 25) improves return AND return/DD on
    ALL FOUR surfaces vs stress-off — h1 0.51->0.56, d-fit 0.36->0.44, h2
    1.98->2.26, d-hold 9.05->13.32; 26y return 136%->186% at a SHALLOWER max
    drawdown (-15.0%->-14.0%). A literature-predicted sign tested once (Nagel
    2012; #3433 "VIX-level trigger beats term structure"; #3445 "the panic days
    are the best trades"), not a mined grid. The SPY-IBS OR-leg defaults OFF
    because the harness scores only the VIX leg — measure it before arming.

## H34

Above `function _symbolSizeMult(sym, spec = process.env.TRADER_SYMBOL_SIZE_MULT) {`

    SYMBOL TILT (#3434 stack-sweep lab). Per-symbol size weights chosen on the
    FIT surfaces only (weight = clamp(fit edge / median edge, 0.5, 1.5)) and
    confirmed on both holdouts: recent half 31.5% vs 19.4% (return/DD 5.7 vs
    4.3), 26y holdout 1,494% vs 841% (89 vs 60). The first sizing change that
    improved the ratio instead of scaling it. Validated weights:
      SOXL:1.5,SMH:1.5,QQQ:1.5,XLK:1.0,IWM:1.02,SPY:0.83,DIA:0.71,GLD:0.5,TLT:0.5
    TRADER_SYMBOL_SIZE_MULT="SYM:w,SYM:w,..." (unset = flat). Scales the risk
    target and the notional cap together, like the room tier and the stress
    multiplier; composes with both. Clamped to [0.25, 2].

## H35

Above `function _parseEtWindows(spec) {`

    ENTRY-HOUR BLOCK (#3427 overnight-leg lab). The washout edge is concentrated
    late in the session — last-hour entries earn ~+0.8%/trade, the 13:30-14:30
    bar's entries are NEGATIVE on both halves of the 2y hourly window; skipping
    that bar lifted the 2y analog from 22.3% to 30.5% on fewer trades (the full
    fit-chosen set {09:30-10:30, 12:30-13:30, 13:30-14:30}: 37.4%, confirmed on
    the second half). Mechanism per the literature (Lou/Polk/Skouras; NY Fed
    "Overnight Drift"): the return accrues overnight and the intraday leg
    reverts; an early-afternoon washout sits through the worst of it.
    TRADER_ENTRY_BLOCK_ET="13:30-14:30[,HH:MM-HH:MM...]" — ET windows, half-open;
    unset = off. Entries only; exits and stops are untouched.

## H36

Above `function _noFridayEntry(nowMs) {`

    NO FRIDAY ENTRIES (2026-10-05, the gate audit; ledger gate-audit-stable-no-friday-entries-13-windows / -30-quarters).
    TRADER_EOD_FLAT=weekend sells every long at Friday 15:50, so a dip bought on a Friday has hours, not sessions, to
    bounce. On the stable box Friday entries lost on both replay surfaces (-0.108% / -0.065% a trade net, win rate
    48% / 53% against 67% / 65% Monday to Thursday); without them the box netted +0.040% / +0.025% a week more with
    3.5 / 2.3 points more winning trades and a fifth fewer trades (its two crash weeks were slightly worse).
    TRADER_NO_FRIDAY_ENTRIES=1 skips NEW entries on an ET Friday. Exits, stops and the weekend flat are untouched.
    Off by default.

## H37

Above `function _parseSymbolWindows(spec) {`

    PER-SYMBOL ENTRY WINDOW (lab 2026-09-27, shadow-first). The nine-window anatomy of the
    armed stack: the leveraged INDEX wrappers (SOXL TNA SPXL UPRO TQQQ) lost on their
    11:00-13:00 entries and won on their afternoon ones; "leveraged index only from 13:00 ET"
    beat the armed stack 7-2 in-sample (+5.0pp over nine windows, maxDD lower) and was never
    worse on the four 2022/2023 out-of-regime windows (+0.02/+0.34/+0.24/+0.74; ledger
    lev-index-from-13-oor). TRADER_SYMBOL_ENTRY_BLOCK_ET="SOXL,TNA,SPXL,UPRO,TQQQ:09:30-13:00
    [;SYM,SYM:HH:MM-HH:MM,HH:MM-HH:MM]" - per-name ET windows, half-open, ENTRIES only; unset =
    off. TRADER_SYMBOL_ENTRY_BLOCK_MODE = shadow (default: journal every entry it would have
    blocked, let it through) | live (skip the entry). Exits and stops are untouched.

## H38

Above `function _cadenceReentryExempt(sym, nowMs) {`

    ENTRY CADENCE (#3435). The engine reads the session IBS every scan (~60s) and
    buys at the first two scans where it crosses the threshold; every lab that
    validated this stack read it at BAR CLOSES. On 20 sessions of 1-minute data
    with identical rules (experiments/cadence_validate_1m.js) the engine analog
    is payoff 0.57 / -0.2%; the same entries confirmed on an hourly close, exit
    unchanged, are payoff 0.68-1.64 with 8 of 9 boundary phases beating the
    engine (mean ~+3.7%) and a lower drawdown in every case. The 2y hourly labs,
    which sample at :30 closes, make +23% / +25% per half. Mechanism: IBS is a
    CLOSE phenomenon - a washout still at the session low when an hour closes is
    the pattern the research measured; a two-minute poke at a level is noise.
    TRADER_ENTRY_CADENCE_MIN=60 (unset/0 = off). TRADER_ENTRY_CADENCE_PHASE=0 is
    the boundary's minute offset (0 = :00, 30 = :30 = the labs' phase).
    TRADER_ENTRY_CADENCE_WINDOW=3: entries are allowed for this many minutes after
    a boundary, so a busy scan loop still lands one decision scan per bar.
    Entries only - exits, floors, trails and the broker stop are untouched.
    ONE DECISION PER BAR (follow-up, 2026-08-23). The scan loop is setTimeout(60s)
    AFTER each scan completes, so scan spacing is 60s + scan time: live 8/18-8/21
    median 58s, p90 139s, p99 564s. A fixed 3-minute window therefore misses an
    hourly boundary outright roughly once in 15-20, and that hour's decision is
    skipped for every symbol. Semantics now: the FIRST scan after a boundary
    decides even if it is late (up to half a bar - beyond that it is a different
    bar), and a second scan inside the same bar never decides twice. `decided` is
    the boundary (ET minute) of the last decision scan; the caller records it.
    RECYCLING WAS THE EDGE, AND THE CADENCE ENDED IT (2026-08-26).

    Live daily history, stable. Week 1 ran 9.4 entries/day with 3.2 SAME-SESSION
    RE-ENTRIES/day and made +$13,764; its two best days were its two highest-recycle
    days (08-14 +$6,803 and 08-10 +$3,073, six recycles each). From 08-17 the recycle
    count is ZERO — every day, ten trading days running — and the book is -$1,368.
    The session note from week 1 named the mechanism at the time: "the lab's +$874/day
    ceiling was beaten 3.5x by INTRADAY RECYCLING the daily-bar lab structurally cannot
    see: SOXL 3 rounds +$1,762, SMH 3 +$541, QQQ 3 +$468, XLK 2 +$336, each re-entry at
    a lower rung than the prior exit."

    Since 08-24 `entry_cadence` is the single biggest entry blocker (99, 85, 72 rows a
    day), and of 26 exits across 08-24..08-26 only TWO ever came back. The lockout
    compounds: a symbol that exits at 10:20 is held off by the 45-minute cooldown until
    11:05, but the cadence only decides at 11:00 — so it misses that bar and waits for
    12:00, by which time it must out-rank every fresh candidate.

    The cadence itself was validated on daily and hourly bars — a surface that cannot
    represent a second entry into the same symbol on the same day. It measured what it
    does not affect and was blind to what it destroys, so no backtest can settle this;
    it is a live question.

    This exemption is NARROW: it lets a symbol the engine already exited THIS SESSION
    bypass the cadence gate only. Cooldown, post-stop cooldown, the concurrent cap, the
    maturity gate, the morning gate, falling-knife and every sizing guard are untouched,
    and a re-entry never SPENDS the bar, so it cannot cost a fresh symbol its decision.
    DEFAULT OFF: TRADER_CADENCE_REENTRY=1 to arm.

## H39

Above `let _cadenceDecided = { day: null, boundary: null };   // the boundary whose decision was SPENT (an `

    A SPENT BAR SURVIVES A RESTART (2026-09-29). This mark lived in memory only. On 2026-09-29 three
    merges to master between 13:54 and 14:12 ET rolled the armed stable server three times in twenty
    minutes. At 14:07:22 it bought IWM and refused TNA in the same scan ("entry_cadence: 14:07 ET
    already decided this bar - next decision 15:00"). The 14:16 restart wiped the mark, and at
    14:17:09 the fresh process read its first scan as the late first decision of a bar nobody had
    decided and bought 3,074 TNA ($178k): an entry the armed rule forbids, and with the 15:00 block
    behind it one that would not have been taken at all. It happened to make +$908. The mark is now
    saved with the rest of the state the moment it is set and restored on load; the gate already
    ignores a mark from another session (it compares the ET day), so nothing carries overnight.

## H40

Above `function _markCadenceDecided() {`

    THE BAR'S DECISION IS SPENT WHEN THE WINDOW CLOSES, NOT ON THE FIRST FILL
    (2026-08-25). Spending it on the first placement let whichever symbol happened
    to resolve first take the whole hour: on 8/25 the 11:00 bar went to DIA (tilt
    0.71, the lowest-weighted name on the list) at 11:00:35 and then blocked QQQ
    and SMH (tilt 1.5) at 11:01 with three slots free — bypassing the very ranking
    #3438 measured at 2,866% vs 1,494%. Inside the window every name that becomes
    eligible now competes on rank; outside it (the late-first-scan allowance) the
    first placement still spends the bar, so the cadence itself cannot widen.

## H41

Above `function _signalIbs(s) {`

    THE SESSION IBS OF A SIGNAL (2026-08-25). scan.js builds the signal with the
    reading on `decision_context.ibs` (#3375/#3381 moved the evidence there); there
    is NO top-level `s.ibs`. Every consumer that read `s.ibs` was therefore reading
    undefined, silently and permanently:
      - the IBS bounce exit — the validated exit, 1,494% vs 462% on the 26y holdout
        (#3437) — never fired once. Every held symbol logged "no session IBS reading
        yet" instead: live 8/25, 28 such rows across exactly the three held names,
        while sessionIbs() computed fine from the same cache (DIA 0.492, SPXL 0.468,
        SOXL 0.249).
      - _orderEntries' depth tie-break always scored Infinity, so slot priority
        silently degraded to weight-only with ties broken by scan order (#3438).
    Read both, preferring an explicit top-level value if one ever appears.

## H42

Above `const _deferredExit = new Map();   // sym -> { reason, decidedAt, decidedPx }`

    DEFERRED EXTENDED-HOURS FILLS (operator, 2026-08-26). A price-threshold exit that
    triggers outside RTH still DECIDES outside RTH — but it must not FILL there.

    Measured over 59 days, 10 names, 580 symbol-days: after a pre-market drawdown of
    -1.5% or worse the regular-session open was ABOVE the pre-market low 79% of the time
    (the -2.0/-1.5% band opened +1.77% up, +2.33% an hour in). After-hours is the same
    story at 88%. Every credible band, both windows, reverts at the open. Selling into an
    extended-hours low is systematically selling the low.

    It cost SOXL on 2026-08-26: trailing_stop fired 08:36 at 113.52 on a real, sustained
    pre-market fall; the session opened at 115.54 and ran to 117.19. -$2,647 realised
    where the same decision filled at the open would have been roughly +$418.

    The DECISION stands and the position still leaves the book, so #3378's reason for
    managing the extended session at all is untouched. Only the fill moves to 09:30.

    NOT DEFERRED: max_loss. That is the disaster brake, not gain protection, and a
    position already at its loss cap should not be asked to wait. The broker's resting
    stop stays underneath throughout, so a genuine overnight collapse is caught by the
    venue rather than by us. TRADER_MAX_LOSS_RTH_ONLY=1 is the other choice, and it is not
    a deferral: the cap does not decide at all outside regular hours (manageHeldExits).

    The risk this accepts, plainly: on the minority of days that do NOT revert, the
    deferred fill is worse. The measurement says that is the smaller half by a wide
    margin. TRADER_EXT_DEFER_EXITS=0 reverts it.

## H43

Above `const _lastPos = new Map();`

    sym -> last observed broker snapshot { qty, entry, mark, ts } while we held it.
    This is what makes an EXTERNAL close (a resting protective stop filling, a manual
    flatten, another engine) reconstructable: when the position vanishes from the book
    without an autopilot exit of our own, this is the only record of what we held and
    where it was marked. Persisted, so an overnight stop-out is still landed at boot.

## H44

Above `const _lastBasis = new Map();   // sym -> { entry, ts, openedAt }`

    THE LAST PARTIAL FILL'S BASIS (SMH 2026-10-09). A 30-share GTC stop filled 12 / 9 / 9 over three
    minutes at the open, and each fill row (_reconcileFills) rightly destroyed the per-position state
    — but the position was still held after the first two, so the next sweep re-adopted it (with the
    broker's avg_entry_price) and the second row priced fine. The THIRD fill emptied the book: no
    sweep re-adopted the symbol before the reconcile ran, _lastPos was gone, and the row was
    journaled with entry:null / pnl:null — the day's booked realized under-counted by the whole
    partial (+51.35). This map remembers the basis the sweep saw while the symbol was held, and the
    reconcile falls back to it when _lastPos is empty and no NEWER entry was placed by this engine.

## H45

Above `const _absentStreak = new Map();`

    FEED-FLAP GUARD STATE (#3378). Both maps demand agreement between two
    consecutive snapshots before anything irreversible happens:
      _absentStreak — a tracked position books as externally CLOSED only after it
                      is missing twice in a row (a single-read absence booked
                      DIA/XLK/SOXS as closed on 2026-08-19 17:26 ET; all three
                      were confirmed held two minutes later).
      _seenStreak   — a position with no engine state is ADOPTED for tracking and
                      exit management only after it is seen held twice in a row
                      (one foreign snapshot injected another book's GLD/TLT; they
                      were adopted on sight and their disappearance two minutes
                      later was booked as our exits, at alien cost bases).

## H46

Above `const LIMIT_SHADOW_DEPTHS = [0.0025, 0.005, 0.0075, 0.01];`

    ── LIMIT SHADOW (#3424 lab, journal-only) ────────────────────────────────────
    The depth sweep showed limit-filled entries earn 3-4x the touch entry per
    trade while the signals whose limit never fills are the weak ones — but the
    26y daily bar cannot express an intraday limit, so the mechanism gets a live
    SHADOW before any order path changes. On every real entry we record the
    hypothetical resting limits at LIMIT_SHADOW_DEPTHS under the touch price;
    each scan marks which ones the mark has touched (a resting limit fills at
    its level — queue position is not modelled, the same optimism as the lab);
    the shadow closes with the session or the position. Nothing reads it in the
    engine; experiments/limit_shadow_score.js joins it to the exit rows.
    TRADER_LIMIT_SHADOW=0 disables.

## H47

Above `const _requoteShadow = new Map();   // sym -> the entry_requote row's numbers, joined into entry_fil`

    ── ENTRY RE-QUOTE SHADOW (2026-10-04, journal-only) ─────────────────────────
    Real fills since 2026-09-01 cost 2-3 bp on index ETFs but 5-6 bp on the 3x
    longs and 14-15 bp on the 3x commodity funds (max 36), on both brokers. Two
    causes on our side: the buy goes out on the SCAN's quote, which is up to a
    tick (~70 s) old by then and was itself a card price up to 20 s old; and a
    market order takes whatever the book gives. Two fixes are proposed — refuse
    an entry whose price has already run more than a cap since the decision
    (re-quote at placement), and send a marketable limit at the fresh quote plus
    the cap instead of a market order — and both get a SHADOW before any order
    path changes. TRADER_ENTRY_REQUOTE=shadow: at placement a fresh print is
    fetched CONCURRENTLY with the market order (no latency added), and the row
    `entry_requote` records the decision quote, the fresh quote, the drift and
    what the cap would have done; when the broker's basis arrives, the entry_fill
    row (written for every shadowed entry, even a same-price fill) adds the fill
    against the fresh quote and whether a marketable limit at quote + cap would
    have filled. experiments/entry_requote_score.js reads both. Off by default;
    nothing here changes an order. TRADER_ENTRY_REQUOTE_CAP_BPS (default 5).

## H48

Above `function _firstLockCfg(sym) {`

    ── FIRST LOCK (2026-10-04, default OFF) ─────────────────────────────────────
    TRADER_FIRST_LOCK="arm:lock" in PERCENT (e.g. "0.5:0.1"), stepped-floor mode only
    (TRADER_STEP_FLOOR > 0): a position that is up at least `arm` but has not reached
    its first whole step gets its stop raised to entry + `lock`; the stepped floor takes
    over at the first step, and a lock only ever rises. TRADER_FIRST_LOCK_SYMBOLS (comma
    list) restricts it; unset = every symbol this brain trades.
    WHY. The 1% step was tuned on a book that held 3x funds; on a 1x index ETF +1% is a
    large intraday move, so many dip-buys go up 0.5%, come back and end as losers. On the
    stable sleeve's six index ETFs (SPY QQQ IWM DIA SMH XLK) inside the armed engine design,
    "0.5:0.1" measured, net of live costs: the sleeve's win rate 62.9 -> 66.4% and its
    net per trade +0.022 -> +0.048% on the 13 recent windows, the account +2.7pp with the
    worst week -4.23 -> -3.99% and a lower mean drawdown; a stop exit became a small win
    81% of the time (65% before). The lock must clear the name's round-trip cost: on a 3x
    fund (~11 bp) a +0.1% lock is a net loser, so scope it with TRADER_FIRST_LOCK_SYMBOLS
    wherever the brain also trades leveraged funds.

## H49

Above `const _stopOrders = new Map();`

    PROTECTIVE-STOP REGISTRY (#3379). sym -> { id, px, qty, at } for the stop THIS
    engine last placed. The point: /iserver/account/orders does not reliably show
    a prior-session GTC stop once it fills (SMH, 2026-08-19 — placed 08-18, filled
    10:12, absent from the feed), so the fill reconciler cannot see the loss path
    it exists for. But the engine names these order ids itself at placement; with
    the id remembered — and PERSISTED, because a stop that outlives the process is
    exactly the case — the per-order status endpoint can answer "did my stop
    fill?" directly when a position vanishes.

## H50

Above `const _beStopAt = new Map();`

    #3413 BREAKEVEN RATCHET state: sym -> the stop level pinned at entry once the
    position has been up TRADER_BE_RATCHET. Never lowered while the position
    lives; cleared when it leaves the book. Persisted — the broker stop it
    mirrors is a GTC and outlives the process; even if this map is lost, the
    ratchet pass re-records a working stop it finds at/above entry.

## H51

Above `function _isExitInFlight(status) {`

    An exit whose broker result is non-terminal: the order is resting, queued, or awaiting
    manual confirmation and has NOT reduced the position. While one is outstanding for a
    symbol we must not re-fire (or re-log) another exit for it — that manufactured the
    phantom "exit ×12 on one position, $46k of re-counted P&L" churn. A `placed` market
    fill / `error` / `dry_run` is terminal (position leaves the book, or nothing went out),
    so those do NOT freeze the symbol.

## H52

Above `const STATE_FILE = process.env.TRADER_STATE_FILE`

    ── Persist the trailing state across restarts ──────────────────────────────────
    The high-water mark (_peak) and the per-symbol timers live in memory. Without
    persistence a server restart RESETS every position's peak to its price at boot,
    so the trailing stop silently measures from a lower peak and lets a winner give
    back a full leg before firing (the SOXS "+35% peak → gave back $3k, no exit" bug —
    the box had been restarted repeatedly). Snapshot to disk each scan; reload at boot.

## H53

Above `function _reconcileFills(orders) {`

    RECONCILE THE LEDGER AGAINST BROKER FILLS.

    Exits used to be written at order-PLACEMENT time from the position's last
    MARK, which was wrong in both directions every session 2026-08-05..07:
    stop-outs understated 30-60% (XLK -$319 logged vs -$641 filled), and an exit
    order that never filled still logged as a completed exit (QQQ logged twice,
    +$453 vs +$217 real). This makes the broker the source of truth — a row is
    written when, and only when, a sell actually filled, priced at the fill.

## H54

Above `if (_isStopFill && _beStopAt.has(row.symbol) && Number(row.exit) >= Number(row.entry) * 0.998) row.b`

    #3413: a fill of a RATCHETED stop (sitting at entry after the position
    was up TRADER_BE_RATCHET) is a round trip, not a thesis failure — mark
    the row so review/analytics can tell the two apart.
    A ratchet round trip is a stop that FILLED at or above entry. The map alone is not proof:
    a stale entry from an earlier position labeled a real -2.87% stop-out as be_ratchet on
    2026-09-03 (SOXS, -3,328), so it fed neither the cooldown nor the breaker.

## H55

Above `_lastPos.delete(row.symbol); _absentStreak.delete(row.symbol);`

    The position left the book at this fill (race, SQQQ 2026-09-21): drop it from the
    last-positions map HERE, not in the sweep. On an empty book the sweep is deferred by
    the trust guard, and a fill-closed symbol left in the map is a phantom — it journals
    "sweep deferred" every scan and is reconstructed at a stale mark, on top of this row,
    the next time the book holds anything.

## H56

Above `_peak.delete(row.symbol); _trough.delete(row.symbol);`

    THE GHOST-PEAK LEAK (live 2026-08-31). This path — a feed-visible broker
    fill, the road most protective stops travel — cleared intent/excursion
    but left _peak/_trough/_entryAt/_holdClockAt alive. Every OTHER exit path
    deletes them; this one leaked, so SOXL's Friday peak survived two stop
    fills and a weekend and Monday's re-entry was trail-cut against it. The
    position left the book at this fill: all per-position state dies with it.
    (Entry placement also resets _peak/_trough now — belt and suspenders.)

## H57

Above `exitFailures: Object.fromEntries(_exitFailures),`

    The unclosable freeze must survive a restart. exitStatus was persisted but
    its two companions were not, so every restart reset the failure count to 0,
    cleared the freeze, and let a structurally-unclosable position re-attempt its
    exit 3 more times and re-log exit_frozen (the 0.8-share SOXS dust did this
    after each restart on 2026-08-03). Released as before the moment the position
    leaves the book — see the reconcile loop, which deletes both.

## H58

Above `const PIN_FILE = process.env.TRADER_PIN_FILE`

    Falling-knife filter for ENTRIES. The autopilot buys mean-reversion dips (support
    / oversold RSI), which is right in theory but catches knives when down-momentum is
    still accelerating. Returns true when the recent trend is CRATERING — MACD histogram
    negative AND still falling (this bar more negative than the last) — i.e. don't buy
    yet; wait for the histogram to turn up (decelerating), even if still negative. A
    histogram that is rising (turning) passes: that's the stabilization we want to buy.
    Pure + testable; fail-open (insufficient data → NOT a knife, don't block entries).

    OPERATOR HOLD PIN (#3318). "Keep GLD" was not expressible: the operator
    trimmed the carry to GLD-only pre-open 2026-08-14 and the engine
    signal-exited it nine minutes into the session. A pinned symbol keeps every
    PROTECTIVE mechanism — stop, ladder banking, breaker — but signal-derived
    exits (signal_exit, momentum_died) are suppressed with an honest skip row.
    Sources, unioned: TRADER_PIN env (SYM1,SYM2) and pins.json next to the trade
    ledger ({"pins":["GLD"]}) — the file is re-read (2s mtime cache) so a pin
    works MID-SESSION without a restart, and a UI toggle can write it later.

## H59

Above `function snapshotForeignRows(rows, isKnown) {`

    How many held rows in a position snapshot does this engine have NO state for?
    Pure so the 2026-08-19 flap is replayable in a test. `isKnown` receives the
    uppercased symbol. (#3378)

## H60

Above `function knifeReading(closes) {`

    The knife READING, not just its verdict — { hist, prev, fires } or null.

    Split out so the skip row can record the two numbers the gate actually
    decided on. Reconstructing them afterwards does not work: an offline replay
    against the stored 5m corpus reproduces `hist < 0` on 91% of recorded fires
    but `hist < prev` on only 72%, because the engine decides on bars fetched
    live at scan time and a one-bar offset flips a difference between two
    adjacent MACD reads. 70% fidelity is not enough to ask anything — a model
    shown the reconstruction correctly objected that the rule's own premise was
    unmet on 11 of 47 fires, which is a harness defect wearing the costume of a
    finding. Recording beats rebuilding.

## H61

Above `function _entryConfirmRead(bars, n, nowMs, shape = false) {`

    REVERSAL CONFIRMATION read (TRADER_ENTRY_CONFIRM). Pure: bars in (the
    momentum-tf series parseBars emits, multi-day), the required run length, and
    the wall-clock instant; verdict out. Filters to TODAY'S regular session in ET
    before judging, because the question is whether THIS washout has turned — a
    close from yesterday's tape cannot confirm it.
      n=1  the last close is above the one before it
      n=2  the lab's T2: two rising closes AND no lower low between them

## H62

Above `if (shape && sess.length >= 4) {`

    ── V-BOTTOM FAST-TRACK (shape mode): a capitulation bar (range >= 1.5x the
       average of the ~6 bars before it) followed by ONE strong reclaim bar
       (rising, bar-IBS >= 0.6, close back above half the capitulation range,
       no new low) confirms immediately — a true V announces itself, and the
       second rising close the base read waits for is where the move went. ──

## H63

Above `function trailTriggerPct(peakGainPct, base) {`

    Ratcheting trailing-stop distance: the more a winner has run, the TIGHTER we
    protect it. A position up +35% at its peak shouldn't be allowed to give back a
    flat 3% (≈a third of a leg) before exiting — lock big gains close. Returns the
    %-drop-from-peak that triggers the exit, always ≤ the base.

## H64

Above `const _QTY_RESERVED_RE = /insufficient (qty|quantity)|qty_available|held_for_orders/i;`

    AN EXIT REFUSED FOR RESERVED SHARES IS RETRIED, NOT ABANDONED (2026-10-24, week-1 review).
    cancelRestingStops settles (#3407) until the cancelled stop leaves the working book, yet
    Alpaca can still refuse the sell that follows -- "insufficient qty available for order
    (requested: N, available: 0)" -- because the shares are released a beat after the order
    reads cancelled. Fifteen refusals 10-02..10-23, mostly in the 15:50-15:55 window where the
    sale has to happen: on 10-22 the SOXS de-carry was refused and the 3x position rode the
    night unintended; on 10-23 all three close-IBS max-hold sells were refused and left only at
    15:59 through the weekend flat. Two things made each refusal worse than a lost minute:
      - the caller treated it like a placed order: closeLong dropped the entry and hold clocks
        (the next scan re-adopted the max-hold clock at zero -> a close-IBS position would have
        been held a whole extra session) and stamped _exitAt, so exitReattemptMs (8 min)
        blocked the retry;
      - the same scan deleted heldQty, so the entry loop could have re-bought the symbol.
    The refusal means the broker created NO order, so a retry cannot double-sell: wait, re-run
    the cancel (idempotent), sell again -- bounded, so the close can never hang. Only this
    explicit refusal is retried; a timeout or any other error keeps the old path, because an
    order may exist behind it.

## H65

Above `function _keepOpenAfterReservedReject(sym, qty, hp, reason, r, retries, refPrice, out, now, extraExe`

    Still refused after the retries: nothing rests at the broker and the position is still held.
    Keep every per-position clock (entry, hold, peak, trough) so max-hold keeps counting from the
    real entry; leave _exitAt unset so the next scan may retry at once. _exitStatus 'error' still
    feeds the MAX_EXIT_FAILURES backoff, and the next pass re-protects the shares the cancel
    left stopless (as before).

## H66

Above `if (Number(qty) >= 1) qty = Math.floor(Number(qty));`

    WHOLE-SHARE EXITS (2026-08-10, dust re-entry companion). IBKR CPAPI rejects
    fractional sells on these ETFs (the 0.8-share SOXS lesson). A position of
    300.8 must sell 300 and leave the inert sub-share tail — otherwise the
    whole exit is rejected and the symbol re-strands. Sub-1 positions keep
    their raw qty (nothing to floor to) and stay the unclosable-freeze's job.

## H67

Above `const order = (extended && refPrice > 0)`

    Regular hours: a market SELL closes instantly. Pre/post market: IBKR rejects market
    orders outside RTH, so use a marketable LIMIT (≈0.2% below the last print, to cross
    the wider extended-hours spread) with outsideRTH=true so the exit still fills.
    acceptWarnings: this is the engine's PRIMARY exit path (take-profit, max-loss,
    momentum-died, trailing stop, signal exit). It only ever SELLS an existing long,
    so it strictly reduces risk — an IBKR warning must not leave it unfilled.

## H68

Above `const _gate = _passSellGate() || await _sellGate(bridge, userId);`

    CANCEL THE RESTING STOP **BEFORE** SELLING (2026-08-10, QQQ 9:33 incident).
    Sell-first left both the protective stop AND the market sell open at the
    broker for a beat — IBKR's oversell protection saw 2x the held quantity in
    sells and CANCELLED the market exit (QQQ order 1119264656: Cancelled, 0
    filled; XLK/IWM merely won the same race). Cancel-first closes that window;
    if the sell then errors, the fast-exit tick re-attaches the missing stop
    within seconds, so the position is never left unprotected for long.

    Unless orders cannot go out (review H1): then nothing can re-attach it either.
    Leave the position, its stop and its exit state exactly as they are.

## H69

Above `async function manageHeldExits({ bridge, userId, heldPos, heldQty, c, now, out, extended = false, wo`

    Exit held LONGS on their own merits every scan — independent of whether a new
    scan signal fired — so a winner that peaks and fades doesn't round-trip:
      1. take-profit  — close at a hard +% target (off by default).
      2. trailing stop — once up ≥ trailArmPct, close if price falls trailPct from the PEAK.
      3. momentum death — while in profit, close when the trend rolls over: MACD histogram
         negative AND price below its short EMA (and RSI no longer strong). Catches "the
         momentum is dying / about to die" before the full bearish signal would fire.
    Closed symbols are removed from `heldQty` so the entry loop doesn't re-touch them.

## H70

Above `if (!extended && _deferredExit.size) {`

    SUB-SHARE DUST NEVER EXITS (2026-08-10). A fractional-only order can never
    fill on this API — the 0.8-share SOXS split remnant sprayed 3 error orders
    at IBKR after EVERY restart (the failure-freeze is per-process-lifecycle in
    practice). Skip by construction: qty < 1 = unfillable, full stop. Real
    fractional positions ≥1 share still exit via the whole-share floor.
    DELIBERATELY UNFILTERED (#3378). An early draft gated this on engine state,
    which broke the max-loss backstop for any position whose bookkeeping was
    lost (a restart with a stale state file would have left a -10% loser
    unmanaged for two scans). Safety exits run on whatever the account truly
    holds; the foreign-book problem this draft chased is handled UPSTREAM — the
    bridge account pin refuses the wrong account's book outright, and the
    foreign-snapshot tell stands the whole scan down before this function runs.
    FLUSH DEFERRED EXITS at the first regular-hours scan, BEFORE any other exit rule,
    so an overnight decision is honoured at the open rather than re-derived from the new
    session (which would let a position that gapped up sail past a trail it had already
    breached).

## H71

Above `const _exitAtBackstop = _exitAt.get(sym) || 0;`

    0) HARD MAX-LOSS BACKSTOP — market-exit a long down ≥ maxLossPct, regardless of
       momentum, peak, OR min-hold. This is the safety net for a loser whose broker
       protective stop never placed/filled (missing stop, gap-down through it): without
       it the ONLY loss protection is the entry STP, so an unprotected position runs
       unbounded (the -17% case). Still honors the exit-reattempt debounce so a still-
       unfilled exit isn't re-fired every scan.

       REGULAR HOURS ONLY (TRADER_MAX_LOSS_RTH_ONLY=1, off unless set; operator 2026-11-05). At 04:12 ET
       that day this rule sold C's 60 SOXL at 60.14 against a 65.36 entry, -$313: on a 3x wrapper -8 % is a
       2.67 % move in the 1x. The replay has no extended-hours sale, so no number the design was chosen on
       includes one. Against the replay over 2016-2026, on the proxies' extended bars (ledger row
       tier0-loss-cap-in-extended-hours-2016-2026, 17-20 touches, static, paper fills), that sale costs
       $5.4k-9.4k, Sharpe 2.28-2.31 against 2.37, older worst week -1.80 to -1.81 against -1.77, and the
       replay beats it on 94-95 % of touches.
       With the switch on, outside regular hours the cap places nothing, leaves the stop alone and journals
       a max_loss_held row. The first regular-hours pass reads the price of that moment, so a position back
       above the cap stays held. This is NOT a deferral: deciding now and filling at the open was measured
       for this rule and refused (older worst week -1.86). The rest of this pass runs as for any position.
       The risk this accepts, plainly: nothing sells in the dark. The resting stop first fires on the opening
       print (GAPPED STOP, in _runAutoTradeInner), so a real overnight collapse is met at the open. SOXL on
       2020-03-12 is the case: -19.2 % through the stop against -11.7 % sold at 04:00, +$440, the one clear save.

## H72

Above `const _lad = c.zoneExit ? _zoneLadder.get(sym) : null;`

    ── ZONE-LADDER EXIT (#3165) — OOS-validated for SPY/QQQ-class names ──────────
    Sell at R1 (first resistance above entry) unless price broke THROUGH the zone —
    then hold for R2 with the floor ratcheted to R1. While the ladder owns a symbol
    the generic exits below (take-profit/trail/momentum) are skipped; the broker
    protective stop and the max-loss backstop above still guard the downside.
    Live-price approximation of the sim's close-through: mark > zone TOP.

## H73

Above `const _passInFlight = new Map();   // account key -> promise of the pass running on it`

    ONE PASS PER ACCOUNT AT A TIME (review M1, 2026-09-29). The scan loop and the
    fast-exit loop each guarded only against themselves, so both could be inside one
    account at once: each read the same book, decided the same exit and sent its own
    full-size sell, and the second sell opens a short. A scan waits for a fast tick in
    flight on its account (price-only, a few broker calls). A fast tick that finds its
    account busy skips its turn, because the pass it would race runs the same exits.
    The wait is bounded, so one hung broker call cannot stall the account for good.

## H74

Above `async function fastExitTick(opts = {}) {`

    PRICE-ONLY exit tick (#3165 "fast exit loop") — runs BETWEEN full scans so the
    ladder / trailing / max-loss exits react in seconds, not the 60s scan cadence
    (operator: a near-miss of R1 with dying momentum must exit near the peak, not a
    minute later). Deliberately fetches NO bars and skips the momentum-death read —
    everything here needs only the broker's live mark, so the added API cost is one
    positions + one open-orders call per tick against the LOCAL gateway. All the
    anti-churn gates (min-hold, exit debounce, oversell guard) apply unchanged.

## H75

Above `let _exitAuthorityWarned = false;`

    Execute the ENTER verdicts from a scan against the user's IBKR account.
    @param {object} scan   result of traderAgent.scanMarket() — { signals: [...] }
    @param {object} deps   { bridge, userId, now?, caps? }
    @returns {Promise<{executed:Array, skipped:Array, enabled:boolean, reason?:string}>}


    EXTENDED-HOURS PROTECTIVE MODE (`protectiveOnly`, 2026-08-12).

    Between 16:00 and 09:30 the scan loop is idle, so a winner's trailing floor is
    never evaluated: on 2026-08-12 SOXS sat at +$3,617 exactly on its R2 target,
    riding a trail that could not ratchet, and gave back into the after-hours
    session with nothing but the -3% GTC stop underneath it. 17.5 hours of every
    weekday the book was unmanaged.

    This mode runs the loop in pre/after-hours for MANAGEMENT ONLY:
      - NO entries. IBS is a position-within-session-range signal and the extended
        session has almost no range, so the signal is undefined there, and nothing
        in the lab covers extended-hours entries.
      - Only PRICE-THRESHOLD exits: r2_trail, zone floors, peak_giveback,
        trailing_stop, targets, max_loss. Each protects a gain or caps a loss at a
        level decided during regular hours. (TRADER_MAX_LOSS_RTH_ONLY=1 takes max_loss
        out of this list; off unless set.)
      - NO signal-derived exits (momentum_died, the bearish signal_exit): a read
        computed off three thin pre-market bars is noise, and acting on it would
        dump a six-figure position into a wide spread.

    Orders still route as marketable LIMIT + outsideRth (closeLong's `extended`
    path), never naked market orders into a thin book.

    EXIT AUTHORITY (round-7 lab, 2026-08-23). The validated exit is the BOUNCE:
    sell at session IBS >= TRADER_IBS_EXIT (+ floor / trail / stop). Three older
    exits sit in front of it on this path and pre-empt it whenever they are on:
      - the zone ladder (armed for EVERY entry since #3285; "zone ladder owns this
        exit" blocked the bounce 305 times on live 8/10-8/21): an R1 target at the
        zone or +3% with a give-back floor. round7_lab: ladder-owned exits earn
        462% vs 1,494% on the 26y holdout (return/DD 26 vs 89) - ANY +3% target
        clips the tail the bounce sells into.
      - take_profit_R (default 1R = +3%) - the same clip, one layer down.
      - momentum_died - a MACD read no lab has validated.
      - exitMinPwin (0.6) - a legacy "bearishness" confidence that has nothing to
        say about a bounce ("bearish too weak to exit" blocked 51 times).
    The validated structure needs all four out of the way:
      TRADER_ZONE_EXIT=0 TRADER_TAKE_PROFIT_R=0 TRADER_MOMENTUM_EXIT=0 TRADER_EXIT_MIN_PWIN=0
    This does not change behaviour; it journals ONE config_warning row per process
    when the bounce gate is armed while something still pre-empts it, so the
    ledger shows the exit structure that is actually running.

## H76

Above `function _regimeFirst30Read(bars, todayStr) {`

    SLOT PRIORITY (round-7 lab, 2026-08-23). When more names fire in one scan
    than slots remain, the ADMISSION ORDER decides which get in - and with the
    hourly decision windows (#3435) several names routinely fire in the same
    minute on market-wide washout days, the paydays. round7_lab F, 26y holdout:
    arbitrary order 643%, shallowest-first 910%, deepest IBS first 1,494%,
    highest tilt weight then deepest IBS 2,866% (return/DD 129 vs 89; recent
    year 44.6% vs 31.5%) - fit winner, holdout confirms. The scan's own order is
    the legacy confidence score, which is arbitrary with respect to expectancy.
    TRADER_SLOT_ORDER: unset/confidence = the scan's order (current behaviour);
    depth = deepest session IBS first; expectancy = highest TRADER_SYMBOL_SIZE_MULT
    weight first, deepest IBS as the tie-break. Pure; never drops a candidate.
    REGIME SIZING read: SPY's close position within its first-30m range (09:30-
    09:59 ET) — the day-type read the sizing dial keys on. Known by 10:00, no
    lookahead. Pure; bars are parseBars rows ({timestamp, high, low, close});
    returns r30 in [0,1], or null under 3 first-30m bars / a flat range.

## H77

Above `let _trendShadow = null;`

    TREND-DAY SHADOW (2026-09-30). The book buys washouts, so a session that rallies with no dip
    gives it nothing (SOXL 2026-09-22: +10.4% from the opening print). A second rule was measured
    for those days and holds on SOXL through the replay engine (+0.20% / +0.18% per entry on the 13
    scored windows / 30 unseen quarters); lib/trend-shadow.js journals what it would do at live
    prices before anyone arms it. Enabled by TRADER_TREND_SHADOW=SOXL. One instance per process,
    kicked by every pass and never awaited, so no trade waits on it; its rows carry the user
    'trend-shadow', which keeps them out of every account's journal, P&L and demo feed.

## H78

Above `let _noiseShadow = null;`

    NOISE-AREA SHADOW (2026-10-01). The trend-following leg for rally AND drop days: the intraday
    momentum rule of Zarattini, Aziz and Barbon (2024) on SPY / QQQ / SMH, traded through the 3x
    wrappers (lib/trend-shadow.js createNoiseShadow). Same contract as the trend shadow: journal only,
    never awaited, rows under the user 'noise-shadow'. Enabled by
    TRADER_NOISE_SHADOW=SPY:UPRO:SPXS,QQQ:TQQQ:SQQQ,SMH:SOXL:SOXS (proxy:long wrapper:inverse wrapper).

## H79

Above `let _riseShadow = null;`

    AFTER-THE-RISE SHADOW (2026-10-30). The one open hint of the 10-29 pullback research: the stable design's entries
    made the session after their name rose big (prior close-to-close >= 1.5 trailing sds) lost money on the recent
    windows and not on the older quarters. lib/rise-shadow.js tags every live entry with that reading, plus one check
    row a session, so the live record can say whether it is real. Enabled by TRADER_RISE_SHADOW=1. Same contract as the
    other shadows: journal only, never awaited, rows under the user 'rise-shadow'.

## H80

Above `const _knobOn = (k) => ['1', 'true', 'on'].includes(String(process.env[k] || '').trim().toLowerCase(`

    MARKET-CONTEXT TAGS (2026-11-02). lib/entry-tags.js writes one entry_tags row for every live entry: the prior
    session's dealer gamma (SqueezeMetrics GEX tercile), the news intensity (Benzinga overnight and session rates,
    terciles) and the VIX change at the entry (QUIET / MILD / FEAR), measured as the 11-01 research measured them, so the
    live record can score them (ledger live-both-gamma-news-vix-tags-2026-11). Enabled by TRADER_ENTRY_TAGS=1; both boxes
    point TRADER_ENTRY_TAGS_DIR at one directory, and only the process with TRADER_ENTRY_TAGS_NEWS_FETCH=1 (the engine)
    refreshes the news counts with the Alpaca server keys — a box that merely HOLDS keys never calls (stable's env carries
    the engine's own keys). Same contract as the shadows: journal only, never awaited, rows under the user 'entry-tags'.
    The knobs and the keys are read here, synchronously, while this sleeve's env is the process env (the engine swaps env
    per sleeve).

## H81

Above `function planEntry(entry, signal, scan) {`

    A TRADE PLAN ON EVERY ENTRY (2026-11-08). lib/trade-plan.js writes one trade_plan row after every placed entry: the thesis
    (the sleeve's signal, its own reading, the entry tags' context read from the shared files), the expected move by the planned
    exit, the sleeve's exit rules as configured, and the in-between checkpoints with the levels a time/progress rule would read.
    The in-between action is HOLD (ledger plan-tier0-in-between-time-progress-2010-2026: no such rule passed its static test),
    so the plan is journaled to be scored forward and acts on nothing. Enabled by TRADER_TRADE_PLAN=shadow. Same
    contract as the tags: journal only, never awaited, rows under the user 'trade-plan'. The knobs are copied here,
    synchronously, while this sleeve's env is the process env (the engine swaps env per sleeve).

## H82

Above `const _fundOnly = new Set(_reserveFund().map((s) => String(s).toUpperCase()));`

    Position partitioning: symbols owned by ANOTHER engine (the overnight sleeve book)
    are completely off-limits — no exits, no re-protect stops, no signal-sells, no
    entries. Each engine manages only its own positions; the caller (trading.js)
    supplies the live exclusion set.
    THE RESERVE FUND (lib/reserve-fund.js, 2026-10-28) is excluded on every pass, whoever the caller, and is
    not open risk either: it is the cash the gross cap keeps, parked in a T-bill fund. `_fund` leaves it out of
    the concurrency cap, the correlated-risk buckets, the gross cap, slot_util and the re-protect guard.
    THE OVERNIGHT BOOK (lib/overnight-book.js, 2026-10-28) owns its names from its 15:55 buy until its morning sale
    has left the book. They join the partition too, with one difference: their notional DOES count toward the gross
    cap (the book buys only into the room the cap leaves, so the two together keep the operator's cash floor).

## H83

Above `if (!_positionsOk) { out.reason = 'positions unavailable — standing down this scan (never trade blin`

    NEVER TRADE BLIND. Without a readable book the engine sees no holdings, so the
    entry loop's `already long` guard cannot fire and it would happily re-buy a
    symbol it is already carrying. Same contract as the account fetch above: no
    broker truth, no orders. Exits are skipped too — the broker-side protective
    stops are what guard the book in this state.

## H84

Above `const _ourSyms = new Set([`

    Snapshot every long we can still see, so a position that VANISHES before the next
    scan can be reconstructed into the ledger (see the external-close sweep below).
    OWNERSHIP FILTER (2026-08-13). heldPos is EVERY position in the account,
    including other books' (champion holds XMMO/SPMO, the overnight sleeve holds
    its own). Snapshotting them made the sweep below "reconstruct" their exits as
    ours: on 2026-08-13 it logged SPMO -$199 and XMMO -$107 into the day-trader's
    ledger. Only track symbols this engine actually scans — the scan's own signal
    set is that list — plus anything we already have engine state for (ladder /
    entry timestamp), so a position opened before a restart is still reconciled.

## H85

Above `const _stateful = _lastPos.has(k) || _entryAt.has(k) || _zoneLadder.has(k)`

    ADOPTION DWELL (#3378). Being in the watchlist is not proof a position is
    ours: a foreign snapshot put GLD/TLT rows — another book's lots, other
    cost bases — into heldPos and they were adopted on sight. A symbol with no
    engine state must be seen held on two consecutive snapshots before this
    engine tracks (and therefore later manages or books) it. Our own entries
    carry state and are tracked immediately; a manual buy in our account is
    adopted one scan later than before.

## H86

Above `{`

    POSITION DRIFT (#3432). SPY grew 75 -> 76 -> 77 -> 78 on three consecutive
    opens (2026-08-18..20) with no entry row in any ledger: something outside
    this engine's order path was buying one share at a time, and nothing
    noticed until the stop-size reconciliation complained. A held quantity
    that changes between scans with no engine order in the last 10 minutes is
    journaled here with both quantities and the broker orders the feed shows
    for the symbol — the evidence the investigation was missing. Journal-only.

## H87

Above `const _ordersEarly = await bridge.getIBKROpenOrders(userId).catch(() => []);`

    ── External-close sweep: THE LOSS PATH ────────────────────────────────────────
    Broker orders are fetched HERE (before the reconstruct loop) because the
    fill-based reconciliation must run first: a real fill is authoritative and
    the reconstruct loop below must yield to it rather than logging a second,
    mark-priced row for the same exit.

## H88

Above `const _sellExclude = new Set([...exclude, ...(_filledSyms || [])]);`

    SAME-SCAN FILL GUARD (2026-10-16). heldPos/heldQty are a START-of-scan snapshot, and IBKR's positions endpoint
    lags its orders feed: a sell this scan's orders read shows FILLED can still look held. Every pass below that sends
    a SELL for a held position (stop-size reconciliation, the ratchet, the gap auction, re-protect, held exits) skips
    those symbols for this scan. Live on stable: XLE's step-floor stop (2,628 @ 67.37) filled at 09:40:48; the 09:42:03
    scan booked that fill, still read 2,628 held, raised a NEW 2,628-share stop at the same level (stop_was null: a
    filled order is not a working one) and it filled at 09:42:06 — the account went SHORT 2,628 XLE. The next scan
    re-reads the book; a genuine remainder (a partial fill) gets its stop then, one scan later — the trade the
    empty-orders guard below already makes (one naked scan beats an oversell).

## H89

Above `for (const o of (_ordersEarly || [])) {`

    REGISTRY SEEDING (#3386). The #3379 registry only learns about stops the
    engine places AFTER it shipped — QQQ, carried since 08-14 with a GTC stop
    from a pre-registry process, stopped out on 2026-08-20 (-$1,718) and still
    booked closed_externally with stop_order_id:null. The broker's own open-
    orders book names those legacy stops, so adopt them: any WORKING sell-stop
    on a symbol we hold, absent from the registry, is one of ours (the #3378
    account pin guarantees this feed is our account). Seeded entries carry
    seeded:true so a later audit can tell adoption from placement.

## H90

Above `const _vanished = [..._lastPos.keys()].filter((k) => !(Number(heldQty[k]) > 0));`

    Only a symbol the autopilot itself decided to exit was ever reconciled below, so
    a position closed by anything ELSE left no ledger row at all. The dominant such
    path is the resting protective STOP filling — i.e. every stop-out, i.e. the
    losses. Wins exit by an autopilot decision and get logged; losses exit at the
    broker and did not. That asymmetry is why the scorecard read 100% win rate.

    So: any symbol we last saw held that is now off the book, with no CONFIRMED exit
    of our own, is logged as a reconstructed exit. The P&L is computed from the last
    observed mark, NOT a broker fill (the facade exposes no fills API) — so the row
    is marked status:'reconstructed' + estimated:true and is deliberately excluded
    from the scorecard's `confirmed` view. An estimate that is labelled beats a loss
    that is silently dropped.
    TRUST GUARD (2026-08-13). This sweep infers "closed" from ABSENCE, so it is
    only as sound as the snapshot. Two ways the snapshot lies:
      (a) the fetch failed — now null, never an empty array;
      (b) IBKR returned an EMPTY/partial book at the open. Observed live on
          2026-08-13 09:30: every tracked position vanished for one cycle and the
          sweep invented four exits (SOXS double-counted at +$4,174 on top of its
          real +$2,740 fill; SQQQ "closed" while 1,566 shares were still held),
          inflating the day's ledger to +$7,305 against a broker equity that had
          FALLEN $4,634.
    Absence is only evidence of a close when we can see the rest of the book. A
    genuine simultaneous multi-symbol external close is vanishingly rare — real
    stop fills arrive through _reconcileFills, which runs first and marks them.

## H91

Above `const _knownSym = (k) => _lastPos.has(k) || _entryAt.has(k) || _zoneLadder.has(k)`

    FOREIGN-BOOK TELL (#3378, live 2026-08-19 17:26 ET). During IBKR's daily
    maintenance the gateway re-resolved "first discovered" and served the
    OVERNIGHT book — 7 rows including an options leg — to this engine for two
    minutes. The 2026-08-13 heuristic below (vanished>=3 && vanished>rows)
    missed it because the alien snapshot was BIG: 3 vanished against 7 rows.
    The tell that survives both shapes: several tracked positions gone WHILE
    several rows appear that this engine has no state for. A legit mass
    stop-out has only the first half; a legitimately growing book only the
    second.

## H92

Above `out.skipped.push({ symbol: '*', why: 'foreign snapshot: ${_vanished.length} tracked position(s) abse`

    The FOREIGN shape is the only suspect flavor where NOTHING in the snapshot
    can be trusted — not the sweep, not 'already long', not the exit loops
    (this is the scan that tried to trailing-stop XMMO, a position this engine
    never owned). Stand the whole scan down, same contract as a failed fetch.
    Real fills were already reconciled above (they come from orders, not this
    snapshot); broker-side protective stops keep guarding the real book. The
    OTHER suspect flavors (empty book, mass-vanish) keep their 2026-08-13
    behavior — sweep deferred, scan continues — because an empty-but-honest
    book must still clear exit freezes and manage what remains.

## H93

Above `if (_exitStatus.has(sym) || (_filledSyms && _filledSyms.has(sym))) {`

    An absence that is EXPLAINED needs no second read and no reconstruction:
    our own exit already produced a row (this must catch every status — an
    exit logged as needs_confirmation/dry_run is still a row, and
    reconstructing on top of one produced two rows for one SHOP position),
    and a broker fill reconciled this cycle is authoritative and priced at
    the fill (reconstructing over it is the QQQ double-count of 2026-08-07).
    Acknowledge these immediately, exactly as before #3378.

## H94

Above `const _miss = (_absentStreak.get(sym) || 0) + 1;`

    TWO CONSECUTIVE ABSENCES (#3378) — for the INFERENCE path only. One
    missing read is a data point, not a close: single-read absences booked
    three still-held positions as closed on 2026-08-19. A real stop-out still
    books — one scan later — which delays the post-stop cooldown by that same
    scan and changes nothing else.

## H95

Above `const _regStop = _stopOrders.get(sym);`

    ── STOP RECONCILIATION (#3379) ──────────────────────────────────────────
    Before inventing a mark-priced reconstruction, ask the broker about the
    stop THIS ENGINE placed for the symbol. The orders feed does not reliably
    list a prior-session GTC stop once it fills (SMH 2026-08-19: placed 08-18,
    filled 10:12 at 560.79, never in the feed), but the per-order status
    endpoint answers for any id we can name — and we named this one. A hit
    books a REAL stop exit, priced at the fill: stops_fired counts it, the
    cooldown and breaker arm on it, and the row carries the order id instead
    of a guess. Anything else falls through to the honest reconstruction.

## H96

Above `...(_regStatus.filledAt ? { ts: _regStatus.filledAt, discovered_at: new Date().toISOString() } : {})`

    The trade CLOSED when the broker filled the stop, not when this sweep
    discovered it — a fill recovered after downtime must carry the broker's
    clock or the journal misdates it by days (#3660 C: IWM filled Wed,
    booked "Fri 11:27 AM" = the next boot). logTrade lets a provided ts
    win; discovered_at keeps the booking moment observable.

## H97

Above `const _attribFrac = _stopAttribFrac();`

    ── STOP ATTRIBUTION (#3281) ─────────────────────────────────────────────
    The tail-defense counters — the per-symbol re-entry cooldown and the daily
    circuit breaker — armed ONLY in _reconcileFills, which needs a broker stop
    fill it can see. A stop-out that surfaces here instead, as an absence, armed
    nothing. Live 2026-08-13: SQQQ stopped out at 10:29:35 for -$1,674.06 and was
    re-entered at 10:29:38 — three seconds — and the day ended with
    stopCooldownThrough {} and stopFills {day:null,count:0} after a real stop
    fired. Both defenses were inert all session.

    We cannot KNOW this was the stop; the reason string says so ("protective
    stop, manual close, or another engine"). But a position that left the book
    having given up essentially its whole stop distance is a stop-out for every
    purpose these two counters exist to serve, whoever pulled the trigger.
    SQQQ left at -2.88% against a 3% stop — 96% of the distance.

    Deliberately asymmetric: arming costs one symbol one day of re-entry, while
    NOT arming costs an immediate re-entry into the position that just stopped.

## H98

Above `let _openOrders = _ordersEarly;`

    Fetch the account's working orders ONCE. Two uses: (1) re-protect naked longs, and
    (2) the OVERSELL GUARD — a Set of symbols that already have a resting NON-stop SELL
    (an exit/cover order that hasn't filled, common in thin extended hours). We never
    stack another sell on those, so a lagging position snapshot can't make the loop sell
    `held` again and blow through flat into a short. Survives restarts (broker-side state),
    unlike the in-memory cooldown. Excludes protective STP sells (every long has one).

## H99

Above `for (const sym of [..._exitStatus.keys()]) {`

    ── Re-exit reconciliation (kills the phantom-exit churn) ──────────────────────
    Reconcile the frozen-exit set against broker truth, every scan:
     • A symbol we're no longer holding has left the book — its exit filled (or it's
       flat). Clear ALL of its per-symbol state so a legitimate future re-entry starts
       clean and can be exited again.
     • A symbol with an exit order still IN FLIGHT (needs_confirmation / resting /
       unfilled) is added to workingSells, so BOTH exit paths (momentum/trailing and
       signal) skip it. This is what stops one un-filled exit from re-firing every ~8
       min and re-logging its unrealized P&L as realized (69 exit rows / 12 real
       positions, a fabricated $46k → the actual ~$5k, all still needs_confirmation).

## H100

Above `const _sellAlive = (_openOrders || []).some((o) =>`

    FREEZE EXPIRY AGAINST BROKER TRUTH (2026-08-08). The in-flight freeze had
    no expiry and was never re-checked: a parked exit later cancelled/expired
    at the broker kept the symbol frozen from EVERY engine exit — including
    the max-loss backstop — until the position left the book. If no sell
    order for the symbol is alive at the broker in ANY resurrectable status
    (parked 'Inactive' counts as alive — a human can still confirm it) for
    two consecutive scans AND the re-fire debounce has passed, the exit is
    dead: release the freeze so the position can be managed again. Two misses
    are required so a fill racing this scan's positions snapshot can't
    unfreeze into a double-sell.

## H101

Above `const st = String(_exitStatus.get(sym) || '');`

    Position still held but the last exit was terminal-non-fill (error/dry_run).
    Clearing the freeze lets a genuine later exit retry — but an exit that keeps
    failing for a STRUCTURAL reason must not retry forever: on 2026-07-30 a
    0.8-share SOXS remnant (IBKR cannot trade fractional) re-decided every ~9
    minutes for 5.5 hours, producing 39 identical error rows and drowning the
    day's real activity. After MAX_EXIT_FAILURES consecutive terminal failures
    the symbol is declared unclosable: frozen from re-firing, logged ONCE, and
    released automatically the moment the position leaves the book (the branch
    above) or grows back to a tradable size.

## H102

Above `const _heldCount = Object.values(heldPos).filter((p) => (Number(p.qty) || 0) > 0 && _notFund(p)).len`

    EMPTY ORDERS != NO STOPS (2026-08-12). Every re-protect decision below reads
    ONE orders fetch. IBKR's CPAPI intermittently answers /iserver/account/orders
    with an empty array (cold endpoint, session re-auth, maintenance window) —
    and an empty list makes hasStop() false for EVERY symbol, so the pass
    concludes the whole book is naked and stacks a duplicate GTC stop on each
    position. That is precisely the mechanism behind the 2026-07-27 incident
    (488 resting stop-sells, 95,561 shares against 3,772 held). The correct
    reading of "no orders came back while positions exist" is UNKNOWN, not
    UNPROTECTED: skip the pass and re-check next scan (~60s), by which point
    the fetch has recovered. A genuinely naked position stays naked one extra
    scan; a duplicate stop is an oversell that can flip the account short.
    A truly empty book (no positions) is unambiguous and still passes through.
    The reserve fund carries no stop by design, so it is not a position that should have orders.

## H103

Above `const hasStop = (sym) => (_openOrders || []).some((o) =>`

    Status vocabulary: this guard originally matched only IBKR's NATIVE words
    (PreSubmitted/Submitted/Pending), but the normalized order shape the bridge and
    Alpaca return says 'open' / 'accepted' / 'new'. So hasStop() never matched, the
    engine believed every long was naked, and it added ANOTHER GTC stop every scan:
    measured 2026-07-27 — 488 resting stop-sells, ~33 per symbol, 95,561 shares
    against 3,772 held (a 25x oversell that would have gone short on any gap down).
    Also accept an orderType/type field on either key, since the normalized shape
    uses `type`.

## H104

Above `const REPROTECT_MAX_ATTEMPTS = 3;`

    ACCUMULATION CAP. A stop that never transmits (IBKR parks it 'Inactive' when an
    order warning goes unconfirmed) is not protection, so hasStop() correctly ignores
    it — but then this pass retries every scan forever: 2026-07-27 left 972 inert
    stop attempts, ~33 per symbol. Retry a bounded number of times, then stop adding
    and let the ledger show the failure instead of burying it under duplicates.

## H105

Above `const attemptsFor = (sym) => (_openOrders || []).filter((o) =>`

    COUNT ONLY FAILED placements (2026-08-10 stop-lifecycle hardening). This
    cap originally counted EVERY stop order for the symbol — including stops
    we ourselves cancelled during healthy exit cycles (cancel-first sell) and
    stops that FILLED. On 2026-08-10 each exit/retry cycle added a
    Cancelled-by-us row until attemptsFor hit 3, and re-protection was then
    refused for the rest of the session (149 're-protect capped' rows; IWM
    and SOXL ran naked-stop stretches during venue retry cycles). A stop we
    cancelled on purpose is lifecycle, not failure; only the parked/refused
    vocabulary (Inactive / needs_confirmation / rejected) marks a placement
    that never protected anything — the 972-order incident this cap exists
    for was exactly that shape, and it still trips the cap.

## H106

Above `const _stopQtyFor = (sym) => (_openOrders || [])`

    STOP-SIZE RECONCILIATION (2026-08-13). hasStop() asks "is there a stop?"
    but never "is it the RIGHT SIZE?". After a partial exit the original stop
    keeps its old quantity: live today GLD held 66 shares behind a 147-share
    stop. Had it triggered it would have sold 81 shares we do not own — an
    oversell opening an unintended SHORT, or (per IBKR's oversell protection,
    seen on the QQQ race this morning) an outright rejection leaving the
    position naked. Both unacceptable.

    A stop whose size does not match the position is not protection. Cancel it
    here; the pass below then places a correctly-sized one. The failure cap is
    untouched: a deliberate cancel is lifecycle, not a failed placement
    (2026-08-12 hardening).

## H107

Above `const _bePct = Number(process.env.TRADER_BE_RATCHET) || 0;`

    ── BREAKEVEN RATCHET (#3413 lab, 2026-08-22). Once a held long has been up
    TRADER_BE_RATCHET (fraction, e.g. 0.02), its protective stop rises to the
    entry price and never goes back down: the worst path a 2%-up position can
    take becomes a round trip instead of a full -3% loser. Validated on all
    four lab surfaces (hourly 2y halves + daily 26y two-window) with 5-10bp
    stop-fill slippage charged: loss metrics improve everywhere with total
    return kept (daily fit worst month -8.7% vs -10.3%, DD -19.2% vs -21.0%,
    total 274% vs 215%). The mechanism reuses the resize→re-protect path: we
    cancel the low stop here and pin the level; the re-protect pass below
    places the new stop AT entry with all its usual guards (attempt caps,
    whole-share, below-market clamp). DEFAULT OFF: unset/0 disables.

## H108

Above `const _beLock = Math.max(0, Number(process.env.TRADER_BE_LOCK) || 0);`

    TRADER_BE_LOCK (#3415 lab): the level the stop rises TO, as a fraction
    above entry (0 = breakeven, the #3414 default). The stop/trail lab
    validated a +1% PROFIT FLOOR (ratchet 0.01 + lock 0.01) on every surface
    with entry+exit slippage charged: daily fit 419% vs 87%, holdout 549% vs
    261%, drawdown roughly halved. With lock == ratchet the stop sits at the
    touch level and fills on the next downtick — effectively a take-profit.

## H109

Above `const _prevLock = Number(_beStopAt.get(sym)) || 0;`

    STEPPED FLOOR (#step, 2026-08-24 — operator: "if it's at 1%+ the exit
    should be 1%, if 2%+ it should be 2%, if 3%+ it should be 3%").
    TRADER_STEP_FLOOR = step size in PERCENT (1 = lock each whole percent);
    unset/0 keeps the flat one-shot lock. Measured on the four surfaces:
    step 1% beats the flat +1% floor on both holdouts (h2 49.7% ÷8.88 vs
    44.5% ÷7.57, 26y ÷161 vs ÷129) and — unlike the round-6 ratchet trail —
    it SURVIVES finer bars (5m: +0.4% vs −0.9%, smaller drawdown at every
    bar size), because it only moves at discrete levels rather than
    following the peak continuously. It also subsumes the generic trail.

## H110

Above `if (process.env.TRADER_GAP_STOP_TO_OPEN === '1' && extended && !_ordersUnknown) {`

    ── GAPPED STOP -> THE OPENING AUCTION (2026-10-15 cost audit, operator: "do the fixes"). A stop the
       pre-market already trades through fires on the opening print and fills as a market order in the
       first seconds AFTER it, under the official open (GDX 10-15: 84.62 vs the 84.78 open; five stable stops
       since 09-01 filled $1.0k under their opens). Inside the pre-open window the position goes to the
       auction itself: cancel the stop, send a market-on-open sell (tif OPG). If the auction order is
       refused, the stop goes straight back at its original level (the re-protect pass is the backstop).
       TRADER_GAP_STOP_TO_OPEN=1 arms it (default off); window _FROM/_TO in ET minutes, margin _MIN_BP. ──

## H111

Above `const _regPre = _stopOrders.get(sym);`

    STACKING GUARD (#3432). The orders FEED can go blind to a WORKING stop
    for hours: on 2026-08-17 this pass saw SPY and QQQ as naked on every
    scan and placed a fresh stop each time — fifteen deep (1,125 shares of
    stops on a 75-share position) by the 04:00 reconciliation. The per-
    order status endpoint answers for any id we can name (#3379), and we
    registered this one. A working answer means the feed is lying, not
    the position naked — do not stack another.

## H112

Above `if (stop && curPx > 0 && stop >= curPx) {`

    A sell-STOP must sit BELOW the market or the broker rejects it. For a position
    already underwater, the entry-based stop (entry×0.98) is ABOVE the current
    price — so re-protect would silently fail and the loser stays naked. Clamp the
    stop to just below the current price so an underwater long still gets a working
    protective stop that caps further downside. (The max-loss backstop in
    manageHeldExits is the harder floor if price is already past maxLossPct.)

## H113

Above `stop = _beLvl > 0`

    A RATCHETED level at/above the market (lock == ratchet, or price
    dipped back between the raise and this placement) must NOT take the
    underwater clamp — that would park the stop a full stopPct under the
    market and erase the lock. The lock was reached: sit 0.1% under the
    market, the broker-order analog of "sell on the next downtick" the
    lab validated (#3415).

## H114

Above `const _dayRaw = await bridge.getIBKRDayPnl(userId).catch(() => null);`

    Broker shape normalization: the IBKR bridge returns a NUMBER, but the Alpaca,
    house-paper, and demo facades return { dailyPnl, ... } objects — so the
    `typeof === 'number'` check silently never armed the breaker on any of those
    accounts (a -3% day kept opening fresh positions; audit 2026-08-08). Accept
    both shapes; anything else (fetch failure) still fails open by design.

## H115

Above `const record = { symbol: sym, direction: s.direction, p_win: s.convergence.p_win, news: s.news || nu`

    The skip row carries the EVIDENCE, not just the verdict (#3374 follow-up).
    Every gate below is judged on these numbers; recording them here is what
    makes "was that veto right?" answerable later without rebuilding the
    inputs from a bar corpus that disagrees with the engine 30% of the time.
    scan.js computes the bundle as part of producing the signal, so this is a
    spread, not a second calculation. Entry candidates only — exit-side skips
    never reach this loop, so the ledger does not grow for them.

## H116

Above `const _etNowMin = (() => { const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'Ame`

    OPENING FAST-PATH (2026-08-11). Two consecutive sessions showed the same
    structural miss: the biggest washout bounces happen 09:45-09:55 (SLV +3.7%
    and GLD +1.65% Mon; SOXL +2.72%, TQQQ +1.36% Tue) and the 2-scan
    persistence requirement systematically eats them — by the second scan the
    bounce is underway. During the opening window one scan suffices; every
    other gate (falling-knife veto, cap, cooldown, breaker, dust) still
    applies. TRADER_OPEN_FASTPATH=0 disables; window ends 10:00 ET.

## H117

Above `const _sIbs = _signalIbs(s);`

    (held >= 1, not > 0: a sub-share split remnant can never fill a sell on
    this API — same rule as manageHeldExits' dust guard, 2026-08-10.)
    Anti-churn gates on the signal-exit (the broker stop still protects the
    downside independently): (1) don't dump a long we just opened, (2) only
    exit on a STRONG bearish read, (3) require it to persist across scans.
    ── IBS THESIS GATE (fidelity lab, 2026-08-22). In IBS mode the read flips
       BULLISH→NEUTRAL the moment the session IBS rises above the entry
       threshold — i.e. the instant the washout starts to bounce — and that
       NEUTRAL read was selling winners ~50 minutes in for a median +0.09%
       (57 signal_exits 8/10–8/21, 36 inside ±0.2%; the analog on the same
       symbols/weeks earned ~9x by holding to the bounce). The validated exit
       is the BOUNCE: session IBS ≥ TRADER_IBS_EXIT (0.6). Until then the
       thesis is intact — the profit floor, stop and ladder protect; the
       signal does not sell. Off by default; a missing IBS reading falls
       through to the legacy behaviour.

## H118

Above `if (c.ibsExit > 0) {`

    ── SESSION-RANGE MATURITY (2026-08-24, the Monday morning liquidation).
       The gate above only holds a position when the IBS reading is FINITE.
       `sessionIbs()` returns null while `!(hi > lo)` — no regular-hours
       range yet — so in the first minutes of a session the gate fell
       through to the legacy exit; and with a range only cents wide the
       reading is hypersensitive (a two-cent uptick reads IBS 1.0). On
       2026-08-24 that dumped the whole overnight book in six signal_exits
       between 09:31 and 09:41, every one a loss, −$2,514 — and the ledger
       recorded ZERO "washout thesis intact" skips all day.
       Two guards, both entry-agnostic (stops, floor and trail untouched):
         a) a missing reading means HOLD, never sell (TRADER_EXIT_NEEDS_IBS=0 restores the old fallthrough)
         b) no signal exit until TRADER_EXIT_MIN_SESSION_MIN minutes into
            the regular session (default 30), by which time the range is
            wide enough for IBS to mean something.

## H119

Above `const { r, retries, reserved } = await _sellAfterCancel(bridge, userId, sym, exOrder);`

    #3660 A: CANCEL FIRST, SELL SECOND. cancelRestingStops already settles -- it
    waits (bounded, #3407) until the canceled stop leaves the working book, i.e.
    until the broker releases the reserved shares. This call site had the pair
    INVERTED: the market sell arrived while the resting stop still held the full
    qty, Alpaca rejected it every time, and the position could not leave the book
    (2026-09-18: four canceled TLT orders, an 8-minute retry loop, exit_frozen).
    Between cancel and sell the position is stopless for ~a second; a failed sell
    is re-protected by the next scan pass, exactly as before.

## H120

Above `const _heldMv = Math.abs(Number(heldPos[sym] && heldPos[sym].market_value)`

    ── BULLISH: open a long only if flat. Never pyramid; never sell. ──
    DUST DOES NOT BLOCK RE-ENTRY (2026-08-10). The 0.8-share SOXS remnant
    ($34, unclosable) made 'already long' permanent for its symbol — the slot
    fix excluded dust from the CAP but not from this gate, so SOXS's +2.7%
    washout this morning was unenterable. Same dust rule as the cap: a
    position below dustPct of equity is not a position. The new integer-qty
    entry merges with the remnant; exits floor to whole shares (closeLong),
    so the sub-share tail stays inert instead of re-stranding the symbol.

## H121

Above `{`

    UNEXPLAINED FLAT = FEED DROPOUT, NOT AN OPPORTUNITY (#3282).

    `already long` above trusts one position snapshot. On 2026-08-13 the feed
    dropped SOXS for two scans (11:13 held, 11:14 and 11:15 absent, 11:16 held)
    and wrote no exit row of any kind. In the gap this loop saw `held === 0`,
    treated SOXS as a fresh candidate, and opened a full-size tier-A+ entry on
    top of the 1,490 shares already there — 3,057.8 total, twice the intended
    maximum, behind a stop sized for part of it.

    A position genuinely leaving the book is EXPLAINED: our exit fills, or the
    external-close sweep reconstructs one. Either clears _lastConfirmedHold.
    A confirmed holding still sitting here means nothing explained the absence,
    so the flat reading is not evidence we can open against.

    Bounded by _flatConfirmMs so stale state can never bar a symbol forever.

## H122

Above `if (c.entryKnifeFilter) {`

    Falling-knife veto: don't buy the dip while down-momentum is still accelerating.
    Wait for the momentum to turn (histogram rising, even if negative).

    MEASURED 2026-08-19 (#3357). This was the highest-firing gate in the engine
    — 182 skips in a single session — and its only justification was the
    sentence above plus a "(#c)" placeholder that referenced nothing. It was
    also the gate most open to the objection that it fights the strategy: IBS
    mean-reversion BUYS washouts, and a washout is exactly where MACD is
    negative and deepening, so the veto looked like it might be filtering out
    the very edge it was meant to protect.

    Replaying 565 first-IBS fires over 29 sessions and 35 symbols (same-day
    close exit, 3% stop), evaluating this predicate on the closes available AT
    each fire:
        vetoed  n=312   47% WR   -0.038%/trade   -11.9% total
        allowed n=253   45% WR   +0.041%/trade   +10.4% total
    It earns its place: blocking those 312 avoided -11.9% of cumulative return.
    Note it does NOT pick winners — the hit rates are within 2pp — it avoids
    MAGNITUDE. The objection was wrong; waiting for the histogram to turn beats
    buying into the acceleration.

## H123

Above `if (c.entryConfirm > 0) {`

    ── REVERSAL CONFIRMATION (TRADER_ENTRY_CONFIRM, 2026-08-27, default OFF).
       Same family as the knife — waiting for the turn — but read from PRICE
       rather than MACD: the last N closes of TODAY'S session must be rising
       (N=2 also refuses a new low between them). Session bars only: yesterday's
       closes say nothing about whether THIS washout has turned, so with fewer
       than N+1 session bars the verdict is "cannot confirm" and the entry is
       refused with an honest row — a confirmation gate that waves entries
       through when it cannot read is not a gate (the TRADER_EXIT_NEEDS_IBS
       principle, applied at entry).

## H124

Above `if (_supStopPx != null && c.stopMinPct > 0) {`

    MINIMUM STOP DISTANCE (stopMinPct). The zone stop can land INSIDE the
    instrument's noise band: live 2026-08-06 SPY entered with a 0.20% stop
    and was tagged in 29 minutes; four stop-outs that session fired within
    ~20 minutes and cost -$1,235 against +$475 from the two positions that
    survived long enough to reach a zone. Push the stop out so it marks a
    broken thesis, not a wiggle. Must move the STOP PRICE, not just the
    distance used for sizing — clamping the distance alone leaves the stop
    where it was and it still gets tagged (the bug this replaces).

## H125

Above `const _lowConvMult = process.env.TRADER_LOWCONV_MULT === undefined ? 0.5 : Number(process.env.TRADER`

    LOW-CONVICTION SIZE CUT (2026-08-11). On the first red-drift session all
    four sub-0.5-p_win entries underperformed (XLK 0.483 took the day's only
    loss; QQQ 0.452 scratched; the carried reds were 0.48-0.54) while every
    >=0.55 entry won. Sizing already scales with conviction, but the curve
    barely bit (0.452 still sized 0.76x). Below the coin-flip line the
    position is a probe, not a bet: hard-cap the multiplier at 0.5x.
    TRADER_LOWCONV_MULT tunes (0 disables). Entry count is unchanged — this
    cuts exposure to weak signals, not the signals themselves.

## H126

Above `const _stopDist = Math.min(15, Math.max(c.stopMinPct, _supStopPx != null`

    Stop distance is now an INPUT to sizing (risk-based), so it must be resolved
    before the order is sized. Structural (support-entry) stop wins when armed.
    The minimum-stop floor applies to EVERY entry, not just support entries.
    Shipped 2026-08-06 wired only into the support-entry branch, so the four
    symbols outside supEntrySyms (XLK IWM DIA SOXL) kept taking plan/ATR stops
    of 1.0-1.5%. On 2026-08-07 all three entries were such symbols: XLK went in
    with a 1.00% stop and was tagged 24 minutes later for -$642 on a 1% wiggle
    — exactly the failure the floor exists to prevent, on a symbol the floor
    did not cover. Applied to NEW entries only; stops already resting at the
    broker are left alone.

## H127

Above `let _stopDistEff = _stopDist;`

    STOP DERIVED FROM TARGET (stopFromTgt, 2026-08-07). Traders don't carry a
    flat RR — they judge how far price can run and set the stop at a fraction
    of that. Today stop and target are chosen INDEPENDENTLY (stop under the
    support zone, target wherever R1 lands), so RR is an accident of geometry:
    live 2026-08-06 produced targets of 0.53R-1.62R, i.e. winners paying LESS
    than the 1R they risked. Deriving the stop as (distance to first real
    resistance) / n makes RR exactly n:1 by construction and lets the stop
    scale with the size of the opportunity.
      gate, holdout 2015-2026, %/trade: off +0.334  2:1 +0.355  3:1 +0.378
      (all three beat off in BOTH windows; 3:1 best on holdout)
    The stopMinPct floor still wins afterwards — a derived stop must never
    land back inside the noise band.

## H128

Above `if (c.minEntryRr > 0 && _resAbove[0]) {`

    MINIMUM ENTRY RR (minEntryRr). The stop floor and the 3:1 derivation fight
    each other: stopFromTgt wants stop = target/3, but if that lands inside the
    floor the floor wins (Math.max) and RR collapses. 2026-08-07 SOXL took a
    3.00% stop against a 1.60% target — 0.53:1, a trade that loses more than it
    wins even when right — and closed -$217. When the floored stop cannot pay
    at least minEntryRr, SKIP rather than take it.

## H129

Above `const _capMult = Math.min(1, _tierMult * _symMult * _regime) * _stress.mult;`

    HARD PER-POSITION CAP (operator, 2026-08-25). The tier / stress / tilt multipliers
    still scale the RISK TARGET — that is what sizing by expectancy means — but they may
    no longer lift the NOTIONAL CEILING above TRADER_MAX_POSITION_PCT. Before this, SOXL
    and SMH and QQQ (tilt 1.5) sized to 18% of equity and 27% at VIX >= 20, which is also
    why trading-guard refused to transact them: it read the bare 12%. One number now.
    Cost, measured before arming (experiments/hard_cap_lab.js): return/DD h1 -15%,
    d-fit -40%, h2 -22%, d-hold -44% — on the 26-year holdout 2,866% -> 1,202% of return
    against a drawdown of 22.1% -> 16.5%. Down-weights are untouched: SPY 0.83 still
    sizes to 9.96%, GLD/TLT 0.5 to 6%.
    REVISION (operator, 2026-09-18): STRESS is carved back OUT of the clamp — it
    lifts the ceiling to cap x TRADER_STRESS_MULT on stress days only, because
    the four-surface sweep shows those are the days the edge pays (d-hold
    return/DD 9.05 -> 13.32 at a SHALLOWER drawdown; see _stressCfg). Tier,
    tilt and regime remain down-only. trading-guard.js mirrors cap x stress as
    its ceiling, so sizer and guard still agree on one number: the largest
    legitimate size.

## H130

Above `if (_breakerTripped(now, c.stopBreaker)) {`

    CASH RESERVE (operator, 2026-08-06): total deployed capital is capped at
    maxGrossPct of equity — the account always keeps (100 - maxGrossPct)% in
    cash. Per-position caps alone don't bound the SUM: 12 tradelist symbols x
    a 7% cap could theoretically deploy 84%. This is the portfolio-level
    brake: an entry that would push gross exposure past the cap is skipped
    (exits are never blocked — reducing risk is always allowed).
    DAILY CIRCUIT BREAKER (2026-08-08). Two stop fills in one session = the
    market is hostile today; refilling freed slots with fresh symbols into the
    same tape built every 2008-class worst day. Entries only — exits and the
    protective stops are untouched.

## H131

Above `const _ecBoundary = _ecMin - ((((_ecMin - (Number(process.env.TRADER_ENTRY_CADENCE_PHASE) || 0)) % N`

    This scan reached the entry stage for this bar. The boundary is NOT
    recorded here (2026-08-24): on 2026-08-24 the 10:00 scan spent the hour
    on SMH, and SOXL — whose read turned eligible at 10:04, two minutes
    after the 3-minute window closed — was locked out until 11:00 with slots
    still free ("entry_cadence: already decided this bar"). The bar's
    decision is spent only when an entry actually PLACES (see _markCadenceDecided
    at the placement site), so a scan that enters nothing leaves the hour open.

## H132

Above `{`

    POST-STOP RE-ENTRY COOLDOWN (2026-08-08). A stop-out means the washout kept
    falling — re-buying the same knife the same/next session is the churn that
    built the worst backtest days. Barred through the recorded ET date.
    NOT gated on stopCooldownDays (2026-09-23). The same map carries the breakeven-
    ratchet SESSION BAR: #3413 charged "no same-session re-entry after a breakeven
    exit" as realism when it validated the ratchet, and #3414 arms it in
    _reconcileFills whether or not the N-day cooldown is on — but this, the only
    reader, sat inside `if (c.stopCooldownDays > 0)`. Stable runs days=0, so the bar
    was written to state and never read: live 2026-09-23 the S sleeve re-bought UPRO
    at 14:12:15, 28 minutes after its 13:44:53 breakeven stop fill (the 13:45-13:53
    skips were the 45-minute ORDER cooldown). With days=0 the map holds ONLY session
    bars, so reading it unconditionally enforces exactly the validated policy.

## H133

Above `if (c.maxConcurrent > 0) {`

    CONCURRENT-POSITION CAP (maxConcurrent, 2026-08-07). Portfolio replay of
    the holdout showed the left tail is a product of CONCURRENCY x STOP WIDTH,
    not of any single bad trade: every worst day pinned at exactly -9.00% =
    3 positions x the 3% stop floor. Capping concurrency at 2 cut days worse
    than -5% by 15% while AVERAGE %/trade actually improved (+0.384 vs
    +0.378) and total return fell only 10%.
    Honest limit: this does NOT reduce the negative-DAY rate (59-60% positive
    at every cap tested, including off) — it truncates severity, not frequency.

## H134

Above `const _dustFloor = account.equity * (c.dustPct / 100);`

    DUST EXCLUSION (2026-08-07). The cap counts RISK SLOTS, not rows in the
    book. Counting any qty>0 position saturated it with garbage: on the
    morning after this shipped the account held QQQ ($32,983, real) plus the
    SOXS remnant (0.8 shares, $35, flagged unclosable since 2026-08-04) —
    2 of 2 slots, so EVERY entry that session would have been refused by a
    position worth 0.004% of equity that cannot even be sold.
    A slot is consumed only by a position that is (a) economically
    meaningful and (b) actually exitable.

## H135

Above `const _openN = _openedThisScan + Object.values(heldPos).filter((p) => {`

    heldPos is a snapshot taken ONCE at scan start, so several entries in the
    same cycle all saw the same pre-scan count and each took "the last slot".
    2026-08-07: SOXL exited at 19:36:08, then XLK (:10) and QQQ (:11) both
    entered in that cycle, leaving 3 positions open against maxConcurrent=2 —
    the cap that bounds the left tail silently did not hold.

## H136

Above `if (c.slotReserve > 0 && (Number(record.p_win) || 0) < c.slotReservePwin`

    SLOT RESERVE BY CONVICTION (#3317, 2026-08-15). Slots were first-come-
    first-served, so weak signals could starve strong ones: on 2026-08-14
    five slots were held largely by sub-0.50 probes when SMH fired at 0.61
    and was refused — it ran +0.82% to the close. Week of 8/11: the sub-0.50
    cohort netted −$516 (n=11) while ≥0.50 entries made money; 21 cap-blocks
    in 4 sessions. The LAST slot is now reserved for conviction: a signal
    below TRADER_SLOT_RESERVE_PWIN may fill up to (cap − reserve); only
    ≥threshold signals may take the final slot(s).

    NOT lab-gated — the daily harness has no p_win dimension, so honesty
    demands the opposite discipline: every refusal logs its own audit row
    (symbol, p_win, what was held), so the live ledger accumulates the
    counterfactual and the rule can be judged on real data. Kill:
    TRADER_SLOT_RESERVE=0.

## H137

Above `if (c.maxPerBucket > 0) {`

    CORRELATED-RISK CAP (2026-08-13). The concurrency cap counts SYMBOLS; risk
    is carried by DIRECTION. Live that day the book held SOXS + SQQQ + SPXS —
    three families, so the direction-lock (which only blocks OPPOSING
    exposure) permitted all three and the cap counted three independent slots.
    They were one bet, "the market falls", held in triplicate; the market
    rallied and they lost together for -$1,431 while a single position would
    have lost a third of that.

    Structural, not bad luck: IBS buys whatever sits at the bottom of its
    session range, and in a rally that is always the inverse ETFs — so the
    engine concentrates short exactly when it is most wrong. Counting by
    bucket bounds that. Positions opened THIS scan count too (same
    start-of-scan-snapshot blind spot the concurrency cap had).

## H138

Above `const enOrder = (extended && price > 0)`

    acceptWarnings on ENTRIES too (2026-08-10). IBKR attaches disclosure
    prompts to leveraged/inverse-ETF orders ("intended for daily use…");
    exits and stops already auto-confirm them, but entries did not — so the
    first inverse signal of the session (SPXS, $115k, A-tier) died at
    needs_confirmation while its exit would have sailed through. These
    symbols were deliberately gated INTO the watchlist; the disclosure is
    acknowledged by design, not per-order.
    refPrice: the SAME quote this entry was sized from, so the guard's per-position
    cap can price a market buy. Without it a market order's notional reads as zero
    and the cap never binds on the engine's normal path (2026-08-25).

## H139

Above `const _rqMode = String(process.env.TRADER_ENTRY_REQUOTE || '').toLowerCase();`

    ENTRY RE-QUOTE GUARD (shadow 2026-10-04, refuse 2026-10-07) — see requoteRead.
      TRADER_ENTRY_REQUOTE=shadow : the fresh print is fetched BESIDE the order, never before it; rows only, nothing changes an order.
      TRADER_ENTRY_REQUOTE=refuse : the fresh print is fetched BEFORE the order; when it has run more than
        TRADER_ENTRY_REQUOTE_CAP_BPS past the decision quote the entry is SKIPPED (a skip row naming the guard and an
        entry_requote row with refused: true). The first live read of the shadow (2026-10-06, 21 fills on both boxes):
        the five fills it would have refused paid +13.7 bp and the three closed lost $1,556 with no winner; the sixteen
        it kept paid -1.4 bp and made $2,456 (ledger live-entry-requote-shadow). A quote that ran away between the
        decision and the order is a market already moving against the entry. No fresh quote = no verdict: the order
        places, as in shadow mode. Default OFF.

## H140

Above `const stopDist = _stopDistEff;   // resolved before sizing (risk-based)`

    The PLACED stop must be the same stop that sized the position and passed
    the RR gate (_stopDistEff — target/3, floored, capped). It used to place
    the pre-derivation structural stop (_stopDist) instead: sizing budgeted
    risk at the derived stop while the broker held an 8-12% one, so realized
    risk ran 1.6-2.4x the configured riskPct and the minEntryRr gate passed
    trades whose true geometry was below 1:1 (audit 2026-08-08, probe-
    verified). With no qualifying resistance _stopDistEff === _stopDist,
    so structural/ATR stops are unchanged there.

## H141

Above `const res = _resAbove;`

    Arm the ladder for EVERY entry (#3285, 2026-08-15). What actually failed
    on 2026-08-14 was OWNERSHIP, not target distance: with no ladder armed
    (blue sky + the fossil allowlist), the first weak scan owned the exit and
    a SOXL entered 0.08% off the session low was scratched at +0.25% of a
    +3.83% bounce. Blue sky now arms rungs at the PLAN targets — the same
    distances the two-window lab validated — so every entry gets the
    R1/R2/trail structure and signal_exit is pre-empted (#3165), everywhere.

    TIGHTENING THE RUNGS IS FALSIFIED. The obvious "make R1 reachable" fix
    (rungs at k x daily-ATR) was swept 2000→2026, 10 symbols, 37,518 trades,
    fit 2000-14 / holdout 2015-26, judged on total income:

        base (plan targets)  fit  +852.0   holdout +1612.1   <- winner
        atr x1.5             fit  +664.7   holdout +1046.4
        atr x1.0             fit  +371.5   holdout  +728.8
        atr x0.75            fit  +250.4   holdout  +635.6
        MFE-p75 adaptive     fit  +516.4   holdout +1115.7

    Monotonic: the nearer the full-exit target, the more income dies — the
    winners' tail pays for everything (the limit-entry lesson, exit-side).
    TRADER_LADDER_VOL_MULT>0 keeps the tightened mode available for a future
    re-test with a partial-bank runner structure; it is OFF by default.

## H142

Above `...(await (async () => {`

    MIRROR JOURNAL (#3390). The redirect counterfactual, priced at the
    moment of decision: which same-leverage opposite instrument existed,
    and what it cost right now. 2026-08-18 made the case — SOXL fired
    BULLISH at 09:30 and lost -$2,433 while its mirror gained ~15%; a
    regime-aware redirect is worth building only if rows like this keep
    showing that swing, so every leveraged entry records the evidence.
    Fail-soft: a missing quote journals null, never blocks the entry.

## H143

Above `if (r && r.status !== 'placed' && r.status !== 'dry_run') {`

    ── An entry that did NOT place must be narrated and must back off ────────────
    Entries deliberately don't pass acceptWarnings (P0-8: never blindly click
    through IBKR's margin/size/price warnings on a BUY). A warned entry therefore
    returns needs_confirmation with the order ALREADY POSTed and parked at IBKR —
    which is what shows there as `inactive`. Two consequences, both fixed here:

      1. The reason was DISCARDED. The bridge computes r.reason from IBKR's own
         warning text, but nothing logged it unless the order placed. So 408 parked
         orders on 2026-07-31 told us nothing about WHICH warning fired. Every
         non-placed entry now lands an `entry_blocked` row carrying that text.
      2. The re-entry cooldown armed only on 'placed'/'dry_run', so a warned symbol
         re-fired every 60s scan indefinitely — 7 symbols became 408 orders in one
         session (QQQ alone 151). Arming it on any terminal outcome brakes that to
         one attempt per cooldown for as long as the entry stays blocked.

    Observability + a brake ONLY. No warning is confirmed, so this does not make any
    entry more likely to reach the market than it already was.

## H144

Above `const _warnTxt = Array.isArray(r.warnings) && r.warnings.length`

    IBKR's `note` is a GENERIC instruction ("re-submit with acceptWarnings"),
    identical for every warning type — it does not say WHICH warning fired.
    On 2026-08-06 two entries parked ($67k notional) and the actual advisory
    text existed only in r.warnings, which was never logged, so the block
    could not be diagnosed from the ledger at all. Surface the real messages.

## H145

Above `if (r && (r.status === 'placed' || r.status === 'dry_run')) { _lastOrderAt.set(sym, now); if (r.stat`

    FRESH POSITION = FRESH EXCURSIONS (the SOXL ghost peak, live 2026-08-31).
    _peak/_trough only ever grow against their existing value, so a stale entry
    from a PRIOR position poisons the next one: Friday's SOXL peak ($118.08)
    survived a feed-visible stop fill and the weekend, and Monday's fresh entry
    at $112.01 was trail-cut at −$878 for a "give-back from peak +5.4%" this
    position never came near (real high +0.2%). Reset at placement so no leak
    path upstream can matter.

## H146

Above `if (process.env.TRADER_LOG_SKIPS !== '0' && c.maxConcurrent > 0) {`

    ── SLOT-UTILIZATION OBSERVABILITY (2026-08-08) ────────────────────────────
    Throughput, not signal quality, is the open question at ~$235-400 captured
    per trade: 0.5%/day needs both concurrency slots WORKING. This records every
    transition of slots-in-use (same slot definition as the cap: dust and
    unclosable positions excluded), so the daily report can time-weight how much
    of the session ran 0/1/2 slots filled. One row per change, not per scan.

## H147

Above `try {`

    ── SESSION RECORD (#3286) ─────────────────────────────────────────────────
    One row per trading day, at/after the close. The ledger held every trade but
    nothing held the SESSION — no closing equity anywhere — so verifying a day's
    P&L meant reconstructing yesterday's equity from bar closes. That
    reconstruction is what exposed #3283; the check that should have caught it
    years earlier, equity(today) − equity(yesterday), was simply unanswerable.

    Written from the same computeDayPnl the panel uses, so the stored figures
    are the ones actually shown, and idempotence is checked against the ledger
    (not memory) so a restart cannot double-write the date.

## H148

Above `const _held = Object.values(heldPos).filter((p) => Math.abs(Number(p && p.qty) || 0) > 0);`

    OWNERSHIP FILTER — heldPos is EVERY position in the account, not this
    engine's. Champion holds XMMO/SPMO and the overnight sleeve holds its
    own; feeding them in would put another book's positions into this
    book's carried_out, open_risk and Day P&L. That is exactly the leak
    that made the 2026-08-13 sweep reconstruct SPMO/XMMO exits as ours
    (#3277). Same `_ourSyms` set that fix introduced.
    THE PARTITION comes out first (2026-10-28): `_ourSyms` holds every name
    this scan read, and the overnight book's SPY/QQQ/SMH are on the
    tradelist, so its 15:55 buys passed as this book's. Stable's first
    night valued SPY and SMH from the prior close as the trader's carries:
    about +$1,020 of day_pnl the trader never made. The reserve fund and
    the book go to their own field, partition_out, so the row still shows
    everything the account takes into the gap.

## H149

Above `try {`

    POST-CLOSE REVIEW (#3359). Fire-and-forget, AFTER the session row is
    written — and read back FRESH, because `_ledger` is a string snapshot
    taken BEFORE that row was appended. The reviewer's own first live run
    (2026-08-19) caught the distinction: its top finding was "session_record
    is null — the day's equity, day_pnl, stops_fired were never recorded",
    and it was right about the text it was given. The snapshot structurally
    cannot contain the record this role exists to audit, so every close
    would have opened on the same false finding, burning one of its 12
    finding slots and training whoever reads it to ignore the rest.
    logTrade appends synchronously, so one re-read is guaranteed to include
    today's row; if the read fails, fall back to the snapshot rather than
    skip the review. It holds no
    bridge and cannot place, cancel or size anything — the only thing it can
    produce is a journal row of findings. Deliberately NOT awaited: a slow or
    dead API must never delay the close, and its own failure paths already
    return an empty review rather than throwing. Default OFF; enable with
    TRADER_SESSION_REVIEW=1.

## H150

Above `const _ptr = _rev.pointerRow(r, { ts: new Date(now).toISOString(), user: userId, date: _day });`

    Summarise into the TRADE LEDGER, not stdout: every other
    observable in this engine is queryable there, and a finding that
    only exists in a console line is invisible to any post-mortem.
    The findings themselves stay in session-reviews.jsonl; this row
    is the pointer that shows up when you read the day back (machine
    checks included, even when the model failed: session-review.pointerRow).

## H151

Above `const _lastSkipWhy = new Map();`

    ── SKIP-REASON OBSERVABILITY (2026-08-05) ───────────────────────────────────
    out.skipped lived and died in memory, so a session where the trader declined
    every opportunity left NO record of why. On 2026-08-05 GLD ran +1.85% and
    SQQQ +4.75% untouched, and the post-mortem could only INFER the cause by
    replaying bars offline — the live reasons were gone.

    Logging every skip would write ~400 rows/day of pure repetition, so this logs
    a symbol's reason only when it CHANGES. Digits are normalised out of the
    comparison key first, otherwise counters embedded in the text ("min-hold
    (3<5min)") would look like a new reason on every scan and defeat the dedupe.
    Result: one row per symbol per distinct blocker — the day's story, not its
    transcript. Kill: TRADER_LOG_SKIPS=0.

## H152

Above `const _ev = {};`

    EVIDENCE PASS-THROUGH (#3381). #3375 attached decision_context to every
    entry-candidate record so a veto could be audited later — and this
    whitelist then silently dropped every one of those fields before disk.
    Found on the feature's first live day: the ledger rows were still bare.
    The whitelist stays (a skip row must not balloon), but the evidence keys
    are part of it now.
