#!/usr/bin/env python3
"""
repair_convergence_records.py — retroactively make ConvergenceRecords honest.

The ledger only calibrates/selects honestly if `verified` means "reality confirmed it,"
not "the reasoner asserted it." Legacy records (the research-loop store) marked
`verified:True` on notes that literally say "single-source; unverified" — the exact
confidence-laundering the collapse cert warns about. This normalizes them and, optionally,
merges the honest versions into the canonical ledger.

Honest-verified rule (conservative — demote, never promote a weak record):
  * `verified` stays True ONLY if the evidence shows genuine multi-source corroboration
    ("corroborated by N independent sources", N>=2) AND no "single-source"/"unverified" note.
  * "single-source" / "unverified" / no grounding  ->  verified=False (not refuted — just
    UNCONFIRMED; kept as an open claim, both-class-safe).
  * confidence capped at allowed_max_confidence (or 0.5 when a demoted record had none).
  * source domain lifted out of the note into `source` when the `source` field was null.
  * every change is auditable: `repaired:true`, `original_verified`, `repair_note`.

Modes:
  --normalize <store>            rewrite a store in place (writes <store>.bak first)
  --merge <src> --into <dst>     append honest, de-duplicated records from src into dst
  --set-refuted <ledger> --ids a,b,c    flip specific record ids to refuted=true (fix a mislabel)
  --dry-run
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import shutil
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

CORROB = re.compile(r"corroborated by (\d+)\s+independent", re.I)
SINGLE = re.compile(r"single[- ]source|unverified|not verified|assumed|placeholder", re.I)
DOMAIN = re.compile(r"\(([a-z0-9.-]+\.[a-z]{2,})\)", re.I)


def load(p: Path):
    if not p.exists():
        return []
    out = []
    for line in p.open(encoding="utf-8", errors="replace"):
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def clamp01(x, d=0.5):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return d
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def honest(rec: dict) -> tuple[dict, bool]:
    """Return (repaired_record, changed)."""
    notes = f"{rec.get('verification_notes') or ''} {rec.get('evidence') or ''}"
    orig = bool(rec.get("verified"))
    m = CORROB.search(notes)
    corroborated = bool(m and int(m.group(1)) >= 2)
    single = bool(SINGLE.search(notes))
    new_verified = bool(corroborated and not single)

    conf = clamp01(rec.get("confidence", 0.5))
    amc = rec.get("allowed_max_confidence")
    if amc is not None:
        conf = min(conf, clamp01(amc, 1.0))
    if not new_verified:
        conf = min(conf, 0.5)  # an unconfirmed claim can't carry high confidence

    src = rec.get("source")
    if src in (None, "", "None"):
        dm = DOMAIN.search(notes)
        if dm:
            src = dm.group(1)

    changed = (new_verified != orig) or (conf != clamp01(rec.get("confidence", 0.5))) or (src != rec.get("source"))
    if not changed:
        return rec, False
    out = dict(rec)
    out["verified"] = new_verified
    out["confidence"] = conf
    out["source"] = src
    out["repaired"] = True
    out["original_verified"] = orig
    out["repair_note"] = ("kept-verified: multi-source corroboration" if new_verified
                          else "demoted: single-source/unverified — not confirmed")
    out["repaired_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return out, True


def write_jsonl(path: Path, rows):
    with path.open("w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")


def cmd_normalize(store: Path, dry: bool):
    rows = load(store)
    repaired = [honest(r) for r in rows]
    n = sum(1 for _, c in repaired if c)
    demoted = sum(1 for r, c in repaired if c and not r["verified"])
    kept = sum(1 for r, c in repaired if c and r["verified"])
    print(f"[repair] {store.name}: {len(rows)} rows | changed={n} (demoted={demoted} kept-verified={kept})")
    if dry:
        return
    shutil.copyfile(store, store.with_suffix(store.suffix + ".bak"))
    write_jsonl(store, [r for r, _ in repaired])
    print(f"[repair] rewrote {store} (backup: {store.name}.bak)")


def cmd_merge(src: Path, dst: Path, dry: bool):
    src_rows = [honest(r)[0] for r in load(src)]
    have = {r.get("id") for r in load(dst)}
    fresh = [r for r in src_rows if r.get("id") and r["id"] not in have]
    for r in fresh:
        tags = set(r.get("tags") or [])
        tags.update(["merged-from-research", "repaired"])
        r["tags"] = sorted(tags)
    v = sum(1 for r in fresh if r.get("verified"))
    print(f"[repair] merge {src.name} -> {dst.name}: {len(fresh)} new (verified={v} unconfirmed={len(fresh)-v}), "
          f"{len(src_rows)-len(fresh)} already present")
    if dry:
        return
    shutil.copyfile(dst, dst.with_suffix(dst.suffix + ".bak"))
    with dst.open("a", encoding="utf-8") as fh:
        for r in fresh:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"[repair] appended {len(fresh)} -> {dst} (backup: {dst.name}.bak)")


def cmd_set_refuted(ledger: Path, ids: set, dry: bool):
    rows = load(ledger)
    hit = 0
    for r in rows:
        if r.get("id") in ids and not r.get("refuted"):
            r["refuted"] = True
            r["verified"] = False
            r["repaired"] = True
            r["repair_note"] = "label fix: claim was refuted, not merely corrected"
            hit += 1
    print(f"[repair] set-refuted on {ledger.name}: matched {hit}/{len(ids)} ids")
    if dry or not hit:
        return
    shutil.copyfile(ledger, ledger.with_suffix(ledger.suffix + ".bak2"))
    write_jsonl(ledger, rows)
    print(f"[repair] rewrote {ledger} ({hit} labels fixed)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--normalize")
    ap.add_argument("--merge")
    ap.add_argument("--into")
    ap.add_argument("--set-refuted")
    ap.add_argument("--ids", default="")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.normalize:
        cmd_normalize(Path(a.normalize), a.dry_run)
    if a.merge and a.into:
        cmd_merge(Path(a.merge), Path(a.into), a.dry_run)
    if a.set_refuted:
        cmd_set_refuted(Path(a.set_refuted), set(x for x in a.ids.split(",") if x), a.dry_run)
    if not (a.normalize or a.merge or a.set_refuted):
        ap.error("nothing to do: pass --normalize / --merge…--into / --set-refuted…--ids")


if __name__ == "__main__":
    main()
