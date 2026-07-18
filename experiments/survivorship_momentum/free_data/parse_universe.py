import csv, json, os
from datetime import date

BASE = os.path.dirname(os.path.abspath(__file__))
WIN_START = date(2013, 1, 1)      # need price history from here for first 12-1 signal
WIN_END   = date(2026, 6, 30)

def pd(s):
    s = (s or "").strip()
    if not s: return None
    y, m, d = s.split("-")
    return date(int(y), int(m), int(d))

spans = {}  # ticker -> list of (start, end)
with open(os.path.join(BASE, "ticker_start_end.csv"), newline="") as f:
    for row in csv.DictReader(f):
        t = row["ticker"].strip()
        s = pd(row["start_date"]); e = pd(row["end_date"])
        spans.setdefault(t, []).append((s, e))

ever = []          # members overlapping the window
delisted_in_win = []  # left the index inside the window and never returned
for t, sp in spans.items():
    # overlaps window if any span intersects [WIN_START, WIN_END]
    overlaps = any((s or date(1900,1,1)) <= WIN_END and (e or date(2100,1,1)) >= WIN_START for s, e in sp)
    if not overlaps: continue
    ever.append(t)
    ends = [e for s, e in sp]
    last_end = None if any(e is None for e in ends) else max(ends)
    if last_end is not None and WIN_START <= last_end <= WIN_END:
        delisted_in_win.append((t, last_end.isoformat()))

ever = sorted(set(ever))
delisted_in_win.sort(key=lambda x: x[1])
print(f"ever-members overlapping [{WIN_START}..{WIN_END}]: {len(ever)}")
print(f"of which left the index in-window (delisted/acquired/removed): {len(delisted_in_win)}")
print("sample delisted-in-window:", [t for t,_ in delisted_in_win[:20]])
json.dump({"window":[WIN_START.isoformat(),WIN_END.isoformat()],
           "ever":ever,
           "delisted_in_window":delisted_in_win},
          open(os.path.join(BASE,"universe.json"),"w"), indent=0)
print("wrote universe.json")
