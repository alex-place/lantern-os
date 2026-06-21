"""
Keystone chat — standing performance benchmark.

"Model performance is key" → make it measured, not asserted. This scores ANY
backend that speaks the Ollama /api/chat API (Ouro fast, Ouro deep/native loop,
or a cloud shim) against a golden prompt set, and appends a row to a leaderboard
so every serving change is graded on accuracy AND latency.

    python scripts/eval_keystone.py --label ouro-fast
    python scripts/eval_keystone.py --label ouro-deep --base http://127.0.0.1:11434
    python scripts/eval_keystone.py --label gpt --base http://127.0.0.1:11434/proxy

In-process loop engine (experiments E1/E2, no Ollama needed; CUDA + Ouro weights required):
    python scripts/eval_keystone.py --engine loop --mode qexit    --label ouro-qexit
    python scripts/eval_keystone.py --engine loop --mode converge --eps 0.05 --label ouro-converge
    # docs/research/2026-06-19-convergence-tesseract-spiral.md §6 (E1: depth/acc; E2: contraction)

Outputs:
    data/eval/leaderboard.jsonl   one row per run {ts,label,n,accuracy,avg_latency_s,tok_per_s,...}
    data/eval/runs/<label>-<ts>.jsonl   per-prompt detail (prompt, expected, reply, ok, latency)
"""
import argparse
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPTS = os.path.join(ROOT, "data", "eval", "sigma0-prompts.jsonl")


def has_source_citation(reply: str) -> bool:
    """Return True if the reply carries an external source citation.

    A cited reply contains a URL (https?://) or an explicit evidence marker
    ([source:…], [evidence:…], source:, evidence:). This is the proxy for
    the External Reality Rule grounding-precision metric (Gate B, §3).
    """
    import re
    r = reply.lower()
    if re.search(r'https?://', r):
        return True
    if re.search(r'\[(source|evidence|claim):', r):
        return True
    if re.search(r'\b(source:|evidence:|according to|from the|cited in)\b', r):
        return True
    return False


def score(expected: str, reply: str) -> bool:
    """Keyword-coverage rubric: the reply must satisfy EVERY comma-separated key.

    A key may list `|`-separated alternatives; the key is satisfied if ANY
    alternative appears (case-insensitive substring) — this absorbs synonyms and
    spelling variants so a correct answer isn't failed on phrasing. A key with no
    `|` is a single literal, so legacy `expected` strings score exactly as before.
    """
    r = reply.lower()
    keys = [k.strip().lower() for k in expected.split(",") if k.strip()]

    def key_ok(key: str) -> bool:
        return any(alt.strip() in r for alt in key.split("|") if alt.strip())

    return all(key_ok(k) for k in keys)


def verbosity(replies, n_correct):
    """Bytes/words spent per CORRECT continuation (Gate F, #851). Lower is better —
    it rewards a kernel that is both correct AND concise, the cost the accuracy
    column can't see. ``*_per_correct`` is None when nothing passed. Mirrors
    eval_coding_ouro.verbosity so the leaderboard column means the same everywhere."""
    n = len(replies)
    total_bytes = sum(len(r.encode("utf-8")) for r in replies)
    total_words = sum(len(r.split()) for r in replies)
    return {
        "total_reply_bytes": total_bytes,
        "avg_reply_bytes": round(total_bytes / n, 1) if n else 0.0,
        "bytes_per_correct": round(total_bytes / n_correct, 1) if n_correct else None,
        "words_per_correct": round(total_words / n_correct, 1) if n_correct else None,
    }


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


def make_loop_engine(base_model: str, adapter, mode: str, q: float, eps: float, num_predict: int):
    """In-process Ouro loop backend for E1/E2. Returns an `ask`-compatible callable
    that also reports per-token realized depth (and contraction in converge mode)."""
    from sigma0.loop_lm import Sigma0LoopLM
    m = Sigma0LoopLM.load(base_model, adapter=adapter)

    def ask_loop(prompt: str):
        t0 = time.time()
        out = m.generate(prompt, q=q, eps=eps, mode=mode, max_new_tokens=num_predict)
        dt = time.time() - t0
        return out["text"].strip(), dt, out
    return ask_loop


def main():
    # Windows consoles default to cp1252; model replies routinely contain chars
    # outside it (em-dashes, box-drawing, emoji). Without this, the per-prompt
    # print() crashes mid-run (UnicodeEncodeError) and NO leaderboard row is
    # written — the whole eval is lost on the last surprising character.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    def cprint(s):
        """Print a progress line that can never crash on console encoding.
        Replaces chars the current stdout can't encode (cp1252 on Windows) with
        '?'. The full reply is preserved verbatim in the utf-8 detail JSONL."""
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        print(s.encode(enc, "replace").decode(enc, "replace"), flush=True)

    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True, help="backend label for the leaderboard")
    ap.add_argument("--base", default="http://127.0.0.1:11434")
    ap.add_argument("--model", default="ouro:latest")
    ap.add_argument("--num-predict", type=int, default=48)
    ap.add_argument("--timeout", type=float, default=180)
    ap.add_argument("--ts", default=str(int(time.time())), help="run timestamp (override for determinism)")
    # in-process loop engine (E1/E2)
    ap.add_argument("--engine", choices=["http", "loop"], default="http",
                    help="http=Ollama API (default); loop=in-process Sigma0LoopLM (E1/E2)")
    ap.add_argument("--mode", choices=["qexit", "converge"], default="qexit",
                    help="loop engine only: confidence Q-exit (baseline) vs convergence-exit")
    ap.add_argument("--base-model", default="ByteDance/Ouro-1.4B", help="loop engine HF base")
    ap.add_argument("--adapter", default=os.environ.get("OURO_ADAPTER"), help="loop engine LoRA adapter dir")
    ap.add_argument("--q", type=float, default=0.5, help="loop engine Q-exit knob")
    ap.add_argument("--eps", type=float, default=0.05, help="loop engine convergence threshold")
    a = ap.parse_args()

    ask_loop = None
    if a.engine == "loop":
        sys.path.insert(0, os.path.join(ROOT, "src"))
        ask_loop = make_loop_engine(a.base_model, a.adapter, a.mode, a.q, a.eps, a.num_predict)

    rows = [json.loads(l) for l in open(PROMPTS, encoding="utf-8") if l.strip()]
    detail, n_ok, n_cited, total_dt, approx_tokens = [], 0, 0, 0.0, 0
    depths, contractions = [], []
    print(f"{'#':>2}  {'ok':<3} {'src':<3} {'lat':>6}  expected -> reply", flush=True)
    for r in rows:
        meta = None
        try:
            if ask_loop is not None:
                reply, dt, meta = ask_loop(r["prompt"])
            else:
                reply, dt = ask(a.base, a.model, r["prompt"], a.num_predict, a.timeout)
            ok = score(r["expected"], reply)
        except Exception as e:
            reply, dt, ok = f"[error: {e}]", 0.0, False
        cited = has_source_citation(reply)
        n_ok += int(ok)
        n_cited += int(cited)
        total_dt += dt
        approx_tokens += max(1, len(reply.split()))
        d = {"id": r["id"], "prompt": r["prompt"], "expected": r["expected"],
             "reply": reply, "ok": ok, "cited": cited, "latency_s": round(dt, 2)}
        if meta is not None:
            d["mean_depth"] = meta.get("mean_depth")
            if meta.get("mean_depth") is not None:
                depths.append(meta["mean_depth"])
            if meta.get("mean_contraction") is not None:
                d["mean_contraction"] = meta["mean_contraction"]
                contractions.append(meta["mean_contraction"])
        detail.append(d)
        cprint(f"{r['id']:>2}  {'OK ' if ok else 'x  '} {'src' if cited else '   '} {dt:>5.1f}s  {r['expected'][:18]!r} -> {reply[:50]!r}")

    n = len(rows)
    summary = {
        # reconciled schema — "benchmark" key shared across all eval scripts (#776)
        "benchmark": "keystone",
        "ts": a.ts, "label": a.label, "model": a.model, "base": a.base,
        "engine": a.engine, "mode": (a.mode if a.engine == "loop" else None),
        "n": n, "accuracy": round(n_ok / n, 3) if n else 0.0,
        "pass@1": round(n_ok / n, 3) if n else 0.0,  # alias for cross-benchmark summary
        "avg_latency_s": round(total_dt / n, 2) if n else 0.0,
        "tok_per_s": round(approx_tokens / total_dt, 1) if total_dt else 0.0,
        # Gate B: fraction of replies carrying an external source citation (External Reality Rule)
        "grounding_precision": round(n_cited / n, 3) if n else 0.0,
        # Gate F (#851): served cost per CORRECT continuation — track it down vs baseline.
        **verbosity([d["reply"] for d in detail], n_ok),
        # E1: realized latent depth; E2: did the loop contract?
        "mean_depth": round(sum(depths) / len(depths), 2) if depths else None,
        "mean_contraction": round(sum(contractions) / len(contractions), 4) if contractions else None,
    }
    os.makedirs(os.path.join(ROOT, "data", "eval", "runs"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "eval", "runs", f"{a.label}-{a.ts}.jsonl"), "w", encoding="utf-8") as f:
        for d in detail:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    with open(os.path.join(ROOT, "data", "eval", "leaderboard.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    print(f"\n{a.label}: accuracy={summary['accuracy']*100:.0f}%  "
          f"grounding_precision={summary['grounding_precision']*100:.0f}%  "
          f"avg_latency={summary['avg_latency_s']}s  ~{summary['tok_per_s']} tok/s  (n={n})", flush=True)


if __name__ == "__main__":
    main()
