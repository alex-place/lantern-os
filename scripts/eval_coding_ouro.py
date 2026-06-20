"""
Execution-grounded coding benchmark for the Σ₀ Ouro Coder (#776).

Grades a model on REAL coding tasks by EXECUTING the generated code against
assertions — not substring matching. This is the standing, falsifiable coding
metric epic #774 calls for: until coding is graded by execution and persisted,
every "quality" upgrade is unfalsifiable.

It generalizes the 3-hardcoded-task ``scripts/validate_ouro_coding.py`` to any
golden file, runs the same dual backends as ``eval_keystone.py`` (http Ollama
API or in-process Sigma0LoopLM), and adds a VERBOSITY metric (bytes/words per
correct solution) so "concise AND correct" is measurable, not just pass@1.

Golden files live in data/eval/ with schema {id,name,fn,prompt,checks}, where
``checks`` is a list of ``[expr, expected]`` pairs evaluated after the function
is defined:
    coding-golden.jsonl   25 basic exec-and-assert tasks (default)
    mbpp-basic.jsonl      MBPP-style basic Python problems (#776's missing MBPP)

    python scripts/eval_coding_ouro.py --label ouro-coding
    python scripts/eval_coding_ouro.py --golden mbpp --label ouro-mbpp
    python scripts/eval_coding_ouro.py --engine loop --mode converge --label ouro-loop
    python scripts/eval_coding_ouro.py --self-test     # offline harness check, no model

Outputs (schema reconciled with eval_keystone / eval_humaneval per #776):
    data/eval/runs/<label>-<ts>.jsonl   per-task detail
    data/eval/leaderboard.jsonl         summary row {benchmark:"coding-exec", pass@1, verbosity...}

Safety: generated code is untrusted, so each candidate runs in a SUBPROCESS with
a timeout (the same isolation contract as eval_humaneval_ouro.py), never in this
process.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GOLDEN_DIR = os.path.join(ROOT, "data", "eval")
GOLDEN_ALIASES = {
    "coding": "coding-golden.jsonl",
    "mbpp": "mbpp-basic.jsonl",
}


# ── pure scoring helpers (stdlib only; unit-tested offline in tests/) ─────────
def extract_code(text, fn):
    """Isolate the ``def {fn}`` block from a model reply, fence- and prose-agnostic.

    The model rambles markdown/prose around (and often after) the code, so we
    take fenced ```python blocks first, then the raw text, and accept the first
    candidate whose ``def {fn}`` block actually COMPILES. Falls back to the whole
    reply so the caller's compile check reports the failure honestly.
    """
    blocks = re.findall(r"```(?:python)?\s*(.*?)```", text, re.S)
    for c in blocks + [text]:               # fenced blocks first, then raw text
        i = c.find(f"def {fn}")
        if i < 0:
            continue
        lines = c[i:].splitlines()
        body = [lines[0]]                    # the def line
        for ln in lines[1:]:                # + blank or indented lines = the body
            if ln.strip() == "" or ln[:1] in (" ", "\t"):
                body.append(ln)
            else:
                break                        # first column-0 prose line ends the function
        code = "\n".join(body).rstrip()
        try:
            compile(code, "<extracted>", "exec")
            return code                      # syntactically valid Python
        except SyntaxError:
            continue
    return text                              # give up; run_checks reports it as a parse failure


# The in-subprocess assertion runner. ``__CHECKS_LITERAL__`` is replaced with a
# Python string literal holding the JSON-encoded checks; it is loaded, each
# (expr, want) is eval'd against the just-defined function, and a single
# __RESULT__<json> line is printed for the parent to parse.
_CHECK_HARNESS = (
    "import json as _json\n"
    "_checks = _json.loads(__CHECKS_LITERAL__)\n"
    "_passed = 0\n"
    "_fails = []\n"
    "for _expr, _want in _checks:\n"
    "    try:\n"
    "        _got = eval(_expr)\n"
    "        if _got == _want:\n"
    "            _passed += 1\n"
    "        else:\n"
    "            _fails.append({'expr': _expr, 'want': _want, 'got': repr(_got)})\n"
    "    except Exception as _e:\n"
    "        _fails.append({'expr': _expr, 'error': str(_e)})\n"
    "print('__RESULT__' + _json.dumps({'passed': _passed, 'total': len(_checks), 'fails': _fails}))\n"
)


def run_checks(code, fn, checks, timeout=8):
    """Exec the extracted code in a subprocess sandbox and run every assertion.

    Returns {parsed, passed, total, error, fails}. ``parsed`` is False (and the
    subprocess is never spawned) when the candidate does not compile — that is
    the dominant small-model failure mode and we want it counted, not crashed on.
    """
    res = {"parsed": False, "passed": 0, "total": len(checks), "error": None, "fails": []}
    try:
        compile(code, "<candidate>", "exec")    # safe: compiling does not execute
    except SyntaxError as e:
        res["error"] = f"compile: {e}"
        return res
    res["parsed"] = True

    harness = _CHECK_HARNESS.replace("__CHECKS_LITERAL__", json.dumps(json.dumps(checks)))
    program = code + "\n\n" + harness
    path = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(program)
            path = f.name
        proc = subprocess.run([sys.executable, "-I", path], capture_output=True,
                              timeout=timeout, text=True, encoding="utf-8", errors="replace")
        out = proc.stdout or ""
        marker = out.rfind("__RESULT__")        # model code may print; take the LAST marker
        if marker == -1:
            err = (proc.stderr or "").strip().splitlines()
            res["error"] = ("runtime: " + err[-1][:160]) if err else "no result emitted"
            return res
        parsed = json.loads(out[marker + len("__RESULT__"):].splitlines()[0])
        res["passed"] = parsed["passed"]
        res["fails"] = parsed["fails"]
    except subprocess.TimeoutExpired:
        res["error"] = "timeout"
    except Exception as e:
        res["error"] = f"runner: {e}"
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass
    return res


def verbosity(replies, n_correct):
    """Bytes/words spent per correct solution (#776). Lower is better — it
    rewards models that are both correct AND concise, the verbosity column the
    keyword scorer can't see. ``*_per_correct`` is None when nothing passed."""
    n = len(replies)
    total_bytes = sum(len(r.encode("utf-8")) for r in replies)
    total_words = sum(len(r.split()) for r in replies)
    return {
        "total_reply_bytes": total_bytes,
        "total_reply_words": total_words,
        "avg_reply_bytes": round(total_bytes / n, 1) if n else 0.0,
        "avg_reply_words": round(total_words / n, 1) if n else 0.0,
        "bytes_per_correct": round(total_bytes / n_correct, 1) if n_correct else None,
        "words_per_correct": round(total_words / n_correct, 1) if n_correct else None,
    }


def summarize(detail, replies, total_dt, *, label, ts, golden, engine, mode,
              depths, contractions):
    """Build the reconciled leaderboard row (benchmark="coding-exec"). Pure, so the
    full row shape is unit-testable without loading a model."""
    n = len(detail)
    n_pass = sum(1 for d in detail if d["passed"] == d["total"] and d["total"] > 0)
    assertions_passed = sum(d["passed"] for d in detail)
    assertions_total = sum(d["total"] for d in detail)
    approx_tokens = sum(max(1, len(r.split())) for r in replies)
    row = {
        # reconciled schema — "benchmark" key shared across all eval scripts (#776)
        "benchmark": "coding-exec",
        "ts": ts, "label": label, "golden": golden, "engine": engine,
        "mode": (mode if engine == "loop" else None),
        "n": n,
        "pass@1": round(n_pass / n, 3) if n else 0.0,
        "accuracy": round(n_pass / n, 3) if n else 0.0,    # alias for cross-benchmark summary
        "passed": n_pass,
        "assertion_pass_rate": round(assertions_passed / assertions_total, 3) if assertions_total else 0.0,
        "assertions_passed": assertions_passed,
        "assertions_total": assertions_total,
        "avg_latency_s": round(total_dt / n, 2) if n else 0.0,
        "tok_per_s": round(approx_tokens / total_dt, 1) if total_dt else 0.0,
        # E1/E2 (loop engine only): realized latent depth + contraction
        "mean_depth": round(sum(depths) / len(depths), 2) if depths else None,
        "mean_contraction": round(sum(contractions) / len(contractions), 4) if contractions else None,
    }
    row.update(verbosity(replies, n_pass))
    return row


# ── model backends (heavy imports stay inside; http path is stdlib-only) ──────
def ask_http(base, model, prompt, num_predict, timeout):
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
    return text.strip(), dt, None


def make_loop_engine(base_model, adapter, mode, q, eps, num_predict):
    """In-process Sigma0LoopLM backend (CUDA + Ouro weights). Returns an ask-style
    callable that also reports per-token realized depth / contraction."""
    sys.path.insert(0, os.path.join(ROOT, "src"))
    from sigma0.loop_lm import Sigma0LoopLM
    m = Sigma0LoopLM.load(base_model, adapter=adapter)

    def ask_loop(prompt):
        t0 = time.time()
        out = m.generate(prompt, q=q, eps=eps, mode=mode, max_new_tokens=num_predict)
        return out["text"].strip(), time.time() - t0, out

    return ask_loop


# ── offline self-test (no model): proves the scoring harness end-to-end ───────
def self_test():
    ok = True

    def expect(cond, label):
        nonlocal ok
        print(("  ok  " if cond else "  FAIL ") + label, flush=True)
        ok = ok and cond

    good = "Here is the code:\n```python\ndef add(a, b):\n    return a + b\n```\nDone."
    code = extract_code(good, "add")
    expect("def add" in code and "Here is" not in code, "extract_code strips prose/fences")
    r = run_checks(code, "add", [["add(2, 3)", 5], ["add(0, 0)", 0]])
    expect(r["parsed"] and r["passed"] == 2 and r["total"] == 2, "correct code passes all checks")

    buggy = "def add(a, b):\n    return a - b\n"
    r = run_checks(buggy, "add", [["add(2, 3)", 5]])
    expect(r["parsed"] and r["passed"] == 0, "buggy code fails its check")

    broken = extract_code("def add(a, b)\n    return a+b", "add")  # missing colon
    r = run_checks(broken, "add", [["add(1, 1)", 2]])
    expect(not r["parsed"] and r["passed"] == 0, "non-compiling code -> parsed=False")

    v = verbosity(["aaaa", "bb bb"], n_correct=1)
    expect(v["total_reply_bytes"] == 9 and v["total_reply_words"] == 3
           and v["bytes_per_correct"] == 9.0, "verbosity math")
    expect(verbosity(["x"], 0)["bytes_per_correct"] is None, "verbosity guards divide-by-zero")

    detail = [{"passed": 2, "total": 2}, {"passed": 0, "total": 1}]
    row = summarize(detail, ["abc", "de"], 4.0, label="t", ts="0", golden="x",
                    engine="http", mode=None, depths=[], contractions=[])
    expect(row["benchmark"] == "coding-exec" and row["pass@1"] == 0.5
           and row["assertions_passed"] == 2 and row["assertion_pass_rate"] == round(2 / 3, 3),
           "summarize row shape")

    print(("SELF-TEST PASS" if ok else "SELF-TEST FAILED"), flush=True)
    return 0 if ok else 1


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true",
                    help="run the offline scoring-harness check (no model) and exit")
    ap.add_argument("--label", help="backend label for the leaderboard")
    ap.add_argument("--golden", default="coding",
                    help="golden alias (coding|mbpp) or a path to a {id,name,fn,prompt,checks} jsonl")
    ap.add_argument("--base", default="http://127.0.0.1:11434")
    ap.add_argument("--model", default="ouro:latest")
    ap.add_argument("--num-predict", type=int, default=256)
    ap.add_argument("--timeout", type=float, default=180)
    ap.add_argument("--exec-timeout", type=float, default=8, help="per-task subprocess timeout (s)")
    ap.add_argument("--limit", type=int, default=0, help="grade only the first N tasks (0 = all)")
    ap.add_argument("--ts", default=str(int(time.time())), help="run timestamp (override for determinism)")
    ap.add_argument("--engine", choices=["http", "loop"], default="http")
    ap.add_argument("--mode", choices=["qexit", "converge"], default="qexit")
    ap.add_argument("--base-model", default="ByteDance/Ouro-1.4B")
    ap.add_argument("--adapter", default=os.environ.get("OURO_ADAPTER"))
    ap.add_argument("--q", type=float, default=0.5)
    ap.add_argument("--eps", type=float, default=0.05)
    a = ap.parse_args()

    if a.self_test:
        return self_test()
    if not a.label:
        ap.error("--label is required (unless --self-test)")

    golden_path = a.golden if os.path.sep in a.golden or a.golden.endswith(".jsonl") \
        else os.path.join(GOLDEN_DIR, GOLDEN_ALIASES.get(a.golden, a.golden))
    if not os.path.exists(golden_path):
        ap.error(f"golden file not found: {golden_path}")
    rows = [json.loads(l) for l in open(golden_path, encoding="utf-8") if l.strip()]
    if a.limit:
        rows = rows[:a.limit]

    backend = None
    if a.engine == "loop":
        backend = make_loop_engine(a.base_model, a.adapter, a.mode, a.q, a.eps, a.num_predict)

    detail, replies, total_dt = [], [], 0.0
    depths, contractions = [], []
    print(f"{'task':<18} {'pass':<6} {'lat':>6}  note", flush=True)
    for r in rows:
        meta = None
        try:
            if backend is not None:
                reply, dt, meta = backend(r["prompt"])
            else:
                reply, dt, meta = ask_http(a.base, a.model, r["prompt"], a.num_predict, a.timeout)
        except Exception as e:
            reply, dt = f"[error: {e}]", 0.0
        code = extract_code(reply, r["fn"])
        chk = run_checks(code, r["fn"], [tuple(c) for c in r["checks"]], timeout=a.exec_timeout)
        replies.append(reply)
        total_dt += dt
        d = {"id": r["id"], "name": r["name"], "fn": r["fn"],
             "passed": chk["passed"], "total": chk["total"], "parsed": chk["parsed"],
             "error": chk["error"], "fails": chk["fails"],
             "latency_s": round(dt, 2), "reply": reply}
        if meta is not None:
            d["mean_depth"] = meta.get("mean_depth")
            if meta.get("mean_depth") is not None:
                depths.append(meta["mean_depth"])
            if meta.get("mean_contraction") is not None:
                d["mean_contraction"] = meta["mean_contraction"]
                contractions.append(meta["mean_contraction"])
        detail.append(d)
        full = chk["passed"] == chk["total"] and chk["total"] > 0
        note = chk["error"] or (f"{chk['passed']}/{chk['total']} assertions")
        print(f"{r['name']:<18} {'OK ' if full else 'x  ':<6} {dt:>5.1f}s  {note}", flush=True)

    summary = summarize(detail, replies, total_dt, label=a.label, ts=a.ts,
                        golden=os.path.basename(golden_path), engine=a.engine,
                        mode=a.mode, depths=depths, contractions=contractions)

    os.makedirs(os.path.join(GOLDEN_DIR, "runs"), exist_ok=True)
    with open(os.path.join(GOLDEN_DIR, "runs", f"{a.label}-{a.ts}.jsonl"), "w", encoding="utf-8") as f:
        for d in detail:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    with open(os.path.join(GOLDEN_DIR, "leaderboard.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")

    print(f"\n{a.label}: pass@1={summary['pass@1'] * 100:.0f}%  "
          f"assertions={summary['assertion_pass_rate'] * 100:.0f}%  "
          f"avg_latency={summary['avg_latency_s']}s  "
          f"bytes/correct={summary['bytes_per_correct']}  (n={summary['n']})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
