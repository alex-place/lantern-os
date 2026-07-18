Added the **streaming real-time brake monitor** (`lib/brake-monitor.js`) — the
intraday-risk-monitoring prerequisite ADR-0028 names for the Phase-2 leverage
overlay, PAPER ONLY (it computes and streams brake state; it never places
orders). A 60s singleton loop (`BRAKE_MONITOR_MS`, kill switch
`BRAKE_MONITOR=0`) over the ADR champion mix (SPY QQQ IWM EFA TLT GLD XMMO
SPMO) re-derives the brake-to-cash gross target each tick:
`gross = clamp(min(2, 0.35/vol), [0,2]) × trendGate(6mo down→cash) ×
ddTaper(30%→cash by 60%)`, where `vol` is a documented conservative blend —
max(20d daily realized vol, RMS with intraday tick vol from a ~500-tick ring)
— so intraday spikes tighten the brake but stale after-hours ticks can never
release it. Gross changes are applied tick-to-tick to a **virtual $25,000
paper book** (equal-weight direction v1; borrows at T-bill+150bp above 1×,
earns T-bill below 1×) that persists across restarts
(`data/trading/brake-monitor.json`, debounced async writes) — this book is the
live practice record the ADR-0028 mandate gate requires before anything ever
touches real capital. Streamed at `GET /api/trading/brake/status` (full state
+ last 50 gross-target changes), rendered as a live strip on the trader
Advisor tab (gross target, vol/trend/drawdown chips, paper equity, "practice
mode" label, 60s poll while visible), and readable in chat via the new
`brake_status` tool. Offline unit suite `tests/test_brake_monitor.js` covers
the gross formula, the vol blend/annualization, paper-book carry signs, and
the persistence round-trip.
