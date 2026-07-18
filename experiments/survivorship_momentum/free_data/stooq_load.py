"""
Convert an extracted stooq bulk dump (d_us_txt.zip) into the prices/<TICKER>.json
schema the survivorship-free backtest expects: [{"date":"YYYY-MM-DD","adjClose":float}, ...]

stooq row format (per <ticker>.us.txt), header line then rows:
  <TICKER>,<PER>,<DATE>,<TIME>,<OPEN>,<HIGH>,<LOW>,<CLOSE>,<VOL>,<OPENINT>
  AAPL.US,D,20000103,000000,0.9422,0.9989,0.9280,0.9991,535796800,0
Notes:
  - <CLOSE> is split-adjusted but NOT dividend-adjusted -> fine for momentum RANKING
    (cross-sectional; dividend yield is small & similar across names). Flagged in output.
  - delisted names simply have data ending at their last trading day (the whole point).
Usage: python stooq_load.py <extracted_root_dir>
Writes prices_stooq/<TICKER>.json and a coverage report.
"""
import os, sys, json, glob

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "prices_stooq"); os.makedirs(OUT, exist_ok=True)

def norm_ticker(fname):
    # aapl.us.txt -> AAPL ; brk-b.us.txt -> BRK-B (fja05680 uses BRK.B; caller maps variants)
    base = os.path.basename(fname).lower()
    if base.endswith(".us.txt"): base = base[:-7]
    return base.upper()

def parse_file(path):
    out = []
    with open(path, "r", errors="ignore") as f:
        for i, line in enumerate(f):
            p = line.strip().split(",")
            if len(p) < 8: continue
            if p[2].upper() == "<DATE>" or not p[2].isdigit(): continue  # header
            d = p[2]  # YYYYMMDD
            try: close = float(p[7])
            except ValueError: continue
            if close <= 0: continue
            out.append({"date": f"{d[:4]}-{d[4:6]}-{d[6:8]}", "adjClose": close})
    out.sort(key=lambda r: r["date"])
    return out

def main(root):
    # US daily files live under data/daily/us/**/  (nasdaq stocks, nyse stocks, nysemkt/amex, etc.)
    pats = [os.path.join(root, "**", "*.us.txt"), os.path.join(root, "**", "*.US.txt")]
    files = []
    for pat in pats: files += glob.glob(pat, recursive=True)
    files = sorted(set(files))
    print(f"found {len(files)} *.us.txt files under {root}")
    have = 0; empty = 0
    for fp in files:
        t = norm_ticker(fp)
        rows = parse_file(fp)
        if len(rows) >= 60:
            json.dump(rows, open(os.path.join(OUT, f"{t}.json"), "w"))
            have += 1
        else:
            empty += 1
    print(f"wrote {have} ticker files (>=60 rows); skipped {empty} sparse")
    # quick delisted sanity: do we have the classic dead names?
    for probe in ["LEH","ENRNQ","WCOM","BSC","GM","JCP","S","DF","BIG"]:
        f = os.path.join(OUT, f"{probe}.json")
        if os.path.exists(f):
            rows = json.load(open(f))
            print(f"  delisted-probe {probe}: {len(rows)} rows, last={rows[-1]['date']}")
        else:
            print(f"  delisted-probe {probe}: MISSING")
    print("NOTE: stooq close is split-adj, not dividend-adj (fine for momentum ranking).")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python stooq_load.py <extracted_root_dir>"); sys.exit(1)
    main(sys.argv[1])
