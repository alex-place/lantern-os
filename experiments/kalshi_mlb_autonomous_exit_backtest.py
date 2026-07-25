"""Kalshi KXMLBGAME: is there a profit edge with AUTONOMOUS ENTRY *AND* EXIT?

WHY THIS IS NOT A RE-CHASE OF A REFUTED EDGE. The repo's prior Kalshi refutations are real and
respected: crypto 15M taker has no edge after fees (-$48 / 6209 trades, now code-enforced), and
the weather day-ahead edge FAILS its market-relative certification. But BOTH covered other market
classes, and — the load-bearing point — BOTH held to resolution. Held-to-resolution is exactly
what produces the measured "+2c average win / -100c average loss" profile. An autonomous EXIT
changes the payoff shape, and it has never been tested here. This data is 100% KXMLBGAME (live
baseball), a class never tested, and it is the only data with the 6-second price PATH that makes
exit testing possible at all.

HONEST DATA LIMITS (measured before designing, not discovered after):
  - 79 markets with liquid paths; the two daily files cover the SAME markets (only 10 day-2-only),
    so there is NO clean temporal out-of-sample. Split is market-level (hash of ticker).
  - NOTHING resolved in-window (all status=active, result=''), so there is NO settlement ground
    truth -> hold-to-resolution cannot be scored, and only in-window round trips are testable.
  - Median market moves just 3c end-to-end; only 27/79 move >=10c. The edge space is small.
  => This is a PILOT on a thin sample, not a proven edge. Stated up front so the verdict cannot
     be inflated later.

COSTS ARE MODELLED PESSIMISTICALLY (the thing that killed every prior "edge"):
  - Enter by CROSSING: buy YES at the ask, buy NO at (100 - yes_bid).
  - Exit by CROSSING BACK: sell YES at the bid, sell NO at (100 - yes_ask).
  - Kalshi fee BOTH SIDES: ceil(0.07 * C * P * (1-P)) in cents, per the shipped kalshi-fees model.
  - Fills capped by the QUOTED SIZE at that instant; illiquid/wide quotes were already dropped
    by the extractor (spread<=5c, size>=5 both sides, open_interest>0).
  - No look-ahead: entry/exit decisions use only data at or before the decision timestamp.

SIGNAL DISCIPLINE (from the corpus, arXiv:2604.24366 Polymarket microstructure): trade direction
inferred from a public order-book feed agrees with on-chain ground truth only ~59% of the time,
and the effective half-spread flips sign on 67% of markets. So NO signal here uses inferred order
flow or trade direction — only quoted mid/bid/ask and their own dynamics. That paper also reports
a longshot spread premium, so trading is restricted to mid-range prices.

STRATEGY UNDER TEST — fade a sharp move, exit autonomously:
  entry : mid moves >= JUMP cents within LOOKBACK seconds, and price is mid-range
          (ENTRY_LO <= mid <= ENTRY_HI) -> take the CONTRARIAN side (fade the move)
  exit  : take-profit at +TP cents, stop-loss at -SL cents, or TIMEOUT seconds elapsed
          (whichever first) -- all three are autonomous, no discretion, no look-ahead

PRE-REGISTERED GATES (fixed BEFORE the first run):
  G1 (net edge)  : OOS mean net-after-fee PnL per trade > 0.
  G2 (beats null): OOS net PnL per trade > the RANDOM-ENTRY control run with the SAME exit rules
                   and comparable trade count, by >0.5c. This is the load-bearing control -- if
                   random entry with the same exits earns the same, the "edge" is the exit logic
                   interacting with drift, NOT the signal.
  G3 (power)     : >= 30 OOS trades. Below that, report as underpowered regardless of sign.
  KILL           : G1 or G2 fails -> NO EDGE. Report it and stop. Do not tune and re-report;
                   any parameter change after seeing OOS is a new pre-registration.

Run:  python experiments/kalshi_mlb_autonomous_exit_backtest.py
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import random

SRC = os.path.join("experiments", "results", "kalshi_mlb_paths.jsonl")
OUT = os.path.join("experiments", "results", "kalshi_mlb_autonomous_exit_backtest.json")

# strategy params (chosen on the IN-SAMPLE half only; frozen before scoring OOS)
JUMP = 4          # cents move to call it "sharp"
LOOKBACK = 120    # seconds window for the jump
TP = 3            # take-profit cents
SL = 4            # stop-loss cents
TIMEOUT = 900     # seconds max hold
ENTRY_LO, ENTRY_HI = 20, 80   # avoid longshots (corpus: longshot spread premium)
COOLDOWN = 600    # seconds before the same market may be re-entered
SEED = 11


def fee_cents(price_cents, contracts=1):
    """Kalshi fee, rounded UP to the cent: 0.07 * C * P * (1-P), P in dollars."""
    p = max(0.0, min(1.0, price_cents / 100.0))
    return math.ceil(0.07 * contracts * p * (1 - p) * 100) / 100.0 * 100 / 100  # cents


def fee_c(price_cents, contracts=1):
    p = max(0.0, min(1.0, price_cents / 100.0))
    return math.ceil(0.07 * contracts * p * (1 - p) * 100)  # integer cents, conservative


def is_oos(ticker):
    return int(hashlib.md5(ticker.encode()).hexdigest(), 16) % 2 == 1


def round_trip(path, i_entry, side, tp=TP, sl=SL, timeout=TIMEOUT):
    """Enter at i_entry crossing the spread; exit on TP/SL/timeout crossing back.
    side: +1 = long YES, -1 = long NO. Returns (net_cents, exit_reason, hold_s) or None."""
    t0, yb0, ya0 = path[i_entry][0], path[i_entry][1], path[i_entry][2]
    if side > 0:
        entry = ya0                      # buy YES at the ask
    else:
        entry = 100 - yb0                # buy NO at (100 - yes_bid)
    if not (0 < entry < 100):
        return None
    f_in = fee_c(entry)
    for j in range(i_entry + 1, len(path)):
        t, yb, ya = path[j][0], path[j][1], path[j][2]
        if side > 0:
            exit_px = yb                 # sell YES at the bid
        else:
            exit_px = 100 - ya           # sell NO at (100 - yes_ask)
        if not (0 < exit_px < 100):
            continue
        gross = exit_px - entry
        held = t - t0
        reason = None
        if gross >= tp:
            reason = "take_profit"
        elif gross <= -sl:
            reason = "stop_loss"
        elif held >= timeout:
            reason = "timeout"
        if reason:
            net = gross - f_in - fee_c(exit_px)
            return (net, reason, held)
    return None                          # never exited within the observed path -> not counted


def signal_entries(path):
    """Fade a sharp move. Uses ONLY quotes at or before the decision instant."""
    out = []
    last_entry_t = -1e18
    for i in range(1, len(path)):
        t, yb, ya = path[i][0], path[i][1], path[i][2]
        mid = (yb + ya) / 2
        if not (ENTRY_LO <= mid <= ENTRY_HI):
            continue
        if t - last_entry_t < COOLDOWN:
            continue
        # find the quote LOOKBACK seconds ago (no look-ahead: scan backwards only)
        j = i - 1
        while j > 0 and t - path[j][0] < LOOKBACK:
            j -= 1
        prev_mid = (path[j][1] + path[j][2]) / 2
        move = mid - prev_mid
        if abs(move) >= JUMP:
            out.append((i, -1 if move > 0 else +1))   # FADE: move up -> buy NO, move down -> buy YES
            last_entry_t = t
    return out


def random_entries(path, k, rng):
    """Control: same count of entries, random instants and random sides, same price band."""
    cand = [i for i in range(1, len(path))
            if ENTRY_LO <= (path[i][1] + path[i][2]) / 2 <= ENTRY_HI]
    if not cand or k <= 0:
        return []
    picks = rng.sample(cand, min(k, len(cand)))
    return [(i, rng.choice([+1, -1])) for i in sorted(picks)]


def run(markets, entry_fn, label, rng=None):
    trades = []
    for m in markets:
        path = m["path"]
        ents = entry_fn(path, rng) if rng is not None else entry_fn(path)
        for i, side in ents:
            r = round_trip(path, i, side)
            if r:
                trades.append({"ticker": m["ticker"], "net": r[0], "reason": r[1], "hold_s": r[2]})
    n = len(trades)
    if n == 0:
        return {"label": label, "n": 0}
    nets = [t["net"] for t in trades]
    wins = [t for t in trades if t["net"] > 0]
    reasons = {}
    for t in trades:
        reasons[t["reason"]] = reasons.get(t["reason"], 0) + 1
    mean = sum(nets) / n
    sd = (sum((x - mean) ** 2 for x in nets) / (n - 1)) ** 0.5 if n > 1 else 0.0
    return {"label": label, "n": n,
            "mean_net_cents": round(mean, 3),
            "total_net_cents": round(sum(nets), 1),
            "win_rate": round(len(wins) / n, 3),
            "sd": round(sd, 2),
            "t_stat": round(mean / (sd / n ** 0.5), 2) if sd > 0 and n > 1 else None,
            "exit_reasons": reasons,
            "median_hold_min": round(sorted(t["hold_s"] for t in trades)[n // 2] / 60, 1)}


def main():
    mk = [json.loads(l) for l in open(SRC, encoding="utf-8")]
    ins = [m for m in mk if not is_oos(m["ticker"])]
    oos = [m for m in mk if is_oos(m["ticker"])]
    rng = random.Random(SEED)

    res = {
        "date": "2026-07-25",
        "status": "PILOT — thin sample, pre-registered gates; NOT a proven edge",
        "data_limits": {
            "markets": len(mk), "in_sample": len(ins), "out_of_sample": len(oos),
            "no_settlement": "nothing resolved in-window (all active) -> only in-window round trips testable",
            "no_temporal_oos": "the two daily files cover the same markets -> split is market-level (md5 hash)",
            "median_market_move_cents": 3,
        },
        "params": {"JUMP": JUMP, "LOOKBACK_s": LOOKBACK, "TP": TP, "SL": SL,
                   "TIMEOUT_s": TIMEOUT, "band": [ENTRY_LO, ENTRY_HI], "COOLDOWN_s": COOLDOWN},
        "costs": "cross both ways (buy ask / sell bid) + Kalshi fee ceil(0.07*C*P*(1-P)) on BOTH sides",
    }

    res["in_sample_signal"] = run(ins, signal_entries, "in_sample_fade")
    res["oos_signal"] = run(oos, signal_entries, "oos_fade")
    # control: same trade count as the OOS signal arm, random entries + random sides
    k_per = max(1, round(res["oos_signal"].get("n", 0) / max(1, len(oos))))
    res["oos_random_control"] = run(oos, lambda p, r: random_entries(p, k_per, r),
                                    "oos_random_control", rng=rng)

    sig = res["oos_signal"]; ctl = res["oos_random_control"]
    g1 = sig.get("n", 0) > 0 and sig.get("mean_net_cents", -1) > 0
    g2 = (sig.get("n", 0) > 0 and ctl.get("n", 0) > 0
          and sig["mean_net_cents"] - ctl["mean_net_cents"] > 0.5)
    g3 = sig.get("n", 0) >= 30
    res["gates"] = {
        "G1_net_edge_positive": {"PASS": bool(g1), "oos_mean_net_cents": sig.get("mean_net_cents")},
        "G2_beats_random_same_exits": {"PASS": bool(g2),
                                       "signal": sig.get("mean_net_cents"),
                                       "random_control": ctl.get("mean_net_cents"),
                                       "delta": (round(sig["mean_net_cents"] - ctl["mean_net_cents"], 3)
                                                 if sig.get("n") and ctl.get("n") else None)},
        "G3_power_30_trades": {"PASS": bool(g3), "oos_trades": sig.get("n", 0)},
    }
    res["gates"]["VERDICT"] = (
        "EDGE CANDIDATE (pilot) — positive OOS net after fees AND beats the random-entry control"
        if (g1 and g2 and g3) else
        "NO EDGE — " + ("underpowered" if not g3 else
                        "does not beat random entry with the same exits" if g1 and not g2 else
                        "negative net after fees"))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2)

    print("=== Kalshi KXMLBGAME autonomous entry+exit (PILOT) ===")
    print(f"markets {len(mk)}  in-sample {len(ins)}  OOS {len(oos)}")
    for k in ("in_sample_signal", "oos_signal", "oos_random_control"):
        r = res[k]
        if r.get("n"):
            print(f"  {r['label']:22s} n={r['n']:<4} mean_net={r['mean_net_cents']:+.2f}c "
                  f"total={r['total_net_cents']:+.0f}c win={r['win_rate']:.2f} t={r['t_stat']} "
                  f"hold_med={r['median_hold_min']}min {r['exit_reasons']}")
        else:
            print(f"  {r['label']:22s} n=0 (no trades)")
    print("\nGATES:")
    for k, v in res["gates"].items():
        if k != "VERDICT":
            print(f"  {k}: {v}")
    print(f"\nVERDICT: {res['gates']['VERDICT']}")
    print("->", OUT)


if __name__ == "__main__":
    main()
