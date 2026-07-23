#!/usr/bin/env python3
"""
v1.10 TOY — training-set EXPANSION by linking PRs (and sessions) into VERIFIED records.

The 220 records in data/convergence/records.jsonl are overwhelmingly confident POSITIVES
(2 refuted, 9 corrected). That is the E1 problem in the data itself: almost no honest
NEGATIVES to learn "this looked right and was wrong" from.

But the repo already contains thousands of ground-truth verification events we never mined:

  * A MERGED PR that passed CI  = a VERIFIED POSITIVE   (claim: "<intent> is done correctly";
                                  evidence: CI-green + human review + merge).
  * A PR REVERTED by a later PR = a VERIFIED NEGATIVE   (claim was accepted, then reality
                                  overturned it; the reverting PR is the correction).
  * A CLOSED-unmerged PR        = a soft negative        (proposed, rejected before landing).

This toy demonstrates the LINKING mechanism on a small live sample: it pulls recent PRs via
`gh`, classifies each as a verification event, and for reverts LINKS the reverting PR back to
the PR it overturned — emitting both-class records in the SAME schema as records.jsonl, with
provenance that points at the verifier (pr number, CI conclusion, revert link).

This is the seed of the real expansion (issue: run session_to_convergence.py over all 243
sessions + pr_crystallize.py + this negative-miner over all ~2840 PRs). It writes a SAMPLE,
never the canonical ledger, so it is safe to run repeatedly.

    C:/dev/lantern-os/.venv-train/Scripts/python.exe experiments/v1_10_toy/build_linked_records.py \
        --repo alex-place/lantern-os --limit 120 --out experiments/v1_10_toy/linked-records.sample.jsonl
"""
import argparse
import hashlib
import json
import re
import subprocess


def gh_json(args):
    out = subprocess.run(["gh"] + args, capture_output=True, text=True, timeout=180)
    if out.returncode != 0 or not (out.stdout or "").strip():
        raise RuntimeError((out.stderr or "empty stdout").strip()[:400])
    return json.loads(out.stdout)


def rid(*parts):
    return "cr-pr-" + hashlib.sha1("|".join(parts).encode()).hexdigest()[:10]


REVERT_RE = re.compile(r'\brevert(?:s|ed|ing)?\b.*?#(\d+)|\brevert(?:s|ed|ing)?\b\s+"?(?:pr\s*)?#?(\d+)',
                       re.IGNORECASE)


def find_reverted_number(title, body):
    for m in REVERT_RE.finditer(f"{title}\n{body or ''}"):
        num = m.group(1) or m.group(2)
        if num:
            return int(num)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="alex-place/lantern-os")
    ap.add_argument("--limit", type=int, default=120)
    ap.add_argument("--out", default="experiments/v1_10_toy/linked-records.sample.jsonl")
    a = ap.parse_args()

    print(f"pulling {a.limit} PRs from {a.repo} ...")
    # Light query (title carries revert markers; CI rollup omitted — it 504s on large limits,
    # and the merge/revert/closed classification does not need it). CI marked 'unknown'.
    # Omit 'body' — it balloons the payload (gh returns empty on large limits). Revert markers
    # ("Revert ... #NNNN", "reverts #NNNN") reliably appear in PR TITLES, which is enough here.
    prs = gh_json(["pr", "list", "--repo", a.repo, "--state", "all", "--limit", str(a.limit),
                   "--json", "number,title,state,mergedAt"])

    records, pos, neg, soft, reverts = [], 0, 0, 0, 0
    for pr in prs:
        num, title = pr["number"], (pr.get("title") or "").strip()
        body = pr.get("body") or ""
        merged = bool(pr.get("mergedAt"))
        # CI conclusion (best-effort): green if no failing/erroring checks recorded.
        checks = pr.get("statusCheckRollup") or []
        bad = [c for c in checks if str(c.get("conclusion", "")).upper() in ("FAILURE", "ERROR", "CANCELLED")]
        ci = "green" if (checks and not bad) else ("red" if bad else "unknown")
        reverted = find_reverted_number(title, body)

        if reverted is not None:
            # VERIFIED NEGATIVE: PR #reverted was accepted then overturned by this PR.
            reverts += 1
            neg += 1
            records.append({
                "claim": f"PR #{reverted}'s change was correct and should stay merged.",
                "type": "feature", "evidence": f"Overturned by PR #{num} ({title!r}).",
                "confidence": 0.2, "source": f"github:{a.repo}#{num}",
                "sources": [f"pr:{num}", f"pr:{reverted}"],
                "refuted": True, "corrected": True, "agent": "pr-negative-miner",
                "id": rid(a.repo, str(reverted), "reverted"),
                "meta": {"verifier": "revert-link", "reverting_pr": num, "reverted_pr": reverted},
            })
        elif merged:
            pos += 1
            records.append({
                "claim": f"{title} — implemented correctly.",
                "type": "feature", "evidence": f"Merged after review; CI {ci}.",
                "confidence": 0.9 if ci == "green" else 0.7, "source": f"github:{a.repo}#{num}",
                "sources": [f"pr:{num}"], "refuted": False, "corrected": False,
                "agent": "pr-positive-miner", "id": rid(a.repo, str(num), "merged"),
                "meta": {"verifier": "merge+ci", "ci": ci, "pr": num},
            })
        elif pr.get("state") == "CLOSED":
            soft += 1
            neg += 1
            records.append({
                "claim": f"{title} — proposed change was accepted.",
                "type": "feature", "evidence": f"Closed without merge (rejected before landing).",
                "confidence": 0.3, "source": f"github:{a.repo}#{num}",
                "sources": [f"pr:{num}"], "refuted": True, "corrected": False,
                "agent": "pr-negative-miner", "id": rid(a.repo, str(num), "closed"),
                "meta": {"verifier": "closed-unmerged", "pr": num},
            })

    with open(a.out, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")

    total = len(records)
    print(f"\nwrote {total} linked records -> {a.out}")
    print(f"  verified POSITIVE (merged+CI):     {pos}")
    print(f"  verified NEGATIVE (revert-linked): {reverts}")
    print(f"  soft NEGATIVE (closed-unmerged):   {soft}")
    if total:
        print(f"  negative fraction: {neg/total:.2f}  (E1 wants 0.40-0.55 for a balanced honesty corpus)")
    print("\nThis is a SAMPLE seed. Full expansion = this miner over all ~2840 PRs +")
    print("session_to_convergence.py over all 243 sessions, then de-gloss lint + decontaminate + LOSO split.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
