#!/usr/bin/env python3
"""
Wrapped-vs-raw benchmark for the Keystone coding-backend control plane (#2173).

Same coding tasks, same local model (Qwen2.5-Coder via Ollama), two paths:

  RAW      : generate code from the model, grade it. No gate, no receipt.
  WRAPPED  : run it through the control plane — propose -> HOLD for approval ->
             emit a receipt -> approve -> apply -> grade. (scripts/_cb_wrapped_run.js)

The point is NOT that wrapping makes the model smarter — it is the same model. The
point is that the control plane preserves edit-accuracy while adding accountability
(every task HELD before applying + a receipt), which no raw coding agent produces.

Reuses eval_coding's golden tasks + grader (extract_code / run_checks) so the number is
apples-to-apples with the leaderboard. Writes data/eval/coding-backend-ab-report.json.

    python scripts/eval_coding_backend_ab.py            # all 25 golden tasks
    AB_LIMIT=6 python scripts/eval_coding_backend_ab.py # quick subset
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eval_coding as ec  # noqa: E402  (GOLDEN_PATH, ask_ollama, extract_code, run_checks)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.environ.get("AB_MODEL", "qwen2.5-coder:latest")
BASE = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
LIMIT = int(os.environ.get("AB_LIMIT", "0"))  # 0 = all
REPORT = os.path.join(ROOT, "data", "eval", "coding-backend-ab-report.json")


def grade(reply_or_code, task):
    code = ec.extract_code(reply_or_code, task["fn"])
    passed, total, _ = ec.run_checks(code, task["checks"])
    return passed == total


def wrapped_run(prompt):
    """Run one task through the node control plane; return the parsed result dict."""
    p = subprocess.run(
        ["node", "scripts/_cb_wrapped_run.js", prompt, "ollama"],
        cwd=ROOT, capture_output=True, text=True, timeout=180,
    )
    line = ""
    for ln in reversed((p.stdout or "").splitlines()):
        if ln.strip().startswith("{"):
            line = ln
            break
    return json.loads(line) if line else {"error": p.stderr[-300:] or "no output", "code": ""}


def main():
    tasks = [json.loads(l) for l in open(ec.GOLDEN_PATH, encoding="utf-8") if l.strip()]
    if LIMIT:
        tasks = tasks[:LIMIT]
    n = len(tasks)
    raw_pass = wrapped_pass = held = receipted = engine_ok = 0
    per_task = []
    print(f"{'#':>3}  {'task':<18} {'raw':>4} {'wrapped':>8}  {'held':>4} {'receipt':>7}", flush=True)
    for i, t in enumerate(tasks, 1):
        reply, _ = ec.ask_ollama(BASE, MODEL, t["prompt"], 512, 120)
        r_ok = grade(reply, t)
        w = wrapped_run(t["prompt"])
        w_ok = grade(w.get("code", ""), t)
        w_held = bool(w.get("held") and w.get("heldOnDisk"))
        w_rcpt = bool(w.get("receiptId"))
        w_eng = "qwen" in str(w.get("localEngine") or w.get("model") or "").lower()
        raw_pass += r_ok; wrapped_pass += w_ok
        held += w_held; receipted += w_rcpt; engine_ok += w_eng
        per_task.append({"id": t["id"], "name": t["name"], "raw": r_ok, "wrapped": w_ok,
                         "held": w_held, "receipt": w_rcpt, "engine": w.get("localEngine")})
        print(f"{t['id']:>3}  {t['name']:<18} {('OK' if r_ok else 'x'):>4} {('OK' if w_ok else 'x'):>8}"
              f"  {('y' if w_held else 'n'):>4} {('y' if w_rcpt else 'n'):>7}", flush=True)

    report = {
        "benchmark": "coding-backend-ab", "ts": str(int(time.time())),
        "model": MODEL, "n": n,
        "raw_pass_at_1": round(raw_pass / n, 3) if n else None,
        "wrapped_pass_at_1": round(wrapped_pass / n, 3) if n else None,
        "wrapped_held_coverage": round(held / n, 3) if n else None,
        "wrapped_receipt_coverage": round(receipted / n, 3) if n else None,
        "wrapped_engine_is_qwen": round(engine_ok / n, 3) if n else None,
        "verdict": ("wrapped preserves accuracy + adds accountability"
                    if (wrapped_pass >= raw_pass - 1 and held == n and receipted == n)
                    else "review: wrapped diverged from raw or missed a gate/receipt"),
        "per_task": per_task,
    }
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    json.dump(report, open(REPORT, "w", encoding="utf-8"), indent=2)
    print("\n" + json.dumps({k: report[k] for k in (
        "n", "raw_pass_at_1", "wrapped_pass_at_1", "wrapped_held_coverage",
        "wrapped_receipt_coverage", "wrapped_engine_is_qwen", "verdict")}, indent=2))
    print(f"report -> {os.path.relpath(REPORT, ROOT)}")


if __name__ == "__main__":
    main()
