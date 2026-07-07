#!/usr/bin/env python3
"""
Executable coding benchmark for Σ₀ Ouro Coder (#776).

25 MBPP-style prompts with exec-and-assert checks, covering common algorithms and
data structures. Measures pass@1 (correct function generated), verbosity (bytes and
words per correct answer), and latency.

Runs against the Ollama API (no GPU weights needed):
    python scripts/eval_coding.py --label ouro-fast
    python scripts/eval_coding.py --label ouro-fast --model lantern-sigma0-coder

Or in-process with the Ouro LoRA (needs .venv-train):
    .venv-train/Scripts/python scripts/eval_coding.py --engine loop --label ouro-loop

Outputs:
    data/eval/runs/<label>-<ts>.jsonl       per-prompt detail (reconciled schema)
    data/eval/leaderboard.jsonl             summary row with benchmark="coding"

The leaderboard row schema is reconciled with eval_keystone.py and eval_humaneval_ouro.py
via a shared "benchmark" key so cross-benchmark summaries work (#776).
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_ledger import append_leaderboard, checkpoint_id  # noqa: E402  (#2108)

GOLDEN_PATH = os.path.join(ROOT, "data", "eval", "coding-golden.jsonl")


# ── code extraction (same logic as validate_ouro_coding.py) ──────────────────

def extract_code(text, fn_name):
    """Extract the first syntactically valid `def fn_name` block from model output."""
    blocks = re.findall(r"```(?:python)?\s*(.*?)```", text, re.S)
    for candidate in blocks + [text]:
        i = candidate.find(f"def {fn_name}")
        if i < 0:
            continue
        lines = candidate[i:].splitlines()
        body = [lines[0]]
        for ln in lines[1:]:
            if ln.strip() == "" or ln[:1] in (" ", "\t"):
                body.append(ln)
            else:
                break
        code = "\n".join(body).rstrip().replace("\t", "    ")
        try:
            compile(code, "<extracted>", "exec")
            return code
        except SyntaxError:
            continue
    return text


def run_checks(code, checks):
    """Execute extracted code and run each assertion. Returns (passed, total, errors)."""
    ns = {}
    try:
        exec(code, ns)  # noqa: S102
    except Exception as exc:
        return 0, len(checks), [f"exec: {exc}"]
    passed, errors = 0, []
    for expr, want in checks:
        try:
            got = eval(expr, ns)  # noqa: S307
            if got == want:
                passed += 1
            else:
                errors.append(f"{expr}: got {got!r}, want {want!r}")
        except Exception as exc:
            errors.append(f"{expr}: {exc}")
    return passed, len(checks), errors


# ── backends ─────────────────────────────────────────────────────────────────

def ask_ollama(base, model, prompt, max_tokens, timeout):
    payload = json.dumps({
        "model": model, "stream": False,
        "messages": [{"role": "user", "content": prompt}],
        "options": {"num_predict": max_tokens, "top_p": 0.95, "repeat_penalty": 1.1},
    }).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/api/chat", data=payload,
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read())
    dt = time.time() - t0
    text = (body.get("message") or {}).get("content") or body.get("response") or ""
    return text.strip(), dt


def make_loop_ask(base_model, adapter, max_tokens):
    sys.path.insert(0, os.path.join(ROOT, "src"))
    from sigma0.loop_lm import Sigma0LoopLM  # type: ignore[import]
    m = Sigma0LoopLM.load(base_model, adapter=adapter)

    def ask(prompt):
        t0 = time.time()
        out = m.generate(prompt, q=0.5, max_new_tokens=max_tokens, mode="qexit")
        return out["text"].strip(), time.time() - t0
    return ask


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Executable coding benchmark (#776)")
    ap.add_argument("--label", default="ouro-coding", help="Run label for leaderboard")
    ap.add_argument("--model", default="ouro:latest", help="Ollama model tag")
    ap.add_argument("--base", default="http://127.0.0.1:11434", help="Ollama base URL")
    ap.add_argument("--max-tokens", type=int, default=512, help="Max tokens per completion")
    ap.add_argument("--timeout", type=float, default=120, help="Per-prompt timeout (s)")
    ap.add_argument("--ts", default=str(int(time.time())), help="Run timestamp")
    ap.add_argument("--engine", choices=["http", "loop"], default="http",
                    help="http=Ollama API (default); loop=in-process Sigma0LoopLM")
    ap.add_argument("--base-model", default="ByteDance/Ouro-1.4B", help="Loop engine HF base")
    ap.add_argument("--adapter", default=os.environ.get("OURO_ADAPTER"), help="Loop engine LoRA")
    a = ap.parse_args()

    tasks = [json.loads(l) for l in open(GOLDEN_PATH, encoding="utf-8") if l.strip()]

    if a.engine == "loop":
        print(f"Loading {a.base_model} + adapter={a.adapter} ...", flush=True)
        _ask = make_loop_ask(a.base_model, a.adapter, a.max_tokens)
    else:
        _ask = None

    detail = []
    total_pass, total_checks = 0, 0
    total_dt = 0.0
    correct_bytes, correct_words = 0, 0
    n_correct_tasks = 0

    print(f"{'#':>3}  {'task':<18} {'p/t':<5} {'lat':>6}s  notes", flush=True)
    for task in tasks:
        try:
            if _ask is not None:
                reply, dt = _ask(task["prompt"])
            else:
                reply, dt = ask_ollama(a.base, a.model, task["prompt"], a.max_tokens, a.timeout)
        except Exception as exc:
            reply, dt = f"[error: {exc}]", 0.0

        code = extract_code(reply, task["fn"])
        passed, total, errors = run_checks(code, task["checks"])
        total_dt += dt
        total_pass += passed
        total_checks += total

        task_ok = passed == total
        if task_ok:
            n_correct_tasks += 1
            correct_bytes += len(reply.encode("utf-8"))
            correct_words += len(reply.split())

        d = {
            "id": task["id"], "name": task["name"], "fn": task["fn"],
            "ok": task_ok, "passed": passed, "total": total,
            "latency_s": round(dt, 2),
            "reply_bytes": len(reply.encode("utf-8")),
            "reply_words": len(reply.split()),
            "errors": errors[:3],
        }
        detail.append(d)
        flag = "OK " if task_ok else f"{passed}/{total}"
        notes = "; ".join(errors[:2]) if errors else ""
        print(f"{task['id']:>3}  {task['name']:<18} {flag:<5} {dt:>6.1f}  {notes[:60]}", flush=True)

    n = len(tasks)
    pass_at_1 = round(n_correct_tasks / n, 3) if n else 0.0
    assertion_rate = round(total_pass / total_checks, 3) if total_checks else 0.0
    avg_lat = round(total_dt / n, 2) if n else 0.0

    summary = {
        # reconciled schema: shared fields across all benchmarks (#776)
        "benchmark": "coding",
        "ts": a.ts, "label": a.label, "model": a.model, "engine": a.engine,
        "n": n,
        # coding-specific
        "pass@1": pass_at_1,
        "assertion_rate": assertion_rate,
        "n_correct": n_correct_tasks,
        "avg_latency_s": avg_lat,
        # verbosity — lower is more concise
        "bytes_per_correct": round(correct_bytes / n_correct_tasks) if n_correct_tasks else None,
        "words_per_correct": round(correct_words / n_correct_tasks) if n_correct_tasks else None,
    }
    if a.engine == "loop":
        # Loop mode ignores --model (an Ollama tag) and loads --base-model/--adapter
        # in-process — stamp what was actually loaded, not the box's OURO_* env.
        summary["served_checkpoint"] = checkpoint_id(a.base_model, a.adapter)

    os.makedirs(os.path.join(ROOT, "data", "eval", "runs"), exist_ok=True)
    runs_path = os.path.join(ROOT, "data", "eval", "runs", f"{a.label}-{a.ts}.jsonl")
    with open(runs_path, "w", encoding="utf-8") as f:
        for d in detail:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")

    append_leaderboard(summary)  # stamps git_sha/served_checkpoint/campaign_id (#2108)

    print(f"\n{a.label}: pass@1={pass_at_1*100:.0f}%  assertion_rate={assertion_rate*100:.0f}%"
          f"  avg_latency={avg_lat}s  (n={n}, {n_correct_tasks} tasks fully correct)", flush=True)
    if summary["bytes_per_correct"] is not None:
        print(f"  verbosity: {summary['bytes_per_correct']} bytes/correct  "
              f"{summary['words_per_correct']} words/correct", flush=True)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
