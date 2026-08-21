"""Audit the convergence ledger against its own writer -- the core-object check nobody had run.

data/convergence/records.jsonl is the project's core epistemic object (CLAUDE.md: every important
claim must have [claim, evidence, confidence, source]). This audit reads every record and checks
what the fields actually mean, against the writer in apps/lantern-garage/lib/dream-chat.js.

Findings it verifies (2026-08-21, n=1230):
  F1 CIRCULARITY   confidence is assigned BY the grounding verdict at write time (0.85 grep-hit,
                   0.75 web-hit, 0.6 nothing, <=0.35 refuted). Reading the ledger's confidence as
                   a probability, or measuring its "calibration", is circular by construction.
  F2 VOCABULARY    the dominant tier (codebase-grep, 81% of grounded claims) greps TWO keywords
                   and cites any file listing them. Measured examples: "add(5,7) returns 12"
                   grounded by a skills doc; a TCP flow-control claim grounded by .mcp/settings.json.
                   It confirms the words exist, not that the claim is true.
  F3 DEAD TIER     the web-search confirmation tier fired ZERO times in the ledger's life; the
                   only 0.75-source records do not exist. Nothing alarmed on a dead grounding leg.
  F4 MONOCULTURE   only Gemini grounding can actively refute (20/638 claims ever refuted);
                   refuted=false overwhelmingly means "never challenged", not "survived challenge".
  F5 TEST TRAFFIC  security-eval prompts (attacker-controlled/untrusted-content scenarios, run
                   2026-07-16..19) wrote 493 records -- 40% of the ledger -- through the
                   production agent, and they are 63% of ALL records at confidence >= 0.75.

Output: prints the numbers, writes the quarantine id list for F5.

Run:  python scripts/audit_convergence_ledger.py [path-to-records.jsonl]
"""

from __future__ import annotations

import collections
import json
import os
import re
import sys

DEFAULT = os.path.join("C:" + os.sep, "dev", "lantern-os", "data", "convergence", "records.jsonl")
QUARANTINE = os.path.join(os.path.dirname(__file__), "..", "research", "ledger-audit", "quarantine-ids.jsonl")
TEST_PAT = re.compile(r"attacker|untrusted|ignore previous|prompt injection", re.I)


def content_words(t):
    return set(w.lower() for w in re.findall(r"[a-zA-Z]{5,}", str(t or "")))


def main(path=DEFAULT):
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    claims = [r for r in rows if "claim" in r]
    print(f"records {len(rows)}, claim-class {len(claims)}")

    # F1: confidence values cluster on the writer's constants
    conf = collections.Counter(round(r["confidence"], 2) for r in rows if isinstance(r.get("confidence"), (int, float)))
    top = conf.most_common(6)
    writer_constants = sum(n for v, n in conf.items() if v in (0.85, 0.75, 0.6, 0.8, 0.7))
    print(f"F1 confidence spectrum: top values {top}; on writer constants: {writer_constants}/{len(rows)}")

    # F2: grep-tier dominance
    src = collections.Counter(r.get("source") for r in claims)
    grounded = sum(n for s, n in src.items() if s and s != "none")
    print(f"F2 grounding sources: {src.most_common(4)}; codebase-grep share of grounded: "
          f"{src.get('codebase-grep', 0)}/{grounded}")

    # F3: dead web tier
    print(f"F3 web-search tier records: {src.get('web-search', 0)} (a confirmation path that never ran)")

    # F4: refutation monoculture
    refuted = [r for r in claims if r.get("refuted")]
    print(f"F4 refuted ever: {len(refuted)}/{len(claims)}; refuter sources: "
          f"{collections.Counter(r.get('source') for r in refuted).most_common(3)}")

    # F5: test traffic
    inj = [r for r in rows if TEST_PAT.search(str(r.get("hypothesis", "")) + str(r.get("userMessage", "")))]
    hi = [r for r in rows if isinstance(r.get("confidence"), (int, float)) and r["confidence"] >= 0.75]
    inj_ids = {id(r) for r in inj}
    hi_inj = [r for r in hi if id(r) in inj_ids]
    dates = collections.Counter(str(r.get("timestamp"))[:10] for r in inj)
    print(f"F5 security-test records: {len(inj)}/{len(rows)} ({100 * len(inj) / len(rows):.0f}%), dates {dates.most_common(4)}")
    print(f"   share of ALL conf>=0.75 records that are test traffic: {len(hi_inj)}/{len(hi)} "
          f"({100 * len(hi_inj) / max(1, len(hi)):.0f}%)")

    os.makedirs(os.path.dirname(QUARANTINE), exist_ok=True)
    with open(QUARANTINE, "w", encoding="utf-8") as f:
        for r in inj:
            f.write(json.dumps({"id": r.get("id"), "timestamp": r.get("timestamp"),
                                "confidence": r.get("confidence"),
                                "claim_head": str(r.get("claim") or r.get("hypothesis"))[:80]}) + "\n")
    print(f"-> quarantine list: {os.path.normpath(QUARANTINE)} ({len(inj)} rows)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT)
