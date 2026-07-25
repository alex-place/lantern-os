"""Extract per-market price paths from the tight-band 6s snapshots (KXMLBGAME).

Feeds the autonomous entry/exit backtest. The prior Kalshi refutations
([[kalshi-no-taker-edge]], the weather cert) all covered OTHER market classes (crypto 15M,
KXHIGH* weather) and all held to resolution. This data is 100% KXMLBGAME — live in-game
baseball markets — a class never tested, and the only data we have with the 6-second price
PATH needed to test EXITS at all.

LIQUIDITY DISCIPLINE (the thing that makes or breaks honesty here): the raw feed contains
untradeable quotes — e.g. yes_bid=13 / yes_ask=93 with volume=0 and open_interest=0. A
backtest that fills against those is fiction. A snapshot row is kept ONLY if:
  - status == 'active'
  - both sides quoted (0 < yes_bid < yes_ask < 100)
  - spread <= MAX_SPREAD cents
  - quoted size on BOTH sides >= MIN_SIZE contracts
  - open_interest > 0  (someone is actually positioned in this market)

Output: experiments/results/kalshi_mlb_paths.jsonl — one row per market:
  {ticker, day, n, path:[[epoch_s, yes_bid, yes_ask, yes_bid_size, yes_ask_size, oi], ...],
   final_status, final_result}

Run:  python experiments/kalshi_mlb_path_extract.py
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

SRC = [("2026-07-21", os.path.join("data", "kalshi", "tight-band-2026-07-21.jsonl")),
       ("2026-07-22", os.path.join("data", "kalshi", "tight-band-2026-07-22.jsonl"))]
OUT = os.path.join("experiments", "results", "kalshi_mlb_paths.jsonl")

MAX_SPREAD = 5      # cents — wider than this is not realistically crossable twice
MIN_SIZE = 5        # contracts quoted on each side
MIN_PATH = 20       # >= 20 usable snapshots (~2 min) or the market is not analysable


def parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp()
    except Exception:
        return None


def fnum(v, d=0.0):
    try:
        return float(v)
    except Exception:
        return d


def main():
    paths = {}          # ticker -> dict(day, rows[], last_status, last_result)
    kept = dropped = snaps = 0
    for day, src in SRC:
        if not os.path.exists(src):
            print(f"MISSING {src}")
            continue
        with open(src, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                snaps += 1
                snap = rec.get("snapshot") or {}
                for m in snap.get("markets", []):
                    tk = m.get("ticker")
                    if not tk:
                        continue
                    st = m.get("status", "")
                    res = m.get("result", "") or ""
                    # always track terminal state even if the quote row is unusable
                    p = paths.setdefault(tk, {"day": day, "rows": [], "status": st, "result": res})
                    if st:
                        p["status"] = st
                    if res:
                        p["result"] = res
                    yb, ya = m.get("yes_bid"), m.get("yes_ask")
                    if yb is None or ya is None:
                        dropped += 1
                        continue
                    yb, ya = int(yb), int(ya)
                    ybs = fnum(m.get("yes_bid_size_fp"))
                    yas = fnum(m.get("yes_ask_size_fp"))
                    oi = fnum(m.get("open_interest_fp"))
                    ok = (st == "active" and 0 < yb < ya < 100 and (ya - yb) <= MAX_SPREAD
                          and ybs >= MIN_SIZE and yas >= MIN_SIZE and oi > 0)
                    if not ok:
                        dropped += 1
                        continue
                    ts = parse_ts(rec.get("ts") or snap.get("generatedAt") or "")
                    if ts is None:
                        dropped += 1
                        continue
                    p["rows"].append([round(ts, 1), yb, ya, ybs, yas, oi])
                    kept += 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    written = 0
    with open(OUT, "w", encoding="utf-8") as f:
        for tk, p in paths.items():
            rows = sorted(p["rows"], key=lambda r: r[0])
            # de-dup identical consecutive timestamps
            ded = []
            for r in rows:
                if not ded or r[0] != ded[-1][0]:
                    ded.append(r)
            if len(ded) < MIN_PATH:
                continue
            f.write(json.dumps({"ticker": tk, "day": p["day"], "n": len(ded),
                                "final_status": p["status"], "final_result": p["result"],
                                "path": ded}) + "\n")
            written += 1

    print(f"snapshots read      : {snaps}")
    print(f"quote rows kept     : {kept}")
    print(f"quote rows dropped  : {dropped}  (illiquid / wide / inactive / unparseable)")
    print(f"markets w/ >= {MIN_PATH} rows: {written}  (of {len(paths)} seen)")
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
