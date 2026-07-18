"""Robust deep-history market-data cache for the leverage-overlay research.

The live overlay universe (SPY/QQQ/IWM/EFA/TLT/GLD) is ETF-based, so its history
can't reach before ~2000-2004 (ETF inception). To stress-test the brake overlay
across FAR more crisis regimes (1973-74 stagflation bear, 1987 Black Monday,
1990, 2000, 2008, 2020, 2022) we pull the underlying INDEX proxies, which reach
decades further:

  ^GSPC  S&P 500           1927+   (SPY proxy — US large cap)
  ^IXIC  Nasdaq Composite  1971+   (QQQ proxy — US growth/tech)
  ^RUT   Russell 2000      1987+   (IWM proxy — US small cap)
  GC=F   Gold futures      2000+   (GLD proxy — real asset)

Yahoo's chart endpoint returns the whole daily series in one large payload, which
intermittently trips urllib's IncompleteRead / OSError on the biggest symbols.
We read the body defensively (retry + tolerate a short read) and cache to a local
JSON so downstream experiments never re-fetch. Cache is honest: it records the
fetch timestamp and the true first/last date per symbol, nothing synthesised.
"""
import calendar
import json
import sys
import time
import urllib.request
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.client import IncompleteRead
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
CACHE = HERE / "deep_history.json"

# Windows can't do datetime.timestamp()/utcfromtimestamp() for pre-1970 (negative
# POSIX) times — it raises OSError[22]. calendar.timegm + epoch-plus-timedelta are
# the portable path, and are what let us reach 1927/1962 at all.
_EPOCH = datetime(1970, 1, 1)
def _year_to_ts(year):
    return calendar.timegm(datetime(year, 1, 1).timetuple())
def _ts_to_date(t):
    return (_EPOCH + timedelta(seconds=int(t))).strftime("%Y-%m-%d")

# symbol -> earliest year to request (Yahoo clamps to true inception)
PROXIES = {
    "^GSPC": 1927,   # S&P 500 — US large cap, deepest history (1929, 1937, ...)
    "^IXIC": 1971,   # Nasdaq Composite — US growth/tech (dot-com -78%)
    "^RUT": 1987,    # Russell 2000 — US small cap
    "GC=F": 2000,    # Gold futures — real asset
    "^TNX": 1962,    # 10Y Treasury yield — for a bond total-return proxy
}


def _fetch_raw(sym, start_year, attempts=4):
    p1 = _year_to_ts(start_year)
    p2 = calendar.timegm(datetime.utcnow().timetuple())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(sym)}?interval=1d&period1={p1}&period2={p2}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (UnisonaSim)"})
    last_err = None
    for k in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                try:
                    body = r.read()
                except IncompleteRead as e:
                    body = e.partial  # tolerate a short read; JSON may still parse
            return json.loads(body)
        except (IncompleteRead, OSError, ValueError) as e:
            last_err = e
            time.sleep(1.5 * (k + 1))
    raise last_err


def fetch_series(sym, start_year):
    j = _fetch_raw(sym, start_year)
    res = j["chart"]["result"][0]
    ts = res["timestamp"]
    adj = res["indicators"]["adjclose"][0]["adjclose"]
    out = {}
    for t, a in zip(ts, adj):
        if a is None:
            continue
        out[_ts_to_date(t)] = float(a)
    return out


def build_cache(force=False):
    if CACHE.exists() and not force:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    data = {"_fetched_at": datetime.now(timezone.utc).isoformat(), "series": {}, "meta": {}}
    for sym, yr in PROXIES.items():
        try:
            s = fetch_series(sym, yr)
            data["series"][sym] = s
            ds = sorted(s)
            data["meta"][sym] = {"first": ds[0], "last": ds[-1], "n": len(ds)}
            print(f"  {sym}: {ds[0]} to {ds[-1]}  ({len(ds)} pts)")
        except Exception as e:
            data["meta"][sym] = {"error": f"{type(e).__name__}: {str(e)[:80]}"}
            print(f"  {sym}: FAILED {type(e).__name__}: {str(e)[:80]}")
    CACHE.write_text(json.dumps(data), encoding="utf-8")
    print(f"wrote {CACHE.name} ({CACHE.stat().st_size//1024} KB)")
    return data


if __name__ == "__main__":
    build_cache(force="--force" in sys.argv)
