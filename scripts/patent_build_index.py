"""
Build a compact BM25 retrieval index over the harvested worldwide-patent corpus so
the unisona.ai chat assistant can pull the most relevant patents per question without
a linear scan of the whole corpus.

Reads   $PATENT_CORPUS_DIR\\raw\\*.jsonl   (produced by patent_harvest.py)
Writes  $PATENT_CORPUS_DIR\\index\\postings.json   {term: [[docId, tf], ...]}
        $PATENT_CORPUS_DIR\\index\\docs.jsonl       line docId = {id,title,published,country,assignee,cpc,snippet,url,len}
        $PATENT_CORPUS_DIR\\index\\meta.json         {count, avgdl, k1, b, built_at, terms}

Idempotent — safe to re-run after every harvest. The tokenizer here MUST match the one
in lib/patent-index.js (same lowercase / [a-z0-9]+ / stopword rules)
or query terms won't line up with indexed terms. It is byte-identical to
arxiv_build_index.py's tokenizer on purpose — the two corpora share one tokenization
contract.

Run:
    python scripts/patent_build_index.py
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

DEFAULT_ROOT = Path(os.environ.get("PATENT_CORPUS_DIR", r"F:\patent-corpus"))

SNIPPET_CHARS = 400
# Full text (claims/description) is only freely available for EP/WO/US; where a record
# carries it we fold a bounded slice into the indexed text so those patents rank on more
# than their abstract. Bounded so one full-text patent can't dominate doc-length norms.
CLAIMS_INDEX_CHARS = 4000
K1 = 1.5
B = 0.75

# Small stopword set — matched verbatim in patent-index.js (and arxiv-index.js).
STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "as",
    "by", "at", "from", "is", "are", "be", "been", "was", "were", "this", "that", "these",
    "those", "it", "its", "we", "our", "they", "their", "can", "which", "such", "using",
    "used", "use", "via", "into", "than", "then", "also", "more", "most", "have", "has",
    "not", "no", "do", "does", "how", "what", "when", "where", "why", "who",
}

TOKEN_RE = re.compile(r"[a-z0-9]+")


def corpus_root() -> Path:
    return Path(os.environ.get("PATENT_CORPUS_DIR", str(DEFAULT_ROOT)))


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


def canonical_url(rec: dict) -> str:
    url = rec.get("patent_url") or rec.get("url") or ""
    if url:
        return url
    # Google Patents resolves any office's publication number and is a stable citation
    # host — but it wants the compact form (US11289701B2), not the display form
    # (US-11289701-B2), so strip separators from the id before building the URL.
    pid = (rec.get("id", "") or "").replace("-", "").replace(" ", "")
    return f"https://patents.google.com/patent/{pid}/en" if pid else ""


def main(argv=None) -> int:
    root = corpus_root()
    raw_dir = root / "raw"
    index_dir = root / "index"
    if not raw_dir.exists():
        print(f"[patent-index] no raw corpus at {raw_dir}; run patent_harvest.py first", flush=True)
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

            claims = (rec.get("claims", "") or "")[:CLAIMS_INDEX_CHARS]
            tokens = tokenize(f"{rec.get('title', '')} {rec.get('abstract', '')} {claims}")
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
                "country": rec.get("country", "") or (rid[:2] if len(rid) >= 2 else ""),
                "assignee": rec.get("assignee", ""),
                "cpc": (rec.get("cpc", [""]) or [""])[0] if isinstance(rec.get("cpc"), list) else rec.get("cpc", ""),
                "snippet": snippet,
                "url": canonical_url(rec),
                "len": dl,
            }, ensure_ascii=False) + "\n")
            doc_id += 1

    count = doc_id
    if count == 0:
        print("[patent-index] no indexable records found", flush=True)
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
        f"[patent-index] indexed {count} patents, {len(postings)} terms, "
        f"avgdl={meta['avgdl']} -> {index_dir}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
