"""
Build the base Knowledge Center grounding index.

Turns the Knowledge Center's source docs into a compact, retrievable corpus the
LLM (and the deterministic/near router) can ground on — one record per doc
*section*, with a heading path and a trimmed snippet. Output:

    data/knowledge/index.jsonl   # [{id, doc, path, heading, level, text, tokens}]
    data/knowledge/index.meta.json

Run:
    python scripts/build_knowledge_index.py
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "data" / "knowledge"

MAX_SECTION_CHARS = 1200

# The grounding corpus IS the Knowledge Center: we parse the live KC page for the
# docs it links (`/repo/*.md`) so the index always matches what users see, plus a
# small CORE set of required-reading docs. Add a KC card → it's grounded. No
# hand-maintained list to drift out of sync.
KC_HTML = REPO / "apps" / "lantern-garage" / "public" / "knowledgecenter.html"
CORE_DOCS = ["README.md", "CLAUDE.md", "AGENTS.md", "QUICKSTART.md"]

# External (out-of-repo) sources — e.g. Human Flourishing Frameworks docs pulled
# into gitignored staging. They are SURFACED as KC/Explore cards that link to their
# upstream source, but their text is intentionally NOT folded into the committed
# grounding index (the staging decision: nothing about the external repo is
# committed here). Built by scripts/build_doc_library.js.
EXTERNAL_SOURCES = OUT_DIR / "external-sources.json"


def external_docs() -> list[dict]:
    if not EXTERNAL_SOURCES.exists():
        return []
    try:
        data = json.loads(EXTERNAL_SOURCES.read_text(encoding="utf-8"))
    except Exception:
        return []
    out = []
    for e in data if isinstance(data, list) else []:
        if isinstance(e, dict) and e.get("doc") and e.get("url"):
            out.append(e)
    return out


def knowledge_base_docs() -> list[str]:
    docs = list(CORE_DOCS)
    if KC_HTML.exists():
        html = KC_HTML.read_text(encoding="utf-8", errors="replace")
        for m in re.findall(r'href="/repo/([^"]+\.md)"', html):
            if m not in docs:
                docs.append(m)
    # keep only docs that exist on disk
    return [d for d in docs if (REPO / d).exists()]


def strip_frontmatter(md: str) -> str:
    """Drop a leading YAML frontmatter block (--- ... ---) so doc metadata
    (author/created/updated) doesn't get indexed as the (intro) section."""
    if md.startswith("﻿"):
        md = md[1:]
    m = re.match(r"^---\n.*?\n---\n?", md, re.DOTALL)
    return md[m.end():] if m else md


def split_sections(md: str):
    """Split markdown into (level, heading, body) sections by ATX headings."""
    lines = md.splitlines()
    sections, cur_head, cur_level, buf = [], "(intro)", 0, []
    for ln in lines:
        m = re.match(r"^(#{1,4})\s+(.*)", ln)
        if m:
            if buf:
                sections.append((cur_level, cur_head, "\n".join(buf).strip()))
            cur_level, cur_head, buf = len(m.group(1)), m.group(2).strip(), []
        else:
            buf.append(ln)
    if buf:
        sections.append((cur_level, cur_head, "\n".join(buf).strip()))
    return [(lv, h, b) for lv, h, b in sections if b]


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    docs = knowledge_base_docs()
    records = []
    for rel in docs:
        p = REPO / rel
        if not p.exists():
            continue
        md = strip_frontmatter(p.read_text(encoding="utf-8", errors="replace"))
        for lv, heading, body in split_sections(md):
            text = re.sub(r"\n{3,}", "\n\n", body)[:MAX_SECTION_CHARS]
            rid = hashlib.sha1(f"{rel}#{heading}".encode()).hexdigest()[:12]
            records.append({
                "id": rid, "doc": rel, "path": f"{rel}#{heading}",
                "heading": heading, "level": lv, "text": text,
                "tokens": max(1, len(text) // 4),
            })

    idx = OUT_DIR / "index.jsonl"
    with open(idx, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    # External sources: card-only (no text in the committed index). Appended to the
    # doc list + carried in doc_meta so KC/Explore can render+link them upstream.
    ext = external_docs()
    doc_meta = {}
    all_docs = list(docs)
    for e in ext:
        d = e["doc"]
        if d not in all_docs:
            all_docs.append(d)
        doc_meta[d] = {
            "url": e["url"],
            "source": e.get("source", "External"),
            "title": e.get("title") or d.split("/")[-1],
            "external": True,
            "topics": e.get("topics") or ["research"],
        }

    meta = {
        "built_at": time.time(),
        "docs": all_docs,
        "doc_meta": doc_meta,
        "sections": len(records),
        "external": len(ext),
        "sha256": hashlib.sha256(idx.read_bytes()).hexdigest(),
    }
    (OUT_DIR / "index.meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"knowledge index: {len(records)} sections from {len(docs)} in-repo docs "
          f"+ {len(ext)} external card-only docs -> {idx}")
    print(f"  sha256={meta['sha256'][:16]}…")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
