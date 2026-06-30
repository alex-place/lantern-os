#!/usr/bin/env python3
"""memory_bench_incumbents.py — incumbent side of the memory head-to-head (#1739).

Runs the SAME dataset + SAME recall@k / MRR metric as the Node harness
(experiments/memory_recall_bench.js) against external memory systems — Mem0 and
Letta (ex-MemGPT) — so the comparison lands in one leaderboard table
(data/eval/leaderboard.jsonl, benchmark="longmemeval").

This is the *incumbent* adapter; our own retrieval is benchmarked by the Node
harness. Keeping the two in one file each, sharing the dataset contract, is the
sustainable shape: add an adapter, not a parallel harness.

Status by design: if an incumbent package is not installed (or not configured
with a backend), that engine is SKIPPED with install instructions rather than
crashing — so the head-to-head is *wired* and runs the moment you opt in:

    pip install mem0ai           # then set OPENAI_API_KEY or configure Ollama
    pip install letta

Run:
    python experiments/memory_bench_incumbents.py            # fixture, k=5
    python experiments/memory_bench_incumbents.py --dataset data/longmemeval/longmemeval_s.json --engines mem0,letta

Metric (identical to the Node harness): for each instance, ingest every session,
query with the question, take the ranked session ids; recall@k = a gold session
appears in the top-k; MRR = 1/rank of the first gold. Caveat: Mem0/Letta extract
*facts* rather than store raw sessions, so we tag each stored item with its
session_id metadata and map retrieved items back to sessions — documented so the
comparison is apples-to-apples on *session recall*, the LongMemEval unit.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


# ── dataset (mirrors the Node harness normalizer) ────────────────────────────────
def session_text(turns):
    out = []
    for t in turns or []:
        out.append(t if isinstance(t, str) else t.get("content", ""))
    return "\n".join(out)


def normalize(raw):
    rows = raw if isinstance(raw, list) else raw.get("instances", raw.get("data", []))
    inst = []
    for i, r in enumerate(rows):
        if isinstance(r.get("haystack_sessions"), list):
            ids = r.get("haystack_session_ids") or [f"sess_{j}" for j in range(len(r["haystack_sessions"]))]
            sessions = [{"id": str(ids[j]), "text": session_text(turns)} for j, turns in enumerate(r["haystack_sessions"])]
        else:
            sessions = [{"id": str(s.get("session_id", s.get("id", f"sess_{j}"))), "text": s.get("text") or session_text(s.get("turns"))}
                        for j, s in enumerate(r.get("sessions", []))]
        gold = set(str(x) for x in (r.get("answer_session_ids") or r.get("gold_session_ids") or []))
        q = r.get("question") or r.get("query") or ""
        if q and sessions and gold:
            inst.append({"id": str(r.get("id", r.get("question_id", f"q_{i}"))), "question": q, "sessions": sessions, "gold": gold})
    return inst


def load_dataset(arg):
    candidates = [arg] if arg else [REPO / "data/longmemeval/longmemeval_s.json", REPO / "data/longmemeval/fixture.json"]
    for p in candidates:
        p = Path(p)
        if p.exists():
            inst = normalize(json.loads(p.read_text(encoding="utf-8")))
            if inst:
                real = p.name.lower() in ("longmemeval_s.json", "longmemeval_m.json", "longmemeval_l.json")
                return inst, ("synthetic-fixture" if not real else p.stem), p
    raise SystemExit("no dataset found (looked for longmemeval_s.json then fixture.json)")


# ── metric (identical definition to the Node harness) ────────────────────────────
def score(ranked_ids, gold, k):
    topk = ranked_ids[:k]
    hit = 1 if any(i in gold for i in topk) else 0
    rr = 0.0
    for idx, i in enumerate(ranked_ids):
        if i in gold:
            rr = 1.0 / (idx + 1)
            break
    return hit, rr


# ── incumbent adapters (each returns ranked session ids, or raises to skip) ──────
def run_mem0(instances, k):
    from mem0 import Memory  # raises ImportError if not installed
    hits = rr_sum = 0
    for inst in instances:
        m = Memory()  # uses configured backend (OPENAI_API_KEY or local config)
        uid = inst["id"]
        for s in inst["sessions"]:
            m.add(s["text"], user_id=uid, metadata={"session_id": s["id"]})
        res = m.search(inst["question"], user_id=uid, limit=max(k, len(inst["sessions"])))
        items = res.get("results", res) if isinstance(res, dict) else res
        ranked, seen = [], set()
        for it in items:
            sid = (it.get("metadata") or {}).get("session_id")
            if sid and sid not in seen:
                seen.add(sid)
                ranked.append(sid)
        h, r = score(ranked, inst["gold"], k)
        hits += h
        rr_sum += r
    n = len(instances)
    return {"recall_at_k": round(hits / n, 4), "mrr": round(rr_sum / n, 4), "hits": hits, "n": n}


def run_letta(instances, k):
    import letta  # noqa: F401 — raises ImportError if not installed
    raise NotImplementedError(
        "letta adapter needs a running Letta server + agent; wire it like run_mem0 once a server is available"
    )


ADAPTERS = {"mem0": run_mem0, "letta": run_letta}
INSTALL = {"mem0": "pip install mem0ai  (then set OPENAI_API_KEY or configure a local Ollama backend)",
           "letta": "pip install letta  (then start a Letta server)"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=None)
    ap.add_argument("--k", type=int, default=5)
    ap.add_argument("--engines", default="mem0,letta")
    ap.add_argument("--no-write", action="store_true")
    args = ap.parse_args()

    instances, dataset, _ = load_dataset(args.dataset)
    engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    print(f"LongMemEval incumbents — dataset={dataset} (n={len(instances)}, k={args.k})")

    rows = []
    for eng in engines:
        adapter = ADAPTERS.get(eng)
        if not adapter:
            print(f"  {eng:<8} UNKNOWN engine")
            continue
        try:
            res = adapter(instances, args.k)
            print(f"  {eng:<8} recall@{args.k}={res['recall_at_k']}  mrr={res['mrr']}  ({res['hits']}/{res['n']})")
            rows.append((eng, res))
        except ImportError:
            print(f"  {eng:<8} SKIPPED (not installed) — {INSTALL.get(eng, 'install the package')}")
        except NotImplementedError as e:
            print(f"  {eng:<8} SKIPPED (adapter stub) — {e}")
        except Exception as e:  # backend not configured, server down, etc.
            print(f"  {eng:<8} SKIPPED ({type(e).__name__}: {e})")

    if rows and not args.no_write:
        lb = REPO / "data/eval/leaderboard.jsonl"
        lb.parent.mkdir(parents=True, exist_ok=True)
        ts = str(int(time.time()))
        with lb.open("a", encoding="utf-8") as f:
            for eng, res in rows:
                f.write(json.dumps({
                    "benchmark": "longmemeval", "ts": ts, "label": f"{eng}", "engine": eng,
                    "dataset": dataset, "k": args.k, "n": res["n"],
                    "recall_at_k": res["recall_at_k"], "mrr": res["mrr"],
                    "subset": dataset == "synthetic-fixture",
                    "source": "experiments/memory_bench_incumbents.py",
                }) + "\n")
        print(f"  wrote {len(rows)} row(s) -> data/eval/leaderboard.jsonl")
    elif not rows:
        print("  (no incumbent ran — install at least one package above to produce the head-to-head)")


if __name__ == "__main__":
    main()
