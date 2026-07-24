#!/usr/bin/env python3
"""Build the Σ₀ code baseline: a grounded, self-describing CSF archive of the code.

Consumes the per-file grounding records produced by the ``sigma0-code-baseline``
workflow (one JSON array per batch), and materialises three durable artifacts
under ``data/baseline/``:

  * ``code-grounding.jsonl`` — one grounding record per scanned file (path,
    purpose, loop_stage, object, verdict, confidence, note). The queryable Σ₀
    baseline index (the Remember stage's map of the codebase).
  * ``code-baseline.csf``    — a CSF-Pack archive of every KEPT file (verdict
    grounded/update, minus confirmed removals), each member carrying its
    ``description`` (=purpose) and ``metadata`` (loop_stage/object/verdict/…).
    This is the "archived file/script with metadata + desc" store.
  * ``CODE-BASELINE.md``     — a human summary: counts by verdict/loop-stage and
    the list of files removed (with evidence).

Removals passed via ``--removals`` (a JSON array of repo-relative paths that a
verification pass confirmed safe to delete) are EXCLUDED from the archive; their
grounding record is still kept in the index so the baseline records *why* they
went.

Usage
-----
  python scripts/build_code_baseline.py --batches <dir> [--removals removals.json]
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from csf import csf_pack  # noqa: E402

_LOOP_ORDER = ["Observe", "Remember", "Reason", "Act", "Verify", "Converge", "Infra", "Meta"]


def assemble(batches_dir: str) -> list[dict]:
    """Merge all batch-*.json arrays into one list, de-duped by path (last wins)."""
    by_path: dict[str, dict] = {}
    files = sorted(glob.glob(str(Path(batches_dir) / "batch-*.json")))
    for f in files:
        try:
            arr = json.loads(Path(f).read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"  ! skipping unparsable {f}: {e}")
            continue
        for rec in arr:
            p = rec.get("path")
            if p:
                by_path[p] = rec
    print(f"assembled {len(by_path)} grounding records from {len(files)} batch file(s)")
    return [by_path[p] for p in sorted(by_path)]


def build(records: list[dict], removals: set[str], outdir: Path) -> dict:
    outdir.mkdir(parents=True, exist_ok=True)

    # 1) grounding index (all records)
    index_path = outdir / "code-grounding.jsonl"
    with index_path.open("w", encoding="utf-8", newline="\n") as fh:
        for rec in records:
            rec = dict(rec)
            if rec["path"] in removals:
                rec["removed"] = True
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"wrote {index_path} ({len(records)} records)")

    # 2) CSF archive of kept files (exclude confirmed removals + missing files)
    blobs: dict[str, bytes] = {}
    annotations: dict[str, dict] = {}
    missing = []
    for rec in records:
        path = rec["path"]
        if path in removals:
            continue
        fp = REPO / path
        if not fp.is_file():
            missing.append(path)
            continue
        blobs[path] = fp.read_bytes()
        md = {
            "loop_stage": rec.get("loop_stage"),
            "object": rec.get("object"),
            "verdict": rec.get("verdict"),
            "confidence": rec.get("confidence"),
            "language": rec.get("language"),
        }
        if rec.get("note"):
            md["note"] = rec["note"]
        annotations[path] = {"description": rec.get("purpose", ""), "metadata": md}

    archive_path = outdir / "code-baseline.csf"
    manifest = csf_pack.pack_blobs(
        blobs, str(archive_path), codec="zstd",
        use_dict=True, annotations=annotations,
    )
    total = sum(f["size"] for f in manifest["files"])
    stored = sum(f["csize"] for f in manifest["files"])
    print(f"wrote {archive_path}: {manifest['file_count']} files, "
          f"{total} -> {stored} bytes ({stored/total:.1%}) codec={manifest['codec']}"
          + (f", +shared-dict" if manifest.get('shared_dict') else ""))
    if missing:
        print(f"  note: {len(missing)} grounded path(s) not on disk (excluded from archive)")

    # 3) human summary
    verdicts = Counter(r.get("verdict", "?") for r in records)
    stages = Counter(r.get("loop_stage", "?") for r in records)
    removed_recs = [r for r in records if r["path"] in removals]
    md = ["# Σ₀ Code Baseline", ""]
    md.append(f"Grounded **{len(records)}** code files "
              f"(src/, scripts/, experiments/, lib+routes).")
    md.append("")
    md.append("## Verdicts")
    for v in ("grounded", "update", "remove"):
        md.append(f"- **{v}**: {verdicts.get(v, 0)}")
    md.append("")
    md.append("## By loop stage")
    for s in _LOOP_ORDER:
        if stages.get(s):
            md.append(f"- {s}: {stages[s]}")
    md.append("")
    md.append(f"## Removed in this pass ({len(removed_recs)})")
    if removed_recs:
        for r in sorted(removed_recs, key=lambda x: x["path"]):
            md.append(f"- `{r['path']}` — {r.get('note', '').strip()}")
    else:
        md.append("_None._")
    md.append("")
    md.append("## Artifacts")
    md.append("- `code-grounding.jsonl` — per-file grounding index (queryable)")
    md.append("- `code-baseline.csf` — kept files, each with description + metadata "
              "(`python -m csf.csf_pack list data/baseline/code-baseline.csf`)")
    summary_path = outdir / "CODE-BASELINE.md"
    summary_path.write_text("\n".join(md) + "\n", encoding="utf-8")
    print(f"wrote {summary_path}")

    return {
        "records": len(records), "archived": manifest["file_count"],
        "removed": len(removed_recs), "missing": len(missing),
        "verdicts": dict(verdicts),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Build the Σ₀ code baseline archive + index")
    ap.add_argument("--batches", required=True, help="dir containing batch-*.json grounding files")
    ap.add_argument("--removals", help="JSON array of repo-relative paths confirmed safe to delete")
    ap.add_argument("--outdir", default=str(REPO / "data" / "baseline"))
    args = ap.parse_args(argv)

    records = assemble(args.batches)
    if not records:
        raise SystemExit("no grounding records found")
    removals = set()
    if args.removals:
        removals = set(json.loads(Path(args.removals).read_text(encoding="utf-8")))
    stats = build(records, removals, Path(args.outdir))
    print("\n" + json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
