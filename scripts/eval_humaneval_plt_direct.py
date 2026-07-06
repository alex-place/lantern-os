#!/usr/bin/env python3
"""Direct HumanEval runner for the Keystone-Σ₀ PLT coder — no lantern node server.

Why this exists (measured 2026-07-05, issue #2135 follow-up): the PLT model emits
no stop token, so greedy decode always burns the full `num_predict`. On a 12 GB
4070 SUPER at 4-bit it runs ~1.3 tok/s, so an untruncated (~640-tok) solution
takes >8 min/problem — past any sane chat timeout. The chat-path harness
(`eval_humaneval_chat.py`) therefore only gets a truncated, timeout-bound 55% here.
The honest untruncated number needs **bf16 on ≥24 GB (cloud L4/A100)**, where the
same model is ~4× faster and full solutions finish in seconds.

This runner is the cloud harness: it talks to the PLT's own Ollama-compatible shim
(`models/keystone-sigma0-plt/serve_keystone_plt.py`) directly over /api/chat, so a
cloud box only needs the model server — not the whole lantern web app. It reuses
the *canonical* extractor + sandbox from `eval_humaneval_ouro.py` (same scoring as
every other HumanEval row) and appends one leaderboard row, so the result is
directly comparable to `keystone-plt-humaneval20-4bit`.

Runbook (on a ≥24 GB GPU box, from repo root):
    # 1. build the checkpoint once (downloads ~18 GB Apache-2.0 weights)
    python models/keystone-sigma0-plt/download_and_patch.py
    # 2. serve in bf16 (no quant noise, ~4× faster than local 4-bit)
    python models/keystone-sigma0-plt/serve_keystone_plt.py \
        --model models/keystone-sigma0-plt/checkpoint --port 11435 --dtype bf16 &
    # 3. run the FULL 164 untruncated (bf16 finishes fast, so budget generously)
    python scripts/eval_humaneval_plt_direct.py --full --num-predict 768 \
        --label keystone-plt-humaneval164-bf16

A local 4-bit smoke (slow, will truncate — that's the whole point being measured):
    python scripts/eval_humaneval_plt_direct.py --limit 5 --num-predict 256 \
        --label keystone-plt-he5-4bit-smoke
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

# Canonical extractor + sandbox + ledger — identical scoring to every other row.
from eval_humaneval_ouro import make_candidate, run_test  # noqa: E402
from eval_ledger import append_leaderboard  # noqa: E402

INSTRUCTION = (
    "Complete the following Python function. Respond with ONLY the complete function "
    "implementation inside a single ```python code block — no explanation, no prose, "
    "no test code.\n\n"
)


def chat_once(base, model, content, num_predict, timeout):
    """POST one /api/chat turn to the PLT shim; return the assistant text."""
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
        "options": {"num_predict": num_predict},
    }).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + "/api/chat", data=payload,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read().decode("utf-8", "replace"))
    # Ollama chat shape: {"message": {"content": ...}}
    return (body.get("message") or {}).get("content", "") or ""


def run_eval(a):
    from datasets import load_dataset
    print("Loading HumanEval (openai_humaneval) ...", flush=True)
    ds = load_dataset("openai_humaneval", split="test")
    n = len(ds) if a.full else min(a.limit, len(ds))

    detail, n_ok, t0 = [], 0, time.time()
    note_counts = {}
    print(f"\nPLT direct @ {a.base}  model={a.model}  num_predict={a.num_predict}\n", flush=True)
    print(f"{'task':<14} {'pass':<5} {'sec':>6}  {'note'}", flush=True)
    for i in range(n):
        ex = ds[i]
        p0 = time.time()
        try:
            text = chat_once(a.base, a.model, INSTRUCTION + ex["prompt"],
                             a.num_predict, a.timeout)
        except Exception as e:  # noqa: BLE001 — network/timeout are data, not crashes
            text, note0 = "", f"request-error: {e}"
        else:
            note0 = ""
        pdt = time.time() - p0
        if text:
            cand = make_candidate(text, ex["entry_point"], ex["prompt"])
            ok, note = run_test(cand, ex["test"], ex["entry_point"], timeout=a.exec_timeout)
        else:
            ok, note = False, (note0 or "empty")
        n_ok += int(ok)
        if not ok:
            bucket = ("no-parse" if note == "no-parse" else "timeout" if "timeout" in note
                      else "assert" if note.startswith("assert")
                      else "request-error" if note.startswith("request-error")
                      else "exec-error" if note.startswith(("Traceback", "runner"))
                      else "other")
            note_counts[bucket] = note_counts.get(bucket, 0) + 1
        detail.append({"task_id": ex["task_id"], "entry_point": ex["entry_point"],
                       "ok": ok, "note": note, "sec": round(pdt, 1), "reply": text[:600]})
        print(f"{ex['task_id']:<14} {'OK ' if ok else 'x  '} {pdt:6.1f}  {note}", flush=True)

    dt = time.time() - t0
    summary = {
        "benchmark": "humaneval",               # shared leaderboard schema
        "ts": a.ts, "label": a.label, "engine": "plt-direct",
        "base_model": "keystone-sigma0-plt", "dtype": a.dtype, "adapter": False,
        "n": n, "subset": (not a.full),
        "pass@1": round(n_ok / n, 3) if n else 0.0,
        "accuracy": round(n_ok / n, 3) if n else 0.0,
        "passed": n_ok, "num_predict": a.num_predict,
        "wall_s": round(dt, 1), "sec_per_problem": round(dt / n, 1) if n else 0.0,
        "failure_breakdown": note_counts,
    }
    os.makedirs(os.path.join(ROOT, "data", "eval", "humaneval"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "eval", "humaneval", f"{a.label}-{a.ts}.jsonl"),
              "w", encoding="utf-8") as f:
        for d in detail:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    append_leaderboard(summary)  # stamps git_sha/served_checkpoint/campaign_id
    tag = "HumanEval" + ("" if a.full else f"[first {n}]")
    print(f"\nVERDICT {tag} pass@1 = {100*summary['pass@1']:.1f}%  ({n_ok}/{n})  "
          f"{summary['sec_per_problem']:.1f}s/problem  failures={note_counts}", flush=True)
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=os.environ.get("PLT_BASE", "http://127.0.0.1:11435"))
    ap.add_argument("--model", default="keystone-sigma0-plt")
    ap.add_argument("--label", default="keystone-plt-humaneval-direct")
    ap.add_argument("--dtype", default="bf16", help="tag only, for the ledger row (bf16|4bit)")
    ap.add_argument("--num-predict", type=int, default=768, dest="num_predict",
                    help="max new tokens; on bf16/≥24GB budget generously so nothing truncates")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--full", action="store_true", help="run all 164")
    ap.add_argument("--timeout", type=int, default=600, help="per-request HTTP timeout (s)")
    ap.add_argument("--exec-timeout", type=int, default=12, dest="exec_timeout")
    ap.add_argument("--ts", default=str(int(time.time())))
    a = ap.parse_args()
    return run_eval(a)


if __name__ == "__main__":
    raise SystemExit(main())
