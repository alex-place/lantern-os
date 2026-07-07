"""
Build a compact BM25 retrieval index over the harvested arXiv corpus so the
Keystone chat assistant can pull the most relevant recent papers per question
without a linear scan of the whole corpus.

Reads   $ARXIV_CORPUS_DIR\\raw\\*.jsonl   (produced by arxiv_harvest.py)
Writes  $ARXIV_CORPUS_DIR\\index\\postings.json   {term: [[docId, tf], ...]}
        $ARXIV_CORPUS_DIR\\index\\docs.jsonl       line docId = {id,title,published,primary_category,snippet,url,len}
        $ARXIV_CORPUS_DIR\\index\\meta.json         {count, avgdl, k1, b, built_at, terms}

Idempotent — safe to re-run after every harvest. The tokenizer here MUST match the
one in apps/lantern-garage/lib/arxiv-index.js (same lowercase / [a-z0-9]+ / stopword
rules) or query terms won't line up with indexed terms.

Run:
    python scripts/arxiv_build_index.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# Windows consoles default to cp1252 and choke on unicode in log output.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

DEFAULT_ROOT = Path(os.environ.get("ARXIV_CORPUS_DIR", r"F:\arxiv-corpus"))

SNIPPET_CHARS = 400
K1 = 1.5
B = 0.75

# Small stopword set — matched verbatim in arxiv-index.js. Keep ML terms (e.g. "learning").
STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "as",
    "by", "at", "from", "is", "are", "be", "been", "was", "were", "this", "that", "these",
    "those", "it", "its", "we", "our", "they", "their", "can", "which", "such", "using",
    "used", "use", "via", "into", "than", "then", "also", "more", "most", "have", "has",
    "not", "no", "do", "does", "how", "what", "when", "where", "why", "who",
}

TOKEN_RE = re.compile(r"[a-z0-9]+")


def corpus_root() -> Path:
    return Path(os.environ.get("ARXIV_CORPUS_DIR", str(DEFAULT_ROOT)))


def tokenize(text: str) -> list[str]:
    return [t for t in TOKEN_RE.findall((text or "").lower()) if len(t) >= 2 and t not in STOPWORDS]


def iter_records(raw_dir: Path):
    for f in sorted(raw_dir.glob("*.jsonl")):
        with f.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue


def main(argv=None) -> int:
    root = corpus_root()
    raw_dir = root / "raw"
    index_dir = root / "index"
    if not raw_dir.exists():
        print(f"[arxiv-index] no raw corpus at {raw_dir}; run arxiv_harvest.py first", flush=True)
        return 1
    index_dir.mkdir(parents=True, exist_ok=True)

    postings: dict[str, list[list[int]]] = {}
    doc_lens: list[int] = []
    seen_ids: set[str] = set()
    total_len = 0

    docs_tmp = index_dir / "docs.jsonl.tmp"
    doc_id = 0
    with docs_tmp.open("w", encoding="utf-8") as docs_out:
        for rec in iter_records(raw_dir):
            rid = rec.get("id")
            if not rid or rid in seen_ids:
                continue
            seen_ids.add(rid)

            tokens = tokenize(f"{rec.get('title', '')} {rec.get('abstract', '')}")
            if not tokens:
                continue

            tf: dict[str, int] = {}
            for t in tokens:
                tf[t] = tf.get(t, 0) + 1
            for term, freq in tf.items():
                postings.setdefault(term, []).append([doc_id, freq])

            dl = len(tokens)
            doc_lens.append(dl)
            total_len += dl

            abstract = rec.get("abstract", "") or ""
            snippet = abstract[:SNIPPET_CHARS].rstrip()
            if len(abstract) > SNIPPET_CHARS:
                snippet += "…"
            docs_out.write(json.dumps({
                "id": rid,
                "title": rec.get("title", ""),
                "published": rec.get("published", ""),
                "primary_category": rec.get("primary_category", ""),
                "snippet": snippet,
                "url": rec.get("arxiv_url", f"https://arxiv.org/abs/{rid}"),
                "len": dl,
            }, ensure_ascii=False) + "\n")
            doc_id += 1

    count = doc_id
    if count == 0:
        print("[arxiv-index] no indexable records found", flush=True)
        docs_tmp.unlink(missing_ok=True)
        return 1

    # Atomic-ish swap of docs store, then write postings + meta.
    docs_final = index_dir / "docs.jsonl"
    docs_tmp.replace(docs_final)

    (index_dir / "postings.json").write_text(
        json.dumps(postings, separators=(",", ":")), encoding="utf-8"
    )

    meta = {
        "count": count,
        "avgdl": round(total_len / count, 3),
        "terms": len(postings),
        "k1": K1,
        "b": B,
        "built_at": datetime.now(timezone.utc).isoformat(),
    }
    (index_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print(
        f"[arxiv-index] indexed {count} papers, {len(postings)} terms, "
        f"avgdl={meta['avgdl']} -> {index_dir}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
