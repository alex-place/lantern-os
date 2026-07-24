#!/usr/bin/env python3
"""Build library thumbnails + index for the Knowledge Center library panel.

Renders page 1 of every source PDF to a small PNG and writes an index.json the
/api/library/list endpoint serves. Re-run whenever the PDF sets change.

Sources:
  caad/architecture/grounding/*.pdf              (the cross-industry grounding KB)
  skills/lantern-rag-dollhouse/assets/pdfs/*.pdf (the Comet-Leap master PDFs)

Output:
  public/library-thumbs/<id>.png
  public/library-thumbs/index.json

Run:  python scripts/build_library_thumbs.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import fitz  # PyMuPDF

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "apps" / "lantern-garage" / "public"
THUMBS = PUBLIC / "library-thumbs"
THUMB_WIDTH = 320

SOURCES = [
    {"tag": "kb", "dir": ROOT / "caad" / "architecture" / "grounding",
     "collection": "Grounding KB"},
    {"tag": "cl", "dir": ROOT / "skills" / "lantern-rag-dollhouse" / "assets" / "pdfs",
     "collection": "Comet Leap"},
]


def title_and_category(tag: str, stem: str):
    """Human title + category from the filename convention."""
    if tag == "kb":
        m = re.match(r"industry-([a-z0-9\-]+)_(.+)", stem)
        if m:
            category = m.group(1).replace("-", " ").title()
            title = m.group(2).replace("-", " ")
        else:
            category = "Reference"
            title = stem.replace("-", " ")
    else:
        category = "Comet Leap"
        title = stem.replace("-", " ").replace("_", " ")
    return title.strip(), category


def main() -> None:
    THUMBS.mkdir(parents=True, exist_ok=True)
    index = []
    for src in SOURCES:
        d = src["dir"]
        if not d.exists():
            print(f"  (skip missing source {d})")
            continue
        for pdf in sorted(d.glob("*.pdf")):
            stem = pdf.stem
            entry_id = f"{src['tag']}__{stem}"
            thumb_path = THUMBS / f"{entry_id}.png"
            title, category = title_and_category(src["tag"], stem)
            pages = None
            try:
                doc = fitz.open(pdf)
                pages = doc.page_count
                page = doc[0]
                zoom = THUMB_WIDTH / page.rect.width
                page.get_pixmap(matrix=fitz.Matrix(zoom, zoom)).save(thumb_path)
                doc.close()
                ok = True
            except Exception as e:  # noqa: BLE001
                print(f"  ERR {pdf.name}: {e}")
                ok = False
            rel = pdf.relative_to(ROOT).as_posix()
            index.append({
                "id": entry_id,
                "title": title,
                "category": category,
                "collection": src["collection"],
                "pages": pages,
                "sizeKB": round(pdf.stat().st_size / 1024),
                "pdfUrl": f"/repo/{rel}",
                "thumbUrl": f"/library-thumbs/{entry_id}.png" if ok else None,
            })
            print(f"  {'OK ' if ok else 'no '} {entry_id}  ({pages}p)")

    index.sort(key=lambda e: (e["collection"], e["category"], e["title"]))
    (THUMBS / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"\nWrote {len(index)} entries -> {THUMBS / 'index.json'}")


if __name__ == "__main__":
    main()
