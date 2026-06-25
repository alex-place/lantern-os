#!/usr/bin/env python3
"""CSF corpus condense — the "dream/condense" pass for the Remember stage.

ONE loop, four objects. This is a Remember-stage optimization: it folds the
sprawling binary/dump *corpus* (intake PDFs, research-paper dumps, rag-intake
assets) into ONE lossless, SHA-256-verified CSF archive, writes a Convergence
Record describing what was condensed, and (optionally) removes the loose
originals from git so the tracked repo stays lean.

It is NOT a second memory system: the append-only JSONL log + CSF archive are
the canonical memory substrate (CLAUDE.md). This script just *uses* CSF to
condense corpus the loop already owns.

Properties
----------
* Lossless: every source byte is recoverable via ``csf.read_file(archive, member)``.
* Deduplicated: byte-identical files are stored once (keyed by SHA-256); the
  manifest maps every original path to its single archive member.
* Verified: after packing, each unique member is read back and its SHA-256 is
  re-checked against the source (External Reality Rule — nothing accepted
  without evidence).
* Auditable: a small JSON manifest (committed) records archive sha, member map,
  and bytes-before/after. The archive itself is local + gitignored (it can hold
  the data/ingest PII pool — never re-commit it).
* Repeatable: run it again after new intake; it is idempotent per content hash.

Usage
-----
    PYTHONPATH=src python scripts/csf_condense_corpus.py            # dry plan
    PYTHONPATH=src python scripts/csf_condense_corpus.py --pack     # build archive + verify + record
    PYTHONPATH=src python scripts/csf_condense_corpus.py --pack --remove  # also git-rm originals
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
import csf  # noqa: E402  (after sys.path tweak)

# Dump-corpus roots considered "archivable". App-served trees
# (apps/**/public, data/images/three-doors, skills/**/assets) are deliberately
# excluded — they are read by runtime features, not dead weight.
DEFAULT_GLOBS = [
    "data/ingest/**",
    "data/rag-intake/**",
    "data/reports/**",
    "docs/research-papers/**",
    "csf/ingest/**",
]

ARCHIVE_DIR = REPO / "data" / "csf_archives"
CONV_LOG = REPO / "data" / "convergence-records.jsonl"


def sh(*args: str) -> str:
    return subprocess.run(args, cwd=REPO, capture_output=True, text=True, check=True).stdout


def tracked_corpus(globs: list[str]) -> list[str]:
    out = sh("git", "ls-files", "-z", "--", *globs)
    files = [p for p in out.split("\0") if p]
    return sorted(f for f in files if (REPO / f).is_file())


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="Condense the binary/dump corpus into one CSF archive.")
    ap.add_argument("--pack", action="store_true", help="actually build the archive (default: dry plan)")
    ap.add_argument("--remove", action="store_true", help="git-rm the originals after verified pack")
    ap.add_argument("--name", default=None, help="archive basename (default: corpus-condense-<UTC date>)")
    args = ap.parse_args()

    files = tracked_corpus(DEFAULT_GLOBS)
    if not files:
        print("No tracked corpus files match — nothing to condense.")
        return 0

    # Deduplicate by content hash; one archive member per unique sha.
    by_sha: dict[str, dict] = {}
    total_bytes = 0
    for rel in files:
        p = REPO / rel
        size = p.stat().st_size
        total_bytes += size
        digest = sha256(p)
        slot = by_sha.setdefault(digest, {"canonical": rel, "size": size, "paths": []})
        slot["paths"].append(rel)

    unique_bytes = sum(v["size"] for v in by_sha.values())
    print(f"corpus files       : {len(files)}")
    print(f"unique by content  : {len(by_sha)}")
    print(f"total bytes        : {total_bytes:,}")
    print(f"unique bytes       : {unique_bytes:,}  (dedup saves {total_bytes - unique_bytes:,})")

    if not args.pack:
        print("\n[dry run] re-run with --pack to build the archive.")
        return 0

    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    name = args.name or f"corpus-condense-{stamp}"
    archive = ARCHIVE_DIR / f"{name}.csf"

    # Pack only the canonical copy of each unique file.
    members = [by_sha[d]["canonical"] for d in by_sha]
    print(f"\nPacking {len(members)} unique members -> {archive.relative_to(REPO)} ...")
    csf.pack(members, str(archive), use_dict=True)
    arch_size = archive.stat().st_size
    print(f"archive bytes      : {arch_size:,}  ({arch_size / unique_bytes:.1%} of unique, "
          f"{arch_size / total_bytes:.1%} of total)")

    # Verify: read each member back, confirm SHA matches source. Evidence > trust.
    # CSF stores members under a stripped relative path, so key the lookup by
    # content hash (the durable identity), not by the original repo path.
    print("Verifying round-trip (per-member SHA-256)...")
    listing = csf.list_archive(str(archive))
    sha_to_member = {e["sha256"]: e["path"] for e in listing["files"]}
    bad = []
    for digest, slot in by_sha.items():
        member = sha_to_member.get(digest)
        if member is None:
            bad.append((slot["canonical"], "missing-from-archive"))
            continue
        slot["member"] = member  # archive entry name to pass to csf.read_file
        data = csf.read_file(str(archive), member)
        if hashlib.sha256(data).hexdigest() != digest:
            bad.append((member, "sha-mismatch"))
    if bad:
        print("VERIFY FAILED:", bad[:10], file=sys.stderr)
        print("Archive NOT trusted; originals left in place.", file=sys.stderr)
        return 2
    print(f"verified OK        : {len(by_sha)}/{len(by_sha)} members losslessly recoverable")

    archive_sha = sha256(archive)

    # Auditable manifest (committed). Lets anyone restore any original via
    #   csf.read_file("<archive>", manifest["members"][path])
    manifest = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "archive": str(archive.relative_to(REPO)),
        "archive_sha256": archive_sha,
        "archive_bytes": arch_size,
        "corpus_globs": DEFAULT_GLOBS,
        "files_in": len(files),
        "unique_members": len(by_sha),
        "total_bytes": total_bytes,
        "unique_bytes": unique_bytes,
        # original repo path -> {sha, member}: member is the archive entry name
        # to pass to csf.read_file(archive, member) for lossless restore.
        "members": {
            p: {"sha256": d, "member": slot["member"]}
            for d, slot in by_sha.items()
            for p in slot["paths"]
        },
    }
    manifest_path = ARCHIVE_DIR / f"{name}.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"manifest written   : {manifest_path.relative_to(REPO)}")

    # Convergence Record — Remember stage. [claim, evidence, confidence, source]
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "stage": "Remember",
        "kind": "corpus-condense",
        "hypothesis": "The intake/research dump corpus is losslessly condensable "
                      "into one CSF archive, shrinking the tracked repo without "
                      "information loss.",
        "evidence": {
            "files_in": len(files),
            "unique_members": len(by_sha),
            "total_bytes": total_bytes,
            "unique_bytes": unique_bytes,
            "archive_bytes": arch_size,
            "compression_vs_total": round(arch_size / total_bytes, 4),
            "verified_members": len(by_sha),
            "archive_sha256": archive_sha,
        },
        "result": "verified-lossless",
        "confidence": {"observable": 1.0, "overall": 0.95},
        "sources": ["csf.read_file SHA-256 round-trip", str(manifest_path.relative_to(REPO))],
    }
    with CONV_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")
    print(f"convergence record : appended to {CONV_LOG.relative_to(REPO)}")

    if args.remove:
        print(f"\nRemoving {len(files)} originals from git (archive holds them)...")
        # Batch git rm to avoid arg-length limits.
        for i in range(0, len(files), 100):
            sh("git", "rm", "-q", "--", *files[i:i + 100])
        print("Originals removed from index. Review with `git status` then commit.")
    else:
        print("\n[kept] originals left in place. Re-run with --remove to git-rm them.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
