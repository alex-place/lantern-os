import os, json, re
BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "prices_stooq")

def norm(t): return re.sub(r'[^A-Z0-9]', '', t.upper())

# stooq tickers we actually parsed
stooq = {}
for fn in os.listdir(OUT):
    if fn.endswith(".json"):
        stooq[norm(fn[:-5])] = fn[:-5]
print(f"stooq parsed tickers: {len(stooq)}")

uni = json.load(open(os.path.join(BASE, "universe.json")))
ever = uni["ever"]
delisted = [t for t, _ in uni["delisted_in_window"]]
survivors = [t for t in ever if t not in set(delisted)]

def cov(names):
    hit = [t for t in names if norm(t) in stooq]
    return hit

ever_hit = cov(ever); surv_hit = cov(survivors); del_hit = cov(delisted)
print(f"\nS&P 500 ever-members 2013-2026: {len(ever)}")
print(f"  covered by stooq bulk: {len(ever_hit)} ({100*len(ever_hit)/len(ever):.0f}%)")
print(f"survivors (still in index): {len(survivors)} -> covered {len(surv_hit)} ({100*len(surv_hit)/len(survivors):.0f}%)")
print(f"DELISTED cohort (left index in-window): {len(delisted)} -> covered {len(del_hit)} ({100*len(del_hit)/max(1,len(delisted)):.0f}%)")
missing_del = [t for t in delisted if norm(t) not in stooq]
print(f"\nmissing delisted (sample 30 of {len(missing_del)}):")
print("  ", missing_del[:30])
present_del = [t for t in delisted if norm(t) in stooq]
print(f"present delisted (sample 20 of {len(present_del)}):")
print("  ", present_del[:20])
json.dump({"stooq_n":len(stooq),"ever":len(ever),"ever_cov":len(ever_hit),
           "survivors":len(survivors),"surv_cov":len(surv_hit),
           "delisted":len(delisted),"del_cov":len(del_hit),
           "missing_delisted":missing_del},
          open(os.path.join(BASE,"stooq_coverage.json"),"w"), indent=0)
