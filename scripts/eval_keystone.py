"""
Keystone chat — standing performance benchmark.

"Model performance is key" → make it measured, not asserted. This scores ANY
backend that speaks the Ollama /api/chat API (Ouro fast, Ouro deep/native loop,
or a cloud shim) against a golden prompt set, and appends a row to a leaderboard
so every serving change is graded on accuracy AND latency.

    python scripts/eval_keystone.py --label ouro-fast
    python scripts/eval_keystone.py --label ouro-deep --base http://127.0.0.1:11434
    python scripts/eval_keystone.py --label gpt --base http://127.0.0.1:11434/proxy

Outputs:
    data/eval/leaderboard.jsonl   one row per run {ts,label,n,accuracy,avg_latency_s,tok_per_s}
    data/eval/runs/<label>-<ts>.jsonl   per-prompt detail (prompt, expected, reply, ok, latency)
"""
import argparse
import json
import os
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPTS = os.path.join(ROOT, "data", "eval", "sigma0-prompts.jsonl")


def score(expected: str, reply: str) -> bool:
    """Keyword-coverage: every comma-separated key in `expected` must appear."""
    r = reply.lower()
    keys = [k.strip().lower() for k in expected.split(",") if k.strip()]
    return all(k in r for k in keys)


def ask(base: str, model: str, prompt: str, num_predict: int, timeout: float):
    payload = json.dumps({
        "model": model, "stream": False,
        "messages": [{"role": "user", "content": prompt}],
        "options": {"num_predict": num_predict},
    }).encode()
    req = urllib.request.Request(base.rstrip("/") + "/api/chat", data=payload,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read())
    dt = time.time() - t0
    text = (body.get("message") or {}).get("content") or body.get("response") or ""
    return text.strip(), dt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True, help="backend label for the leaderboard")
    ap.add_argument("--base", default="http://127.0.0.1:11434")
    ap.add_argument("--model", default="ouro:latest")
    ap.add_argument("--num-predict", type=int, default=48)
    ap.add_argument("--timeout", type=float, default=180)
    ap.add_argument("--ts", default=str(int(time.time())), help="run timestamp (override for determinism)")
    a = ap.parse_args()

    rows = [json.loads(l) for l in open(PROMPTS, encoding="utf-8") if l.strip()]
    detail, n_ok, total_dt, approx_tokens = [], 0, 0.0, 0
    print(f"{'#':>2}  {'ok':<3} {'lat':>6}  expected -> reply", flush=True)
    for r in rows:
        try:
            reply, dt = ask(a.base, a.model, r["prompt"], a.num_predict, a.timeout)
            ok = score(r["expected"], reply)
        except Exception as e:
            reply, dt, ok = f"[error: {e}]", 0.0, False
        n_ok += int(ok)
        total_dt += dt
        approx_tokens += max(1, len(reply.split()))
        detail.append({"id": r["id"], "prompt": r["prompt"], "expected": r["expected"],
                       "reply": reply, "ok": ok, "latency_s": round(dt, 2)})
        print(f"{r['id']:>2}  {'OK ' if ok else 'x  '} {dt:>5.1f}s  {r['expected'][:18]!r} -> {reply[:50]!r}", flush=True)

    n = len(rows)
    summary = {
        "ts": a.ts, "label": a.label, "model": a.model, "base": a.base,
        "n": n, "accuracy": round(n_ok / n, 3) if n else 0.0,
        "avg_latency_s": round(total_dt / n, 2) if n else 0.0,
        "tok_per_s": round(approx_tokens / total_dt, 1) if total_dt else 0.0,
    }
    os.makedirs(os.path.join(ROOT, "data", "eval", "runs"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "eval", "runs", f"{a.label}-{a.ts}.jsonl"), "w", encoding="utf-8") as f:
        for d in detail:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    with open(os.path.join(ROOT, "data", "eval", "leaderboard.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    print(f"\n{a.label}: accuracy={summary['accuracy']*100:.0f}%  "
          f"avg_latency={summary['avg_latency_s']}s  ~{summary['tok_per_s']} tok/s  (n={n})", flush=True)


if __name__ == "__main__":
    main()
