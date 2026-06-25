#!/usr/bin/env python3
"""Stream one member out of a CSF archive to stdout (raw bytes).

Used by apps/lantern-garage/routes/pdfs.js to serve research PDFs straight from
the condensed CSF corpus archive once the loose originals have been removed
(see scripts/csf_condense_corpus.py). Read-only; verifies the member's SHA-256
internally via csf.read_file.

    python scripts/csf_read_member.py <archive.csf> <member>   # bytes -> stdout
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import csf  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("usage: csf_read_member.py <archive.csf> <member>\n")
        return 2
    archive, member = sys.argv[1], sys.argv[2]
    if not Path(archive).is_file():
        sys.stderr.write(f"archive not found: {archive}\n")
        return 3
    try:
        data = csf.read_file(archive, member)  # raises if member missing / SHA bad
    except Exception as exc:  # noqa: BLE001 — surface as non-zero exit to caller
        sys.stderr.write(f"read failed: {exc}\n")
        return 4
    sys.stdout.buffer.write(data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
