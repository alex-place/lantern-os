"""
Per-user CSF profile pack — ONE file that represents & compacts ALL of a user's
CSF data, grounded in the base Knowledge Center index.

A profile archive (`data/profiles/<user>.csf`, CSF-Pack v0.8) contains:
  - the user's CSF data (cube + deltas + indexes, dreamer notebooks, csf_memory,
    profile json) under `user/…`
  - the base Knowledge Center grounding index under `knowledge/index.jsonl`
    (so the file is self-contained AND grounded in the base KB)
  - a top-level `_profile.json` describing sources + the grounding reference

Build the KB index first: `python scripts/build_knowledge_index.py`

CLI:
    python -m csf.profile_pack pack <user> [-o data/profiles/<user>.csf]
    python -m csf.profile_pack unpack data/profiles/<user>.csf -d <dest>
    python -m csf.profile_pack info data/profiles/<user>.csf
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

from . import csf_pack

REPO = Path(__file__).resolve().parent.parent.parent
KB_INDEX = REPO / "data" / "knowledge" / "index.jsonl"
KB_META = REPO / "data" / "knowledge" / "index.meta.json"


def _user_sources(user: str) -> list[Path]:
    """All on-disk CSF data belonging to `user` (existing paths only)."""
    candidates = [
        REPO / "data" / "cubes" / f"{user}.private",
        REPO / "data" / "cubes" / user,
        REPO / "data" / "profiles" / f"{user}.json",
        REPO / "data" / "csf_memory" / user,
        REPO / "data" / "dreamer" / "notebooks" / f"{user}.jsonl",
        REPO / "apps" / "data" / "dreamer" / "notebooks" / f"{user}.jsonl",
        REPO / "data" / "dream-journal" / "csf" / user,
    ]
    return [p for p in candidates if p.exists()]


def _collect_blobs(user: str) -> tuple[dict, list[dict]]:
    """Return ({arc_path: bytes}, [source descriptors]) for the user's data."""
    blobs, sources = {}, []
    for src in _user_sources(user):
        if src.is_dir():
            for f in sorted(src.rglob("*")):
                if f.is_file():
                    arc = "user/" + f.relative_to(src.parent).as_posix()
                    blobs[arc] = f.read_bytes()
            sources.append({"path": str(src.relative_to(REPO)), "kind": "dir"})
        else:
            arc = "user/" + src.relative_to(REPO).as_posix()
            blobs[arc] = src.read_bytes()
            sources.append({"path": str(src.relative_to(REPO)), "kind": "file"})
    return blobs, sources


def pack_profile(user: str, out_path: str | None = None, compress: bool = True) -> dict:
    """Compact all of a user's CSF data + KB grounding into one .csf. Returns the profile manifest."""
    blobs, sources = _collect_blobs(user)

    # Ground in the base Knowledge Center index (embed it + record a reference).
    grounding = {"knowledge_index": None}
    if KB_INDEX.exists():
        kb_bytes = KB_INDEX.read_bytes()
        blobs["knowledge/index.jsonl"] = kb_bytes
        if KB_META.exists():
            blobs["knowledge/index.meta.json"] = KB_META.read_bytes()
        grounding = {
            "knowledge_index": "knowledge/index.jsonl",
            "sha256": hashlib.sha256(kb_bytes).hexdigest(),
            "sections": sum(1 for _ in kb_bytes.splitlines()),
        }

    profile = {
        "format": "csf-profile", "version": "0.8", "user": user,
        "created_at": time.time(),
        "sources": sources,
        "user_file_count": sum(1 for k in blobs if k.startswith("user/")),
        "grounding": grounding,
    }
    blobs["_profile.json"] = json.dumps(profile, indent=2).encode("utf-8")

    out = out_path or str(REPO / "data" / "profiles" / f"{user}.csf")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    csf_pack.pack_blobs(blobs, out, compress=compress,
                        extra_meta={"profile": {"user": user, "grounded": grounding["knowledge_index"] is not None}})
    profile["archive"] = out
    profile["archive_bytes"] = Path(out).stat().st_size
    return profile


def info(archive: str) -> dict:
    """Return the embedded _profile.json without extracting (codec-aware)."""
    try:
        raw = csf_pack.read_file(archive, "_profile.json")
    except KeyError:
        _, manifest, _flags, _bs, _be = csf_pack._read_container(archive)
        return {"error": "_profile.json not found", "manifest": manifest.get("profile")}
    return json.loads(raw.decode("utf-8"))


def unpack_profile(archive: str, dest: str) -> list[str]:
    """Extract a profile archive (verifies integrity + per-file checksums)."""
    return csf_pack.unpack(archive, dest)


def _main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="csf-profile", description="per-user CSF profile pack")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pack"); p.add_argument("user"); p.add_argument("-o", "--out"); p.add_argument("--no-compress", action="store_true")
    u = sub.add_parser("unpack"); u.add_argument("archive"); u.add_argument("-d", "--dest", default=".")
    i = sub.add_parser("info"); i.add_argument("archive")
    a = ap.parse_args(argv)
    if a.cmd == "pack":
        m = pack_profile(a.user, a.out, compress=not a.no_compress)
        print(f"profile '{a.user}': {m['user_file_count']} user file(s), "
              f"grounded={m['grounding']['knowledge_index'] is not None} -> {m['archive']} ({m['archive_bytes']}B)")
    elif a.cmd == "unpack":
        w = unpack_profile(a.archive, a.dest); print(f"extracted {len(w)} file(s) -> {a.dest}")
    elif a.cmd == "info":
        print(json.dumps(info(a.archive), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
