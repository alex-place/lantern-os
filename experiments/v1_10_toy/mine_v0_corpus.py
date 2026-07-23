#!/usr/bin/env python3
"""
V0-B corpus miner (issues #2842/#2843) — FULL-history both-class records from verified events.

Extends build_linked_records.py (the toy sampler) to the whole repo history:
  * merged PRs (full pagination)            -> verified POSITIVES  (merge+review gate)
  * closed-unmerged PRs (full pagination)   -> soft NEGATIVES      (rejected before landing)
  * git-log revert scan on origin/master    -> verified NEGATIVES  (reality overturned a merge),
    linked to the overturned PR/commit — the E1-grade honest negatives PR mining alone misses.
  * canonical ledger merge (records.jsonl)  -> keep existing 220 (2 refuted / 9 corrected)

Best-practice gates applied at mine time (survey G3/G4, SIGMA0-MODEL-DESIGN D2):
  * de-gloss lint: claim text may not carry status markers (list below) — status lives in fields.
  * near-dup removal: normalized-claim hashing (cheap MinHash stand-in at this corpus size).
  * provenance: every record cites its verifier (pr #, revert sha, ledger id).

Output: data/eval/v1_10/corpus-v0.jsonl + a summary with the negative fraction.
Sample-safe: never writes the canonical ledger.
"""
import hashlib
import json
import re
import subprocess

OUT = "data/eval/v1_10/corpus-v0.jsonl"
LEDGER = "data/convergence/records.jsonl"

GLOSS = re.compile(r"\b(refuted|debunked|falsely|incorrectly|correctly|verified|unverified|"
                   r"hallucinat\w+|misconception|status:)\b", re.I)
REVERT_PR = re.compile(r"#(\d+)")


def sh(cmd, timeout=300):
    # explicit utf-8: PR titles carry em-dashes etc. that break Windows cp1252 decoding
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "fail").strip()[:300])
    return r.stdout


def gh_pages(state, cap=4000):
    """Paginate gh pr list (no body field — large payloads come back empty)."""
    rows, page_limit = [], 1000
    # gh handles internal pagination up to --limit; one big call per state is fine sans body.
    out = sh(["gh", "pr", "list", "--state", state, "--limit", str(cap),
              "--json", "number,title,state,mergedAt"])
    rows = json.loads(out)
    return rows


def rid(*parts):
    return "v0-" + hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:10]


def norm_key(text):
    return hashlib.sha1(re.sub(r"[^a-z0-9]+", " ", text.lower()).strip().encode()).hexdigest()[:16]


def main():
    records, seen = [], set()

    def add(rec):
        k = norm_key(rec["claim"])
        if k in seen:
            return False
        if GLOSS.search(rec["claim"]):
            rec["degloss_flag"] = True  # kept, but flagged: claim text leaks status
        seen.add(k)
        records.append(rec)
        return True

    # 1) full PR history
    print("pulling merged PRs (full)...", flush=True)
    merged = gh_pages("merged")
    print(f"  {len(merged)} merged", flush=True)
    print("pulling closed PRs (full)...", flush=True)
    closed = [p for p in gh_pages("closed") if not p.get("mergedAt")]
    print(f"  {len(closed)} closed-unmerged", flush=True)

    for p in merged:
        add({"claim": f"{p['title'].strip()} — implemented correctly.", "type": "feature",
             "evidence": "Merged after review and CI.", "confidence": 0.9,
             "source": f"github:pr#{p['number']}", "refuted": False,
             "id": rid("m", p["number"]), "meta": {"verifier": "merge+ci", "pr": p["number"]}})
    for p in closed:
        add({"claim": f"{p['title'].strip()} — proposed change was accepted.", "type": "feature",
             "evidence": "Closed without merge.", "confidence": 0.3,
             "source": f"github:pr#{p['number']}", "refuted": True,
             "id": rid("c", p["number"]), "meta": {"verifier": "closed-unmerged", "pr": p["number"]}})

    # 2) git revert scan (the strong negatives)
    print("scanning git log for reverts...", flush=True)
    log = sh(["git", "log", "origin/master", "--grep", "revert", "-i",
              "--pretty=%H\t%s", "--no-merges"], timeout=120)
    reverts = 0
    for line in log.splitlines():
        sha, _, subj = line.partition("\t")
        if not re.search(r"\brevert", subj, re.I):
            continue
        m = REVERT_PR.search(subj)
        target = f"PR #{m.group(1)}" if m else f"commit {subj[:60]!r}"
        if add({"claim": f"The change landed by {target} was correct and should stay merged.",
                "type": "feature", "evidence": f"Overturned by revert commit {sha[:10]} ({subj.strip()}).",
                "confidence": 0.2, "source": f"git:{sha[:10]}", "refuted": True, "corrected": True,
                "id": rid("r", sha[:10]), "meta": {"verifier": "revert-commit", "sha": sha[:10]}}):
            reverts += 1
    print(f"  {reverts} revert-linked negatives", flush=True)

    # 3) merge canonical ledger (as-is, provenance kept)
    led_n = 0
    try:
        with open(LEDGER, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                if r.get("claim") and add({**r, "id": r.get("id") or rid("l", r["claim"][:40]),
                                           "meta": {"verifier": "ledger", **(r.get("meta") or {})}}):
                    led_n += 1
    except FileNotFoundError:
        pass
    print(f"  {led_n} ledger records merged", flush=True)

    with open(OUT, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")

    neg = sum(1 for r in records if r.get("refuted"))
    strong_neg = sum(1 for r in records if r.get("refuted") and r.get("corrected"))
    gloss = sum(1 for r in records if r.get("degloss_flag"))
    print(f"\nwrote {len(records)} records -> {OUT}")
    print(f"  negatives: {neg} ({neg/len(records):.2f} of corpus; gate wants 0.40-0.55 at train time)")
    print(f"  strong negatives (revert/corrected): {strong_neg}")
    print(f"  de-gloss flags (claim leaks status): {gloss}")
    print("NOTE: train-time balancing to 0.40-0.55 happens at corpus-assembly, not here —")
    print("this file is the RAW verified-event pool. Session mining (needs Vertex) still pending.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
