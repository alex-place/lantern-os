#!/usr/bin/env python3
"""Split a condensed CSF corpus archive into a public (committable) archive and
a local-only PII archive.

The dump corpus was condensed into ONE archive by csf_condense_corpus.py, but
`data/ingest/` is a flagged PII pool (#868) and the repo is public. This splits
the archive by original path:

  * public  — everything NOT under data/ingest/  → committed to git
  * ingest  — everything under data/ingest/       → gitignored, local only

Members are re-keyed by their canonical original repo path. Per-group manifests
are written; the public manifest is safe to commit, the ingest manifest stays
local (filenames may be sensitive). Originals are already removed, so members
are read back out of the source archive (lossless) rather than re-read from disk.

    PYTHONPATH=src python scripts/csf_split_archive.py <source.csf> <source.manifest.json>
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
import csf  # noqa: E402

PII_PREFIX = "data/ingest/"


def build(group_paths: dict, source: str, out_csf: Path, out_manifest: Path, label: str):
    """group_paths: {orig_path: {'sha','member'}}. Reads each unique member out of
    the source archive and repacks keyed by a canonical original path."""
    # canonical path per content hash (first orig path wins → stable member name)
    canon: dict[str, str] = {}
    for orig, info in sorted(group_paths.items()):
        canon.setdefault(info["sha256"], orig)
    blobs = {}
    for sha, orig in canon.items():
        member = group_paths[orig]["member"]
        data = csf.read_file(source, member)
        if hashlib.sha256(data).hexdigest() != sha:
            raise SystemExit(f"[{label}] SHA mismatch reading {member}")
        blobs[orig] = data  # re-key by canonical original path
    csf.pack_blobs(blobs, str(out_csf), use_dict=True)

    # verify round-trip
    for sha, orig in canon.items():
        if hashlib.sha256(csf.read_file(str(out_csf), orig)).hexdigest() != sha:
            raise SystemExit(f"[{label}] verify failed for {orig}")

    manifest = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "archive": str(out_csf.relative_to(REPO)).replace("\\", "/"),
        "archive_sha256": hashlib.sha256(out_csf.read_bytes()).hexdigest(),
        "archive_bytes": out_csf.stat().st_size,
        "group": label,
        "files_in": len(group_paths),
        "unique_members": len(canon),
        # orig path -> {sha, member(=canonical orig path in this archive)}
        "members": {orig: {"sha256": info["sha256"], "member": canon[info["sha256"]]}
                    for orig, info in group_paths.items()},
    }
    out_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"[{label}] {len(group_paths)} paths / {len(canon)} unique -> "
          f"{out_csf.name} ({out_csf.stat().st_size:,} B)")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    source, src_manifest = sys.argv[1], sys.argv[2]
    members = json.loads(Path(src_manifest).read_text(encoding="utf-8"))["members"]

    public = {p: i for p, i in members.items() if not p.startswith(PII_PREFIX)}
    ingest = {p: i for p, i in members.items() if p.startswith(PII_PREFIX)}
    print(f"source: {len(members)} paths  ->  public {len(public)} | ingest {len(ingest)}")

    out = REPO / "data" / "csf_archives"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    build(public, source, out / f"corpus-public-{stamp}.csf",
          out / f"corpus-public-{stamp}.manifest.json", "public")
    build(ingest, source, out / f"corpus-ingest-{stamp}.csf",
          out / f"corpus-ingest-{stamp}.manifest.json", "ingest")
    print("done — commit corpus-public-*, keep corpus-ingest-* local (gitignored).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
