#!/usr/bin/env python
"""
Σ₀ LoopLM decode benchmark — measures the native Q-exit loop's decode speed and
the two proven levers (KV cache, recurrent depth), so serving-perf decisions rest
on measurement instead of estimate.

Run on the box with the GPU + inference venv:
    .venv-train/Scripts/python scripts/bench_ouro_loop.py
    python scripts/bench_ouro_loop.py --tokens 32,128,256 --steps 1,2,3,4
    OURO_ADAPTER=D:/lantern-train/ouro-sigma0-fc-adapters/final python scripts/bench_ouro_loop.py

What it shows:
  - cache ON vs OFF at increasing output lengths -> the O(N^2) decode signature
    (the gap WIDENS with length) and the O(N) fix from the UniversalTransformerCache.
  - recurrent-depth sweep (max_steps / total_ut_steps) -> the proven speed<->quality knob.
Prints a tok/s + mean-exit-depth table and appends a summary row to
data/eval/leaderboard.jsonl.
"""
import argparse
import json
import os
import sys
import time
import pathlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking"))
    ap.add_argument("--adapter", default=os.environ.get("OURO_ADAPTER") or None)
    ap.add_argument("--tokens", default="32,128,256", help="comma list of output lengths to sweep")
    ap.add_argument("--steps", default="", help="recurrent-depth sweep e.g. 1,2,3,4 (empty = model default only)")
    ap.add_argument("--q", type=float, default=float(os.environ.get("OURO_Q", "0.5")))
    ap.add_argument("--prompt", default="Write a Python function that returns the nth Fibonacci number.")
    ap.add_argument("--truncate", action="store_true",
                    help="run the forward-truncation parity check (output must match the full-loop path)")
    args = ap.parse_args()

    import torch  # noqa: F401
    from sigma0.loop_lm import Sigma0LoopLM

    print(f"[bench] loading {args.model} (cuda={torch.cuda.is_available()}) adapter={args.adapter}", flush=True)
    m = Sigma0LoopLM.load(args.model, adapter=args.adapter)
    tok_lens = [int(x) for x in args.tokens.split(",") if x.strip()]
    step_vals = [int(x) for x in args.steps.split(",") if x.strip()] or [m.max_steps]

    def run(n_tok):
        out = None
        for _ in range(2):  # 2nd call is steady-state (1st warms kernels/compile)
            t0 = time.perf_counter()
            out = m.generate(args.prompt, q=args.q, max_new_tokens=n_tok, canary=False)
            dt = time.perf_counter() - t0
        toks = out["tokens"] or 1
        return dt, toks / dt, out["mean_depth"]

    rows = []
    print("\n=== KV cache ON vs OFF  (O(N) vs O(N^2) — the gap should widen with length) ===")
    print(f"{'tokens':>7} {'cache':>6} {'sec':>8} {'tok/s':>8} {'depth':>6}")
    for use_cache in ("1", "0"):
        os.environ["OURO_LOOP_CACHE"] = use_cache
        for n in tok_lens:
            dt, tps, depth = run(n)
            print(f"{n:>7} {('on' if use_cache == '1' else 'off'):>6} {dt:>8.2f} {tps:>8.2f} {depth:>6.2f}", flush=True)
            rows.append({"lever": "cache", "cache": use_cache, "out_tokens": n,
                         "sec": round(dt, 3), "tok_s": round(tps, 2), "mean_depth": depth})
    os.environ["OURO_LOOP_CACHE"] = "1"

    if len(step_vals) > 1:
        print("\n=== recurrent-depth sweep (max_steps) — speed vs depth ===")
        print(f"{'steps':>6} {'sec':>8} {'tok/s':>8} {'depth':>6}")
        n = tok_lens[-1]
        for s in step_vals:
            m.max_steps = s
            dt, tps, depth = run(n)
            print(f"{s:>6} {dt:>8.2f} {tps:>8.2f} {depth:>6.2f}", flush=True)
            rows.append({"lever": "depth", "max_steps": s, "out_tokens": n,
                         "sec": round(dt, 3), "tok_s": round(tps, 2), "mean_depth": depth})

    if args.truncate:
        print("\n=== forward-truncation parity + savings (qexit, no-cache both sides) ===")
        n = tok_lens[0]
        os.environ["OURO_LOOP_CACHE"] = "0"
        os.environ["OURO_LOOP_TRUNCATE"] = "0"
        t0 = time.perf_counter(); full = m.generate(args.prompt, q=args.q, max_new_tokens=n, canary=False); full_dt = time.perf_counter() - t0
        os.environ["OURO_LOOP_TRUNCATE"] = "1"
        t0 = time.perf_counter(); trunc = m.generate(args.prompt, q=args.q, max_new_tokens=n, canary=False); trunc_dt = time.perf_counter() - t0
        os.environ["OURO_LOOP_TRUNCATE"] = "0"
        parity = full["text"] == trunc["text"]
        print(f"PARITY (text identical): {parity}   <- MUST be True before trusting truncation")
        print(f"  full-loop : {full_dt:6.2f}s  depth={full['mean_depth']}  tokens={full['tokens']}")
        print(f"  truncated : {trunc_dt:6.2f}s  depth={trunc['mean_depth']}  tokens={trunc['tokens']}")
        if not parity:
            print("  WARNING: truncation changed the output — the forward replica (mask/rotary/position prep)")
            print("           has a bug; do NOT enable OURO_LOOP_TRUNCATE in serving until parity holds.")
        rows.append({"lever": "truncate", "parity": parity, "out_tokens": n,
                     "full_sec": round(full_dt, 3), "trunc_sec": round(trunc_dt, 3),
                     "full_depth": full["mean_depth"], "trunc_depth": trunc["mean_depth"]})

    lb = pathlib.Path(__file__).resolve().parents[1] / "data" / "eval" / "leaderboard.jsonl"
    lb.parent.mkdir(parents=True, exist_ok=True)
    with lb.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"benchmark": "ouro-loop-bench", "ts": str(int(time.time())),
                            "model": args.model, "adapter": args.adapter, "rows": rows}) + "\n")
    print(f"\n[bench] appended summary to {lb}", flush=True)


if __name__ == "__main__":
    main()
