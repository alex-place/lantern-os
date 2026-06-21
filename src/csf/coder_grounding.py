"""
Σ₀ Ouro Coder ↔ Knowledge Center grounding — in ONE CSF file.

The least-sprawl way to ground the looped local coder ([`docs/SIGMA0-OURO-CODER.md`])
in the Knowledge Center: pack the whole KC grounding corpus
(`data/knowledge/index.jsonl`, built by `scripts/build_knowledge_index.py`) into a
**single** self-contained, integrity-checked CSF archive using the new best-fit
**omni** codec, and retrieve from that one file. No new corpus, no new index, no new
retriever service — it reuses `csf_pack` (omni), the existing KB index, and the
existing coder gate.

  build()                  -> pack the KB index into data/csf/coder-grounding.csf (one file)
  retrieve(query, k=5)     -> top-k KC sections from that CSF (TF-IDF, mirrors knowledge-router.js)
  grounded_gate(task, ...) -> a sigma0_coder_gate.CoderGate grounded in those sections
                              (lifts the ungrounded confidence ceiling + folds the
                              KC evidence into the coder's system surface)

CLI:
    python -m csf.coder_grounding build
    python -m csf.coder_grounding query "how does convergence-exit work"

Why this shape: the coder is served drop-in over the Ollama API by `ouro_serve.py`,
and its system surface is composed by `sigma0_coder_gate.build_pre_generation_gate`.
That gate already takes `grounding_evidence` + `base_prompt` and caps confidence when
ungrounded — so grounding the coder is exactly "hand it KC evidence", which this does
from a single CSF archive. Nothing else changes.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

from . import csf_pack

REPO = Path(__file__).resolve().parent.parent.parent
KB_INDEX = REPO / "data" / "knowledge" / "index.jsonl"
KB_META = REPO / "data" / "knowledge" / "index.meta.json"
GROUNDING_CSF = REPO / "data" / "csf" / "coder-grounding.csf"
_ARC_INDEX = "knowledge/index.jsonl"  # member path inside the archive

# Tokeniser + stopwords mirror apps/lantern-garage/lib/knowledge-router.js so the
# coder's grounding ranks identically to the rest of the system.
_STOP = set("the a an of to and or is are for in on with how do does what why this "
            "that it as be by from at".split())
_TOKEN = re.compile(r"[a-z0-9_]{3,}")

_cache: dict | None = None


def _tokenize(s: str) -> list[str]:
    return [t for t in _TOKEN.findall((s or "").lower()) if t not in _STOP]


# ---------------------------------------------------------------------------
# Build: pack the KC grounding corpus into one omni CSF archive
# ---------------------------------------------------------------------------

def build(out_path: str | Path = GROUNDING_CSF) -> dict:
    """Pack the KB index (+meta) into a single best-fit (omni) CSF archive.

    Returns {records, raw_bytes, archive_bytes, ratio, codec, path}. Run
    `python scripts/build_knowledge_index.py` first if the index is stale.
    """
    if not KB_INDEX.exists():
        raise FileNotFoundError(
            f"{KB_INDEX} missing — run `python scripts/build_knowledge_index.py` first")
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    idx_bytes = KB_INDEX.read_bytes()
    blobs = {_ARC_INDEX: idx_bytes}
    if KB_META.exists():
        blobs["knowledge/index.meta.json"] = KB_META.read_bytes()
    n_records = sum(1 for ln in idx_bytes.splitlines() if ln.strip())
    # codec="omni" = the deterministic best-fit codec (CSF-FORMAT-SPECIFICATION §2.7.1)
    csf_pack.pack_blobs(blobs, str(out), compress=True, codec="omni",
                        extra_meta={"grounding": {"kind": "coder", "index": _ARC_INDEX,
                                                  "records": n_records}})
    raw = sum(len(b) for b in blobs.values())
    size = out.stat().st_size
    global _cache
    _cache = None  # force reload from the new archive
    return {"records": n_records, "raw_bytes": raw, "archive_bytes": size,
            "ratio": round(raw / size, 2) if size else 0.0, "codec": "omni", "path": str(out)}


# ---------------------------------------------------------------------------
# Retrieve: top-k KC sections from the one CSF file
# ---------------------------------------------------------------------------

def _records() -> dict:
    """Load + TF-IDF-index the KC sections from the CSF archive (cached).

    Self-bootstrapping: builds the archive from the live KB index if absent, so a
    fresh checkout grounds the coder with a single call.
    """
    global _cache
    if _cache is not None:
        return _cache
    if not GROUNDING_CSF.exists():
        build()
    # codec-aware, integrity-verified read of the single member
    raw = csf_pack.read_file(str(GROUNDING_CSF), _ARC_INDEX)
    recs, df = [], {}
    for line in raw.decode("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        toks = _tokenize(f"{r.get('heading', '')} {r.get('text', '')}")
        tf: dict[str, int] = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        for t in tf:
            df[t] = df.get(t, 0) + 1
        recs.append({**r, "_tf": tf, "_len": len(toks) or 1})
    n = len(recs) or 1
    idf = {t: math.log(1 + n / c) for t, c in df.items()}
    _cache = {"recs": recs, "idf": idf, "n": n}
    return _cache


def retrieve(query: str, k: int = 5) -> list[dict]:
    """Top-k KC sections for `query` (TF-IDF, descending). Each: id/path/heading/text/score."""
    data = _records()
    qtoks = _tokenize(query)
    idf = data["idf"]
    scored = []
    for r in data["recs"]:
        s = sum((r["_tf"].get(t, 0) / r["_len"]) * idf.get(t, 0.0) for t in qtoks)
        if s > 0:
            scored.append((s, r))
    scored.sort(key=lambda x: x[0], reverse=True)
    out = []
    for s, r in scored[:k]:
        out.append({"id": r.get("id"), "path": r.get("path"), "heading": r.get("heading"),
                    "doc": r.get("doc"), "text": r.get("text", ""), "score": round(s, 4)})
    return out


# ---------------------------------------------------------------------------
# Ground the Σ₀ Ouro Coder: feed retrieved KC sections to the existing gate
# ---------------------------------------------------------------------------

def grounding_context(query: str, k: int = 5) -> tuple[str, list[str]]:
    """Return (preamble_text, evidence_ids) for the top-k KC sections."""
    hits = retrieve(query, k)
    if not hits:
        return "", []
    lines = ["Relevant Keystone OS grounding (Knowledge Center, retrieved from CSF):"]
    ids = []
    for h in hits:
        src = h["path"] or h["doc"] or h["id"]
        ids.append(src)
        snippet = " ".join((h["text"] or "").split())[:480]
        lines.append(f"- [{src}] {snippet}")
    return "\n".join(lines), ids


def grounded_gate(task: str, base_prompt: str | None = None, k: int = 5):
    """Build a `sigma0_coder_gate.CoderGate` grounded in the KC for `task`.

    Retrieves the top-k KC sections from the single CSF archive and passes them to
    the existing gate as `grounding_evidence` (which lifts the ungrounded confidence
    ceiling) and folds the section text into `base_prompt`. Returns the CoderGate the
    coder dispatch should send as its system surface.
    """
    import sigma0_coder_gate  # lazy: keeps build/retrieve usable without it on the path
    preamble, ids = grounding_context(task, k)
    merged = "\n\n".join(p for p in (base_prompt, preamble) if p) or None
    return sigma0_coder_gate.build_pre_generation_gate(grounding_evidence=ids, base_prompt=merged)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="csf.coder_grounding",
                                 description="Pack/retrieve KC grounding for the Σ₀ Ouro Coder")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build", help="pack the KB index into one omni CSF archive")
    q = sub.add_parser("query", help="retrieve top-k KC sections")
    q.add_argument("text")
    q.add_argument("-k", type=int, default=5)
    g = sub.add_parser("gate", help="show the grounded coder system surface for a task")
    g.add_argument("text")
    g.add_argument("-k", type=int, default=5)
    args = ap.parse_args(argv)

    if args.cmd == "build":
        m = build()
        print(f"packed {m['records']} KC sections -> {m['path']}  "
              f"({m['raw_bytes']:,} -> {m['archive_bytes']:,} B, {m['ratio']}x, codec={m['codec']})")
    elif args.cmd == "query":
        for h in retrieve(args.text, args.k):
            print(f"  {h['score']:.4f}  {h['path']}")
    elif args.cmd == "gate":
        print(grounded_gate(args.text, k=args.k).system_prompt)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
