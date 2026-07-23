#!/usr/bin/env python3
"""
M1 longitudinal ledger test (issue #2786; audited-candidate ✓ per #2860).

The invariant under test — No-Free-Confidence, in its enforceable form:
    a claim's recorded confidence may RISE between two ledger entries
    ONLY IF new external evidence arrived in between.
    (Delta-J <= eta*Delta-E - lambda*U; empirically: P(dJ>0 | no new evidence) ~ 0.)

This replays the REAL canonical ledger (data/convergence/records.jsonl) chronologically,
groups records into per-claim chains (normalized claim text), and for every consecutive
pair in a chain classifies the confidence move:

    RISE+EVIDENCE   ok      (paid for by new sources/evidence text)
    RISE+NO-EVIDENCE VIOLATION  (free confidence — exactly what M1 forbids)
    FLAT / FALL      ok      (supermartingale-compatible)
    RISE after refutation-clear ok if evidence present

Output: per-chain audit + the headline violation rate. Honest outcomes:
  * violations found  -> M1 is DOING WORK (the ledger's own history breaks it; gate needed)
  * zero violations   -> ledger already M1-clean (invariant holds vacuously or by discipline)
  * too few chains    -> "insufficient longitudinal data" — then this script IS the go-forward
                         instrument (run per-session; wire into the Verify gate later).

    .venv-train python experiments/v1_10_toy/m1_ledger_check.py
"""
import hashlib
import json
import re
from collections import defaultdict

LEDGER = "data/convergence/records.jsonl"


def norm_claim(text):
    return hashlib.sha1(re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip().encode()).hexdigest()[:16]


def evidence_key(rec):
    """A cheap fingerprint of the evidence basis: sources + evidence text + refuted flag."""
    src = rec.get("sources") or ([rec.get("source")] if rec.get("source") else [])
    ev = (str(rec.get("evidence") or ""))[:400]
    return hashlib.sha1((("|".join(sorted(map(str, src)))) + "###" + ev).encode()).hexdigest()[:16]


def main():
    recs = []
    with open(LEDGER, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                r = json.loads(line)
                if r.get("claim"):
                    recs.append(r)
    recs.sort(key=lambda r: str(r.get("timestamp") or ""))

    chains = defaultdict(list)
    for r in recs:
        chains[norm_claim(r["claim"])].append(r)
    multi = {k: v for k, v in chains.items() if len(v) >= 2}

    print(f"ledger records: {len(recs)} | claim-chains: {len(chains)} | longitudinal (>=2 entries): {len(multi)}")

    pairs = rises = free_rises = falls = flats = 0
    violations = []
    for key, chain in multi.items():
        for a, b in zip(chain, chain[1:]):
            pairs += 1
            ca, cb = float(a.get("confidence") or 0), float(b.get("confidence") or 0)
            new_evidence = evidence_key(a) != evidence_key(b)
            if cb > ca + 1e-9:
                rises += 1
                if not new_evidence:
                    free_rises += 1
                    violations.append({
                        "claim": a["claim"][:100], "from": ca, "to": cb,
                        "t0": str(a.get("timestamp"))[:19], "t1": str(b.get("timestamp"))[:19],
                    })
            elif cb < ca - 1e-9:
                falls += 1
            else:
                flats += 1

    print(f"consecutive pairs: {pairs} | rises: {rises} | falls: {falls} | flats: {flats}")
    if pairs == 0:
        print("\nVERDICT: INSUFFICIENT LONGITUDINAL DATA — no claim has >=2 ledger entries yet.")
        print("This script becomes the go-forward instrument: run it per-session; every future")
        print("re-assertion of a claim is a pair, and free rises will surface here first.")
        return 0

    rate = free_rises / max(1, rises) if rises else 0.0
    print(f"\nFREE RISES (confidence up, no new evidence): {free_rises}"
          f"  ({rate:.0%} of all rises)" if rises else "\nno rises at all")
    for v in violations[:10]:
        print(f"  VIOLATION {v['from']:.2f}->{v['to']:.2f}  {v['t0']} -> {v['t1']}  {v['claim']}")
    if free_rises:
        print(f"\nVERDICT: M1 DOES WORK on this ledger — {free_rises} free-confidence rise(s) that an")
        print("enforced gate would have blocked/flagged. The invariant is not vacuous here.")
    else:
        print("\nVERDICT: ledger is M1-CLEAN on available chains (no free rises). The invariant")
        print("holds on history; the gate's value is prospective (blocking future violations).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
