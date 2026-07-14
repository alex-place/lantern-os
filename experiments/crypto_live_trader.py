"""
15-Minute Crypto Live Trader + CIO Trainer

Polls Kalshi 15-minute Up/Down crypto markets every POLL_INTERVAL seconds.
Runs the CIOConvergenceModel on each window. When a signal fires, logs a
paper trade to data/kalshi/paper-positions.jsonl. When the window resolves,
logs the P&L and appends to the training report.

Series tracked: BTC15M, ETH15M, SOL15M, XRP15M, DOGE15M, BNB15M, HYPE15M

Run:
    python experiments/crypto_live_trader.py
    python experiments/crypto_live_trader.py --interval 10 --edge 0.06

Output:
    data/kalshi/crypto-tight-band-YYYYMMDD.jsonl  (raw snapshots, same format as tight-band)
    data/kalshi/paper-positions.jsonl              (paper trades appended)
    data/kalshi/cio-train-report.json              (updated after each resolved window)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
import urllib.parse
import random
import string
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kalshi_cio_backtest import Snapshot, MarketTrajectory, CIOConvergenceModel  # noqa

KALSHI_HOST = "external-api.kalshi.com"
BASE = "/trade-api/v2"

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "kalshi"
PAPER_LOG = DATA_DIR / "paper-positions.jsonl"
TRAIN_REPORT = DATA_DIR / "cio-train-report.json"

# 15-minute up/down series
SERIES_15M = {
    "BTC":  "KXBTC15M",
    "ETH":  "KXETH15M",
    "SOL":  "KXSOL15M",
    "XRP":  "KXXRP15M",
    "DOGE": "KXDOGE15M",
    "BNB":  "KXBNB15M",
    "HYPE": "KXHYPE15M",
}

MIN_POINTS  = 6      # snapshots before first CIO check
CERT_EDGE   = 0.08   # minimum |p* - price| to trade
RESOLVED_TH = 0.92   # price threshold for resolved


# ── Kalshi REST ───────────────────────────────────────────────────────────────

def kalshi_get(endpoint: str, params: dict = None) -> dict:
    url = f"https://{KALSHI_HOST}{BASE}{endpoint}"
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def fetch_active_market(series: str, now_ms: float) -> dict | None:
    """Return the market in this series that is currently live (closes soonest, >0 mins)."""
    data = kalshi_get("/markets", {"status": "open", "limit": 20, "series_ticker": series})
    markets = data.get("markets") or []
    # Normalise cents
    for m in markets:
        for fd, fc in [("yes_ask_dollars","yes_ask"),("no_ask_dollars","no_ask")]:
            if not m.get(fc) and m.get(fd) is not None:
                m[fc] = round(float(m[fd]) * 100)
    # Pick soonest closing that hasn't closed yet
    future = [m for m in markets if m.get("close_time") and
              datetime.fromisoformat(m["close_time"].replace("Z","+00:00")).timestamp()*1000 > now_ms]
    if not future:
        return None
    return min(future, key=lambda m: m["close_time"])


# ── Paper trading ─────────────────────────────────────────────────────────────

def trade_id() -> str:
    ts = int(time.time() * 1000)
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=4))
    return f"paper_{ts}_{suffix}"


def log_paper_open(ticker: str, title: str, side: str, limit_cents: int, edge: float) -> str:
    tid = trade_id()
    entry = {
        "event":      "open",
        "id":         tid,
        "ts":         datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),
        "ticker":     ticker,
        "title":      title,
        "side":       side,
        "action":     "buy",
        "count":      1,
        "limitCents": limit_cents,
        "cio_edge":   round(edge, 4),
        "source":     "crypto_live_trader",
    }
    with PAPER_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    return tid


def kalshi_entry_fee_cents(price_cents: int) -> int:
    """Kalshi taker fee on a single contract: ceil(0.07 * p * (1-p)) in cents, p in dollars."""
    import math
    p = max(0.0, min(1.0, price_cents / 100.0))
    return math.ceil(0.07 * p * (1.0 - p) * 100.0)


def log_paper_close(tid: str, exit_cents: int, correct: bool, entry_cents: int):
    """Realized PnL of a hold-to-settlement binary. `exit_cents` is THIS position's settlement
    value (100 if the bought side won, 0 if it lost); `entry_cents` is the real fill price. The
    old formula PnL'd against a hardcoded 50c entry and always logged +/-100% — this computes the
    true cents PnL net of the Kalshi entry fee (settlement itself is free)."""
    fee_cents = kalshi_entry_fee_cents(entry_cents)
    gross_cents = exit_cents - entry_cents          # +100c win margin at 0c entry .. -entry on a loss
    net_cents = gross_cents - fee_cents
    pnl_pct = round(net_cents / entry_cents, 4) if entry_cents else 0.0
    entry = {
        "event":          "close",
        "id":             tid,
        "exitTag":        "RESOLVED",
        "exitPriceCents": exit_cents,
        "entryCents":     entry_cents,
        "grossCents":     gross_cents,
        "feeCents":       fee_cents,
        "netCents":       net_cents,          # realized cents PnL per contract, net of fee
        "pnlPct":         pnl_pct,
        "correct":        correct,
        "closedAt":       datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),
    }
    with PAPER_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


# ── Training report ───────────────────────────────────────────────────────────

def update_train_report(results: list[dict]):
    """Append resolved window results to cio-train-report.json."""
    report = {}
    if TRAIN_REPORT.exists():
        try:
            report = json.loads(TRAIN_REPORT.read_text(encoding="utf-8"))
        except Exception:
            pass

    crypto15m = report.setdefault("crypto15m_eval", {
        "accuracy_direction": 0,
        "total_signals": 0,
        "correct_signals": 0,
        "windows_observed": 0,
        "avg_edge": 0,
        "results": [],
    })

    for r in results:
        crypto15m["results"].append(r)
        crypto15m["windows_observed"] += 1
        if r.get("had_signal"):
            crypto15m["total_signals"] += 1
            if r.get("correct"):
                crypto15m["correct_signals"] += 1

    if crypto15m["total_signals"] > 0:
        crypto15m["accuracy_direction"] = round(
            crypto15m["correct_signals"] / crypto15m["total_signals"], 4
        )
        edges = [abs(r.get("edge", 0)) for r in crypto15m["results"] if r.get("had_signal")]
        crypto15m["avg_edge"] = round(sum(edges) / len(edges), 4) if edges else 0

    TRAIN_REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")


# ── Per-symbol state ──────────────────────────────────────────────────────────

class SymbolState:
    def __init__(self, symbol: str):
        self.symbol = symbol
        self.ticker: str | None = None
        self.snaps: list[tuple] = []     # (ts, yes_mid, ya, na)
        self.position: dict | None = None  # open paper trade
        self.signal_fired = False
        self.resolved = False

    def reset(self, new_ticker: str):
        if self.ticker and self.ticker != new_ticker:
            print(f"  [{self.symbol}] new window: {new_ticker}", flush=True)
        self.ticker = new_ticker
        self.snaps = []
        self.position = None
        self.signal_fired = False
        self.resolved = False

    def add_snap(self, ts: str, ya: int, na: int):
        s = ya + na
        mid = ya / s if s > 0 else 0.5
        self.snaps.append((ts, mid, ya/100.0, na/100.0))

    def final_price(self) -> float:
        return self.snaps[-1][1] if self.snaps else 0.5

    def outcome(self) -> int:
        """1 = YES resolved, 0 = NO resolved, -1 = unknown."""
        p = self.final_price()
        if p >= RESOLVED_TH:  return 1
        if p <= 1-RESOLVED_TH: return 0
        return -1


# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=int, default=10, help="Poll seconds (default 10)")
    ap.add_argument("--edge",     type=float, default=CERT_EDGE, help="Min CIO edge to trade (default 0.08)")
    args = ap.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    model = CIOConvergenceModel()
    states: dict[str, SymbolState] = {sym: SymbolState(sym) for sym in SERIES_15M}

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    snap_log = DATA_DIR / f"crypto-tight-band-{today}.jsonl"

    resolved_results: list[dict] = []

    print("=" * 60, flush=True)
    print("15-Min Crypto CIO Live Trader", flush=True)
    print(f"Interval: {args.interval}s  Edge: {args.edge:.0%}", flush=True)
    print(f"Tracking: {', '.join(SERIES_15M.keys())}", flush=True)
    print(f"Paper log: {PAPER_LOG.name}", flush=True)
    print(f"Snap log:  {snap_log.name}", flush=True)
    print("=" * 60, flush=True)

    poll = 0
    start_t = time.time()

    while True:
        poll += 1
        now_ms = time.time() * 1000
        ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        elapsed_min = (time.time() - start_t) / 60
        print(f"\n── Poll {poll}  {ts[:19]}  ({elapsed_min:.1f}m running) ──", flush=True)

        snap_markets = []

        for sym, series in SERIES_15M.items():
            st = states[sym]
            try:
                m = fetch_active_market(series, now_ms)
            except Exception as e:
                print(f"  [{sym}] API err: {e}", flush=True)
                continue

            if m is None:
                print(f"  [{sym}] no active market", flush=True)
                continue

            ticker = m.get("ticker", "")
            ya = m.get("yes_ask") or 0
            na = m.get("no_ask") or 0
            close_iso = m.get("close_time", "")
            close_ms = datetime.fromisoformat(close_iso.replace("Z","+00:00")).timestamp()*1000
            mins_left = (close_ms - now_ms) / 60000

            # Detect window rollover
            if ticker != st.ticker:
                # Previous window just closed — evaluate it
                if st.ticker and st.snaps:
                    outcome = st.outcome()
                    result = {
                        "ticker":      st.ticker,
                        "symbol":      sym,
                        "ts":          ts,
                        "n_points":    len(st.snaps),
                        "final_price": round(st.final_price(), 4),
                        "had_signal":  st.signal_fired,
                        "outcome":     outcome,
                        "correct":     False,
                        "edge":        0.0,
                    }
                    if st.position and outcome != -1:
                        side_yes = st.position["side"] == "yes"
                        correct = (side_yes and outcome == 1) or (not side_yes and outcome == 0)
                        result["correct"] = correct
                        result["edge"]    = st.position.get("cio_edge", 0)
                        exit_cents = 100 if outcome == (1 if side_yes else 0) else 0
                        log_paper_close(st.position["id"], exit_cents, correct,
                                        st.position.get("entry_cents", 50))
                        flag = "✓ WIN" if correct else "✗ LOSS"
                        print(f"  [{sym}] {st.ticker} RESOLVED — {flag}", flush=True)
                    resolved_results.append(result)
                st.reset(ticker)

            st.add_snap(ts, ya, na)
            snap_markets.append(m)

            # CIO check
            signal_str = ""
            if len(st.snaps) >= MIN_POINTS and not st.signal_fired:
                snap_objs = [Snapshot(ya_f, na_f) for (_, _, ya_f, na_f) in st.snaps]
                traj = MarketTrajectory(snap_objs, outcome=-1, close_ts=close_iso)
                p_star, has_signal = model.predict(traj)
                price_now = snap_objs[-1].yes_mid
                edge = p_star - price_now

                if has_signal and abs(edge) > args.edge:
                    side = "yes" if edge > 0 else "no"
                    limit = ya if side == "yes" else na
                    tid = log_paper_open(ticker, m.get("title",""), side, limit, edge)
                    st.position = {"id": tid, "side": side, "cio_edge": edge, "entry_cents": limit}
                    st.signal_fired = True
                    signal_str = f" *** SIGNAL {side.upper()} edge={edge:+.3f} p*={p_star:.3f} → PAPER TRADE"

            mid = (ya + na) and ya/(ya+na)
            print(f"  [{sym}] {ticker}  yes={ya}¢ no={na}¢  mid={mid:.0%}  "
                  f"pts={len(st.snaps)}  {mins_left:.1f}m left"
                  + (" [LIVE pos]" if st.position else "")
                  + signal_str, flush=True)

        # Write snapshot row
        with snap_log.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": ts,
                "markets": len(snap_markets),
                "exitCount": 0,
                "snapshot": {"markets": snap_markets},
            }) + "\n")

        # Flush training results periodically
        if resolved_results:
            update_train_report(resolved_results)
            acc = sum(1 for r in resolved_results if r.get("correct")) / max(1, sum(1 for r in resolved_results if r.get("had_signal")))
            sigs = sum(1 for r in resolved_results if r.get("had_signal"))
            print(f"\n  [TRAIN] {len(resolved_results)} windows resolved  {sigs} signals  acc={acc:.0%}", flush=True)
            resolved_results.clear()

        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
