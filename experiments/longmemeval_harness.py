#!/usr/bin/env python3
"""
LongMemEval retrieval harness for the Keystone CSF MemoryEngine.

WHY (Σ₀ external-reality rule): MemOS publishes LongMemEval / PersonaMem numbers
(+40% over OpenAI memory). We had *none* — so we could not honestly claim our
memory retrieval is good. This harness produces the missing
[claim, evidence, confidence, source] for our own store by measuring
retrieval recall@k / MRR on LongMemEval-shaped data, comparing the two
retrieval modes our engine ALREADY implements:

    * keyword    — inverted-index candidates, first-match order
                   (MemoryEngine.query(..., use_multi_signal=False))
    * multi      — fused score: semantic 0.5 + keyword 0.3 + entity 0.2
                   (MemoryEngine.query(..., use_multi_signal=True))

It evaluates the canonical Python store (src/csf/memory_engine.py) — the same
query API the rest of the system is built on. (The live JS chat path adds a
nomic-embed semantic rerank on top; that is measured separately by the Node
preview path, not here.)

USAGE
    # Offline self-test on the baked-in synthetic fixture:
    python experiments/longmemeval_harness.py

    # Against the real benchmark (download longmemeval_s.json or _m / _oracle):
    #   https://github.com/xiaowu0162/LongMemEval  (HF: xiaowu0162/longmemeval)
    LONGMEMEVAL_PATH=/path/to/longmemeval_s.json \
        python experiments/longmemeval_harness.py --k 5 --limit 200

OUTPUT
    A per-mode table of recall@k and MRR, plus a JSONL run record appended to
    data/longmemeval/runs.jsonl so results accrue as evidence over time.

DATASET SHAPE (LongMemEval)
    Each instance:
      {
        "question_id": str,
        "question_type": str,
        "question": str,
        "answer": str,
        "question_date": str,
        "haystack_sessions": [ [ {"role","content","has_answer"?}, ... ], ... ],
        "answer_session_ids"?: [...]            # not always present
      }
    A turn carrying "has_answer": true is gold evidence. Retrieval is correct if
    any gold turn appears in the top-k retrieved memories for that question.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Make src/ importable when run from repo root (mirrors pytest.ini pythonpath).
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT))

from csf.memory_engine import MemoryEngine, create_trace, PrivacyScope  # noqa: E402

_STOP = {
    "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be",
    "to", "of", "in", "on", "at", "for", "with", "by", "from", "what", "when",
    "where", "why", "how", "who", "did", "do", "does", "i", "you", "my", "your",
    "it", "this", "that", "me", "we", "they", "he", "she", "as", "if", "so",
}


def _tokens(text: str, limit: int = 12) -> List[str]:
    seen, out = set(), []
    for w in re.split(r"[^a-z0-9]+", str(text or "").lower()):
        if len(w) <= 2 or w in _STOP or w in seen:
            continue
        seen.add(w)
        out.append(w)
        if len(out) >= limit:
            break
    return out


# ───────────────────────── synthetic offline fixture ─────────────────────────
# Three instances with an unambiguous gold turn each, plus distractor sessions,
# so the harness self-tests end-to-end with no network / no dataset download.
_SYNTH: List[Dict[str, Any]] = [
    {
        "question_id": "synth-1",
        "question_type": "single-session-user",
        "question": "What city did I say I was moving to for the new job?",
        "answer": "Lisbon",
        "haystack_sessions": [
            [
                {"role": "user", "content": "The weather has been rainy all week."},
                {"role": "assistant", "content": "Hope it clears up soon."},
            ],
            [
                {"role": "user",
                 "content": "Big news — I accepted the offer and I'm moving to Lisbon for the new job.",
                 "has_answer": True},
                {"role": "assistant", "content": "Congratulations on the move!"},
            ],
            [
                {"role": "user", "content": "I reorganized my bookshelf by color today."},
            ],
        ],
    },
    {
        "question_id": "synth-2",
        "question_type": "preference",
        "question": "Which programming language did I say is my favorite?",
        "answer": "Rust",
        "haystack_sessions": [
            [
                {"role": "user", "content": "My cat knocked a glass off the table."},
            ],
            [
                {"role": "user",
                 "content": "Honestly Rust is my favorite programming language — the borrow checker grew on me.",
                 "has_answer": True},
                {"role": "assistant", "content": "Rust's ownership model is powerful."},
            ],
            [
                {"role": "user", "content": "I went for a long run this morning."},
            ],
        ],
    },
    {
        "question_id": "synth-3",
        "question_type": "knowledge-update",
        "question": "What did I change my coffee order to?",
        "answer": "oat milk flat white",
        "haystack_sessions": [
            [
                {"role": "user", "content": "I used to always get a black americano."},
            ],
            [
                {"role": "user",
                 "content": "Update: I switched my usual coffee order to an oat milk flat white.",
                 "has_answer": True},
            ],
            [
                {"role": "user", "content": "The bus was late again today."},
            ],
        ],
    },
]


def load_instances(path: Optional[str], limit: int) -> List[Dict[str, Any]]:
    if not path:
        print("[harness] no LONGMEMEVAL_PATH set -- using baked-in synthetic fixture")
        return _SYNTH[:limit] if limit else _SYNTH
    p = Path(path)
    data = json.loads(p.read_text(encoding="utf-8"))
    if isinstance(data, dict):  # some dumps wrap the list
        data = data.get("data") or data.get("instances") or list(data.values())
    print(f"[harness] loaded {len(data)} instances from {p}")
    return data[:limit] if limit else data


def ingest(engine: MemoryEngine, instance: Dict[str, Any]) -> int:
    """Ingest every turn as a trace; gold turns tagged 'gold'. Returns turn count."""
    n = 0
    for si, session in enumerate(instance.get("haystack_sessions", [])):
        for ti, turn in enumerate(session):
            text = str(turn.get("content", "")).strip()
            if not text:
                continue
            gold = bool(turn.get("has_answer"))
            rec = create_trace(
                text=text,
                session_id=f"{instance['question_id']}-s{si}",
                surface="longmemeval",
                role=str(turn.get("role", "user")),
                confidence=1.0,
                privacy_scope=PrivacyScope.INTERNAL,
                tags=["longmemeval", "gold"] if gold else ["longmemeval"],
                keywords=_tokens(text),
            )
            rec.metadata = {"gold": gold, "session": si, "turn": ti}
            engine.write(rec)
            n += 1
    return n


def retrieve(engine: MemoryEngine, question: str, k: int, multi_signal: bool):
    # match_any=True: union of keyword candidates (recall behavior). A NL question
    # never has all its tokens in one turn, so AND-intersection returns nothing.
    return engine.query(
        keywords=_tokens(question),
        tags=["longmemeval"],
        limit=k,
        use_multi_signal=multi_signal,
        match_any=True,
    )


def rank_of_gold(records) -> Optional[int]:
    """1-based rank of the first gold record in the result list, else None."""
    for i, rec in enumerate(records, start=1):
        if rec.metadata.get("gold"):
            return i
    return None


def evaluate(instances: List[Dict[str, Any]], k: int) -> Dict[str, Any]:
    modes = {"keyword": False, "multi": True}
    agg = {m: {"hits": 0, "rr_sum": 0.0} for m in modes}
    total = 0

    for inst in instances:
        if not any(
            turn.get("has_answer")
            for sess in inst.get("haystack_sessions", [])
            for turn in sess
        ):
            continue  # no gold-labelled turn → cannot score retrieval
        total += 1
        with tempfile.TemporaryDirectory() as tmp:
            engine = MemoryEngine(base_path=tmp)
            ingest(engine, inst)
            for mode, ms in modes.items():
                recs = retrieve(engine, inst["question"], k, ms)
                rank = rank_of_gold(recs)
                if rank is not None and rank <= k:
                    agg[mode]["hits"] += 1
                    agg[mode]["rr_sum"] += 1.0 / rank

    out = {"k": k, "scored_instances": total, "modes": {}}
    for mode in modes:
        h, rr = agg[mode]["hits"], agg[mode]["rr_sum"]
        out["modes"][mode] = {
            "recall_at_k": round(h / total, 4) if total else 0.0,
            "mrr": round(rr / total, 4) if total else 0.0,
            "hits": h,
        }
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="LongMemEval retrieval harness for CSF MemoryEngine")
    ap.add_argument("--k", type=int, default=5, help="top-k cutoff (default 5)")
    ap.add_argument("--limit", type=int, default=0, help="cap instances (0 = all)")
    ap.add_argument("--path", default=os.environ.get("LONGMEMEVAL_PATH"),
                    help="path to longmemeval_*.json (or set LONGMEMEVAL_PATH)")
    args = ap.parse_args()

    instances = load_instances(args.path, args.limit)
    result = evaluate(instances, args.k)

    print(f"\nLongMemEval retrieval -- CSF MemoryEngine  (k={result['k']}, "
          f"n={result['scored_instances']} scored)\n")
    print(f"  {'mode':<10} {'recall@k':>9} {'MRR':>7} {'hits':>6}")
    print("  " + "-" * 34)
    for mode, m in result["modes"].items():
        print(f"  {mode:<10} {m['recall_at_k']:>9} {m['mrr']:>7} {m['hits']:>6}")

    km = result["modes"]["keyword"]["recall_at_k"]
    mm = result["modes"]["multi"]["recall_at_k"]
    delta = round(mm - km, 4)
    print(f"\n  multi-signal vs keyword recall@{result['k']}: "
          f"{'+' if delta >= 0 else ''}{delta}")

    # Append run record as accruing evidence.
    runs_dir = REPO_ROOT / "data" / "longmemeval"
    runs_dir.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "dataset": args.path or "synthetic-fixture",
        **result,
        "multi_minus_keyword_recall": delta,
        "source": "experiments/longmemeval_harness.py",
    }
    with open(runs_dir / "runs.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")
    print(f"\n  run appended -> data/longmemeval/runs.jsonl")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
