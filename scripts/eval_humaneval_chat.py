"""
Real HumanEval pass@1 for the KEYSTONE CHAT itself — the full product pipeline,
not the raw model.

`scripts/eval_humaneval_ouro.py` measures the raw Ouro model via in-process
`generate()`. This measures what the user actually talks to: it drives
POST /api/dream/chat/stream exactly like the browser does (provider routing,
the local-model adapter, loop-reasoner, system prompt, streaming, post-process),
extracts the function from the chat reply, and runs the canonical HumanEval unit
tests in the SAME sandbox. Code extraction + execution are imported from
eval_humaneval_ouro (one extractor, one sandbox — no duplication).

Provider-parametric — one harness measures the whole comparison:
  --provider ollama     local Σ₀ coder via the chat's local-first routing + the
                        local-model adapter (lib/local-model-registry.js). Choose
                        Ouro vs Qwen on the SERVER (OLLAMA_MODEL / LOCAL_CAPABILITY_FIRST).
  --provider anthropic  cloud Claude through the SAME chat path → local↔cloud
                        parity on one execution-grounded benchmark.
  --provider ""         auto routing (whatever the chat picks for a coding turn).

The summary records what ACTUALLY served (done.source / done.model histograms),
so a silent local→cloud fallback is visible, never hidden behind the headline %.

    # server running (npm start --prefix apps/lantern-garage) + a local model
    # served (scripts/ouro_serve.py) for --provider ollama
    python scripts/eval_humaneval_chat.py --provider ollama --limit 10
    python scripts/eval_humaneval_chat.py --provider anthropic --full
    python scripts/eval_humaneval_chat.py --selftest        # offline: prove the scoring path

Outputs:
    data/eval/humaneval/<label>-<ts>.jsonl   per-problem detail (+ served source/model)
    data/eval/leaderboard.jsonl              one row {benchmark:"humaneval-chat", pass@1, ...}
"""
import argparse, http.client, json, os, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# Reuse the canonical extractor + sandbox (importing does NOT pull torch/datasets;
# those live inside eval_humaneval_ouro.main(), not at module top level).
from eval_humaneval_ouro import make_candidate, run_test  # noqa: E402

# Strict wrapper: bias the chat to a coding turn (→ coder system prompt + local-first
# routing) and to emit ONLY a fenced function that make_candidate can lift cleanly.
INSTRUCTION = (
    "Complete the following Python function. Respond with ONLY the complete function "
    "implementation inside a single ```python code block — no explanation, no prose, "
    "no test code.\n\n"
)


def _parse_sse(raw):
    """Parse the dream-chat SSE stream → (reply_text, done_meta).

    The live wire format is `data: {"type":"token","text":...}` ... `data:
    {"type":"done","source":...,"model":...}` (no `event:` lines). We also accept
    the alternate `event: token` / `{"token":...}` shape some handlers emit, so the
    harness is robust to either sender."""
    tokens, done = [], {}
    for block in raw.split("\n\n"):
        ev, datas = None, []
        for line in block.splitlines():
            line = line.rstrip("\r")
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                datas.append(line[5:].strip())
        if not datas:
            continue
        try:
            obj = json.loads("".join(datas))
        except Exception:
            continue
        otype = obj.get("type") or ev
        if otype == "token":
            tokens.append(str(obj.get("text", obj.get("token", ""))))
        elif otype == "done" or obj.get("done"):
            done = obj
    text = "".join(tokens)
    if not text and done.get("cleanText"):
        text = str(done["cleanText"])
    return text, done


def chat_complete(host, port, message, provider, agent, mcp, route_intent, timeout):
    """POST one turn to the Keystone chat SSE endpoint; return (reply_text, done_meta).

    Reads the whole SSE response (the handler closes the stream after `done`).
    Raises ConnectionError if unreachable."""
    body = json.dumps({
        "message": message,
        "provider": provider or "",
        "agent": agent or "",
        "mcp": bool(mcp),
        "routeIntent": route_intent or "",   # "coding_change" forces the local-coder route
        "surface": "dream-chat",
        "user": "evalbot",
    }).encode("utf-8")  # json.dumps → no BOM (a BOM would make the server's JSON.parse throw)
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("POST", "/api/dream/chat/stream", body=body,
                     headers={"Content-Type": "application/json", "Accept": "text/event-stream"})
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8", "replace")
    except (ConnectionRefusedError, OSError) as e:
        raise ConnectionError(f"chat endpoint {host}:{port} unreachable: {e}")
    finally:
        conn.close()
    return _parse_sse(raw)


def _bump(hist, key):
    key = str(key or "?")
    hist[key] = hist.get(key, 0) + 1


def run_eval(a):
    from datasets import load_dataset
    print("Loading HumanEval (openai_humaneval) ...", flush=True)
    ds = load_dataset("openai_humaneval", split="test")
    n = len(ds) if a.full else min(a.limit, len(ds))

    detail, n_ok, t0 = [], 0, time.time()
    sources, models, note_counts = {}, {}, {}
    print(f"\nDriving Keystone chat @ {a.host}:{a.port}  provider={a.provider or 'auto'}\n", flush=True)
    print(f"{'task':<14} {'pass':<5} {'served':<18} {'note'}", flush=True)
    for i in range(n):
        ex = ds[i]
        try:
            text, done = chat_complete(a.host, a.port, INSTRUCTION + ex["prompt"],
                                       a.provider, a.agent, a.mcp, a.route_intent, a.timeout)
        except ConnectionError as e:
            print(f"\nFATAL: {e}\nStart the server and (for --provider ollama) the local model, "
                  f"then retry. No leaderboard row written.", flush=True)
            sys.exit(2)
        served = f"{done.get('source', '?')}/{done.get('model', '?')}"
        _bump(sources, done.get("source"))
        _bump(models, done.get("model"))
        cand = make_candidate(text, ex["entry_point"], ex["prompt"])
        ok, note = run_test(cand, ex["test"], ex["entry_point"], timeout=a.exec_timeout)
        n_ok += int(ok)
        if not ok:
            bucket = ("no-parse" if note == "no-parse" else "timeout" if note == "timeout"
                      else "assert" if note.startswith("assert")
                      else "exec-error" if note.startswith(("Traceback", "runner")) else "other")
            note_counts[bucket] = note_counts.get(bucket, 0) + 1
        detail.append({"task_id": ex["task_id"], "entry_point": ex["entry_point"], "ok": ok,
                       "note": note, "served_source": done.get("source"),
                       "served_model": done.get("model"), "reply": text[:600]})
        print(f"{ex['task_id']:<14} {'OK ' if ok else 'x  '}  {served:<18} {note}", flush=True)

    dt = time.time() - t0
    summary = {
        "benchmark": "humaneval-chat",          # shared leaderboard schema (#776)
        "ts": a.ts, "label": a.label, "engine": "keystone-chat",
        "surface": "dream-chat", "provider": a.provider or "auto",
        "served_sources": sources, "served_models": models,  # honesty: what actually answered
        "n": n, "subset": (not a.full),
        "pass@1": round(n_ok / n, 3) if n else 0.0,
        "accuracy": round(n_ok / n, 3) if n else 0.0,
        "passed": n_ok, "wall_s": round(dt, 1),
        "sec_per_problem": round(dt / n, 1) if n else 0.0,
        "failure_breakdown": note_counts,
    }
    os.makedirs(os.path.join(ROOT, "data", "eval", "humaneval"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "eval", "humaneval", f"{a.label}-{a.ts}.jsonl"), "w", encoding="utf-8") as f:
        for d in detail:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    with open(os.path.join(ROOT, "data", "eval", "leaderboard.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    tag = "HumanEval-chat" + ("" if a.full else f"[first {n}]")
    print(f"\nVERDICT {tag} pass@1 = {summary['pass@1']*100:.1f}%  ({n_ok}/{n})  "
          f"{summary['sec_per_problem']}s/problem  served={sources}", flush=True)
    print(json.dumps(summary))


def selftest():
    """Offline proof that extraction + scoring work — no server, no model, no dataset.
    Feeds known-good / known-bad chat replies through the real make_candidate + run_test."""
    prompt = ('def add(a, b):\n    """Return the sum of a and b."""\n')
    test = "def check(candidate):\n    assert candidate(2, 3) == 5\n    assert candidate(-1, 1) == 0\n"
    good = "Here you go:\n```python\ndef add(a, b):\n    return a + b\n```\n"
    bad = "```python\ndef add(a, b):\n    return a - b\n```"
    fails = 0

    cand = make_candidate(good, "add", prompt)
    ok, note = run_test(cand, test, "add")
    print(f"[selftest] fenced correct reply -> pass={ok} ({note})")
    fails += 0 if ok else 1

    cand = make_candidate(bad, "add", prompt)
    ok, note = run_test(cand, test, "add")
    print(f"[selftest] fenced wrong reply   -> pass={ok} (want False)")
    fails += 1 if ok else 0

    # SSE parse: the REAL live wire format (data: {"type":"token","text":...}).
    raw = ('data: {"type":"route","agent":"keystone"}\n\n'
           'data: {"type":"token","text":"```python\\ndef add(a, b):\\n    return a + b\\n```"}\n\n'
           'data: {"type":"done","source":"ollama","model":"ouro:latest"}\n\n')
    ptext, done = _parse_sse(raw)
    parsed_ok = "def add" in ptext and done.get("model") == "ouro:latest"
    print(f"[selftest] SSE token/done parse -> {parsed_ok}")
    fails += 0 if parsed_ok else 1

    print("SELFTEST:", "PASS" if fails == 0 else f"FAIL ({fails})")
    sys.exit(0 if fails == 0 else 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="keystone-chat-humaneval")
    ap.add_argument("--provider", default="ollama",
                    help="chat provider to pin: ollama|anthropic|openai|... or '' for auto")
    ap.add_argument("--agent", default="keystone")
    ap.add_argument("--route-intent", default="coding_change", dest="route_intent",
                    help="force the chat's route intent (coding_change drives the local-coder path)")
    ap.add_argument("--mcp", action="store_true",
                    help="set the keystone-debug flag (bypass KB short-circuit + Three Doors)")
    ap.add_argument("--host", default=os.environ.get("KEYSTONE_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("KEYSTONE_PORT", "4177")))
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--full", action="store_true", help="run all 164")
    ap.add_argument("--timeout", type=int, default=180, help="per-request chat timeout (s)")
    ap.add_argument("--exec-timeout", type=int, default=12, help="per-test sandbox timeout (s)")
    ap.add_argument("--ts", default=str(int(time.time())))
    ap.add_argument("--selftest", action="store_true", help="offline scoring-path proof; no server")
    a = ap.parse_args()
    if a.selftest:
        selftest()
    run_eval(a)


if __name__ == "__main__":
    main()
