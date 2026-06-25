#!/usr/bin/env python3
"""Shard the public CSF archive into sub-100 MB volumes so it can be committed
to GitHub (which hard-rejects any single file > 100 MB; LFS is unprovisioned).

Reads the public archive + manifest produced by csf_split_archive.py, size-bins
its unique members into N shards each under the cap, repacks each shard, and
writes a per-shard manifest. The pdfs.js route already loads every manifest in
data/csf_archives and ties each PDF to its own archive, so N shards Just Work.

    PYTHONPATH=src python scripts/csf_shard_public.py <public.csf> <public.manifest.json>
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

CAP_BYTES = 90 * 1024 * 1024  # compressed target well under GitHub's 100 MB


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    source, man_path = sys.argv[1], sys.argv[2]
    members = json.loads(Path(man_path).read_text(encoding="utf-8"))["members"]

    # unique content -> canonical orig path (the member name inside the archive)
    canon: dict[str, str] = {}
    for orig, info in sorted(members.items()):
        canon.setdefault(info["sha256"], orig)

    # read each unique member's bytes + size
    blobs: dict[str, bytes] = {}
    sizes: dict[str, int] = {}
    for sha, orig in canon.items():
        data = csf.read_file(source, orig)
        if hashlib.sha256(data).hexdigest() != sha:
            raise SystemExit(f"SHA mismatch reading {orig}")
        blobs[orig] = data
        sizes[orig] = len(data)

    # greedy size-balanced binning: enough bins that each packs under the cap,
    # then assign largest-first to the currently-smallest bin.
    total = sum(sizes.values())
    n_shards = max(2, (total // CAP_BYTES) + 1)
    bins: list[list[str]] = [[] for _ in range(n_shards)]
    load = [0] * n_shards
    for orig in sorted(sizes, key=sizes.get, reverse=True):
        i = load.index(min(load))
        bins[i].append(orig)
        load[i] += sizes[orig]

    out = REPO / "data" / "csf_archives"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    sha_to_orig = {info["sha256"]: o for o, info in members.items()}  # for path grouping
    for idx, group in enumerate(bins, 1):
        name = f"corpus-public-{stamp}-{idx:02d}"
        arc = out / f"{name}.csf"
        csf.pack_blobs({o: blobs[o] for o in group}, str(arc), use_dict=True)
        size = arc.stat().st_size
        if size > 100 * 1024 * 1024:
            raise SystemExit(f"{arc.name} is {size:,} B — still over 100 MB, raise n_shards")
        # verify round-trip
        for o in group:
            if hashlib.sha256(csf.read_file(str(arc), o)).hexdigest() != \
                    next(s for s, c in canon.items() if c == o):
                raise SystemExit(f"verify failed for {o}")
        # manifest: every orig path whose content landed in this shard
        group_shas = {next(s for s, c in canon.items() if c == o) for o in group}
        shard_members = {orig: info for orig, info in members.items()
                         if info["sha256"] in group_shas}
        manifest = {
            "generated_utc": datetime.now(timezone.utc).isoformat(),
            "archive": str(arc.relative_to(REPO)).replace("\\", "/"),
            "archive_sha256": hashlib.sha256(arc.read_bytes()).hexdigest(),
            "archive_bytes": size,
            "group": f"public-shard-{idx:02d}",
            "files_in": len(shard_members),
            "unique_members": len(group),
            "members": shard_members,
        }
        (out / f"{name}.manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(f"shard {idx}: {len(group)} members -> {arc.name} ({size:,} B, <100MB OK)")
    print(f"done — {n_shards} shards. Commit corpus-public-*-NN.csf + manifests; "
          f"delete the single corpus-public-{stamp}.csf/.manifest.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
