import csv, json, os
from datetime import date
BASE = os.path.dirname(os.path.abspath(__file__))
def pd(s):
    s=(s or "").strip()
    if not s: return None
    y,m,d=s.split("-"); return date(int(y),int(m),int(d))

spans={}
with open(os.path.join(BASE,"ticker_start_end.csv"),newline="") as f:
    for row in csv.DictReader(f):
        spans.setdefault(row["ticker"].strip(),[]).append((pd(row["start_date"]),pd(row["end_date"])))

WIN_S=date(2013,1,1); WIN_E=date(2026,6,30)
survivors=[]; delisted_cov=[]; delisted_old=[]
for t,sp in spans.items():
    if not any((s or date(1900,1,1))<=WIN_E and (e or date(2100,1,1))>=WIN_S for s,e in sp): continue
    ends=[e for s,e in sp]
    if any(e is None for e in ends):
        survivors.append(t); continue
    last=max(ends)
    if last>=date(2013,1,1): delisted_cov.append((t,last.isoformat()))   # Tiingo likely has these
    else: delisted_old.append(t)                                          # Tiingo won't -> skip (save quota)

delisted_cov.sort(key=lambda x:x[1])
survivors=sorted(survivors)
# priority: bias-carriers first (delisted 2013+), then survivor core; cap under 500/mo (headroom for probes already spent)
CAP=440
prio=[t for t,_ in delisted_cov] + [t for t in survivors if t not in {x[0] for x in delisted_cov}]
prio=prio[:CAP]
# always include SPY benchmark
if "SPY" not in prio: prio.append("SPY")
json.dump({"priority":prio,
           "n_delisted_2013plus":len(delisted_cov),
           "n_survivors":len(survivors),
           "n_delisted_pre2013_skipped":len(delisted_old),
           "cap":CAP},
          open(os.path.join(BASE,"priority.json"),"w"),indent=0)
print(f"delisted 2013+ (bias-carriers, prioritized): {len(delisted_cov)}")
print(f"survivors: {len(survivors)}")
print(f"delisted pre-2013 (skipped, Tiingo lacks): {len(delisted_old)}")
print(f"priority fetch list (capped {CAP}, +SPY): {len(prio)}")
print("first 12 bias-carriers:", [t for t,_ in delisted_cov[:12]])
