"""
Resumable Tiingo EOD fetcher with a PERSISTENT sliding-window rate limiter.
Free tier ~= 50 requests/hour, 500 unique symbols/month. This paces proactively
(<=48/hr) so it does not hammer 429s, and the request log persists to disk so the
limiter survives restarts (the job is resumable across the hourly windows).
Usage: python fetch_tiingo.py [max_new]
Reads priority.json (fetch order); writes prices/<ticker>.json; logs to fetch.log.
"""
import json, os, sys, time, urllib.request, urllib.error

BASE = os.path.dirname(os.path.abspath(__file__))
KEY = open(os.path.join(BASE, "tiingo.key")).read().strip()
PRICES = os.path.join(BASE, "prices"); os.makedirs(PRICES, exist_ok=True)
LOG = os.path.join(BASE, "fetch.log")
REQLOG = os.path.join(BASE, "requests.log")  # persistent request timestamps
START, END = "2012-06-01", "2026-06-30"
HOUR = 3600; MAX_PER_HR = 48

def log(m):
    line = f"[{int(time.time())}] {m}"; print(line, flush=True)
    open(LOG, "a").write(line + "\n")

def req_times():
    if not os.path.exists(REQLOG): return []
    return [float(x) for x in open(REQLOG).read().split() if x.strip()]

def note_req(t): open(REQLOG, "a").write(f"{t}\n")

def wait_for_slot():
    while True:
        now = time.time()
        recent = [t for t in req_times() if now - t < HOUR]
        if len(recent) < MAX_PER_HR: return
        sleep = HOUR - (now - min(recent)) + 2
        log(f"rate window full ({len(recent)}/{MAX_PER_HR}); sleeping {int(sleep)}s")
        time.sleep(min(sleep, 300))  # cap single sleep so we re-check

def fetch(t):
    url = (f"https://api.tiingo.com/tiingo/daily/{t}/prices"
           f"?startDate={START}&endDate={END}&columns=date,adjClose&token={KEY}")
    req = urllib.request.Request(url, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

prio = json.load(open(os.path.join(BASE, "priority.json")))["priority"]
max_new = int(sys.argv[1]) if len(sys.argv) > 1 else len(prio)
have=empty=err=newn=0
for t in prio:
    out = os.path.join(PRICES, f"{t}.json")
    if os.path.exists(out): continue
    if newn >= max_new: break
    wait_for_slot()
    ok=False
    for attempt in range(5):
        note_req(time.time())
        try:
            data = fetch(t)
            json.dump(data if data else [], open(out, "w"))
            have += (1 if data else 0); empty += (0 if data else 1); ok=True; break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                ra = int(e.headers.get("Retry-After","60") or "60")
                log(f"429 {t} a{attempt}; sleep {ra}s"); time.sleep(ra+1); continue
            if e.code == 404:
                json.dump([], open(out,"w")); empty+=1; ok=True; break
            log(f"HTTP {e.code} {t}"); err+=1; break
        except Exception as e:
            log(f"ERR {t}: {e}"); time.sleep(3)
    newn += 1
    if newn % 20 == 0:
        files=[f for f in os.listdir(PRICES) if f.endswith('.json')]
        ne=sum(1 for f in files if os.path.getsize(os.path.join(PRICES,f))>3)
        log(f"progress new={newn} have={have} empty={empty} err={err} | on-disk {ne}/{len(files)} nonempty")
    time.sleep(1.0)

files=[f for f in os.listdir(PRICES) if f.endswith('.json')]
ne=sum(1 for f in files if os.path.getsize(os.path.join(PRICES,f))>3)
log(f"DONE new={newn} have={have} empty={empty} err={err} | TOTAL on-disk {ne}/{len(files)} nonempty")
