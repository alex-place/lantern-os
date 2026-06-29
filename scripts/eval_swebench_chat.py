"""SWE-bench (single-shot) for the KEYSTONE CHAT itself — the full product pipeline.

Mirrors scripts/eval_humaneval_chat.py, but for SWE-bench instead of HumanEval. It drives
POST /api/dream/chat/stream exactly like the browser (provider routing, local-model adapter,
loop-reasoner, streaming), feeds each SWE-bench instance's problem (+ retrieved file context
when the dataset provides it), extracts a unified diff from the reply, and writes predictions
in the OFFICIAL swebench format.

Grading is execution-graded and DELEGATED to the official `swebench` harness (Docker or Modal).
This script never reports a resolved% it didn't measure: predictions are produced unconditionally;
`--grade` shells out to the real harness and surfaces the measured resolved%, otherwise it prints
the exact grade command. The summary records what ACTUALLY served (source/model histograms) so a
silent local→cloud fallback is visible.

Single-shot retrieval setting:
  - The BM25 retrieval datasets (e.g. princeton-nlp/SWE-bench_Lite_bm25_13K) ship a ready-made
    `text` prompt (retrieved files + problem). Pass that via --dataset for a real single-shot
    score. NOTE it is ~13K tokens — it exceeds an 8k-context local model (Ouro) and will
    truncate; use a 32k model (Qwen2.5-Coder, LOCAL_CAPABILITY_FIRST=1) for a fair run.
  - The plain dataset (princeton-nlp/SWE-bench_Lite) has NO `text` field → this harness falls
    back to a problem-statement-only prompt and WARNS, because with no file context the model
    is guessing blind and will score ~0. That's honest, not a bug.

    # server running + a local model served; predict + grade in one command (needs Docker):
    python scripts/eval_swebench_chat.py --provider ollama --limit 10 \
        --dataset princeton-nlp/SWE-bench_Lite_bm25_13K --grade
    # predict only (no Docker) → grade later:
    python scripts/eval_swebench_chat.py --provider ollama --limit 10
    python scripts/eval_swebench_chat.py --selftest    # offline: prove patch extraction

Outputs:
    data/eval/swebench/<label>-<ts>.jsonl         swebench-format predictions (feed to grader)
    data/eval/swebench/<label>-<ts>.detail.jsonl  per-instance served source/model + patch size
    data/eval/leaderboard.jsonl                   one row with the MEASURED resolved% (--grade only)
"""
import argparse, http.client, json, os, re, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# Reuse the SSE chat driver — one transport, no duplication (importing is light: no torch).
from eval_humaneval_chat import chat_complete  # noqa: E402

PATCH_INSTRUCTION = (
    "\n\nRespond with ONLY a single unified diff (a git patch) that resolves the issue, inside "
    "one ```diff code block. Use valid `diff --git a/<path> b/<path>` headers and `@@` hunks. "
    "No explanation, no prose, no test code."
)

# A fenced ```diff / ```patch / ``` block, or a raw `diff --git` region.
_FENCE = re.compile(r"```(?:diff|patch|[a-zA-Z]*)?\s*\n(.*?)```", re.DOTALL)

# Direct-mode system prompt: the Keystone chat is an AGENT (tool-calling + persona), so a
# single-shot SWE prompt makes it web_search / write repro scripts instead of a patch. --direct
# bypasses that and tests the MODEL: a bare ollama completion that must emit ONLY a patch.
RAW_PATCH_SYSTEM = (
    "You are a code-fixing tool. You are given a software issue and the relevant source files. "
    "Output ONLY a unified diff (a git patch) that resolves the issue, inside one ```diff code "
    "block, with valid `diff --git a/<path> b/<path>` headers and `@@` hunks whose context lines "
    "MATCH the given source exactly. Do NOT call tools, do NOT search, do NOT write reproduction "
    "scripts, do NOT explain. Only the patch."
)


def ollama_chat(model, prompt, num_ctx, timeout, host="127.0.0.1", port=11434):
    """POST one turn straight to ollama /api/chat — no Keystone agent layer. Returns
    (reply_text, done_meta). Raises ConnectionError if unreachable (matches chat_complete)."""
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": RAW_PATCH_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "options": {"num_ctx": num_ctx, "temperature": 0},
    }).encode("utf-8")
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("POST", "/api/chat", body=body, headers={"Content-Type": "application/json"})
        raw = conn.getresponse().read().decode("utf-8", "replace")
    except (ConnectionRefusedError, OSError) as e:
        raise ConnectionError(f"ollama {host}:{port} unreachable: {e}")
    finally:
        conn.close()
    try:
        obj = json.loads(raw)
    except Exception:
        return "", {"source": "ollama-direct", "model": model}
    return str(obj.get("message", {}).get("content", "")), {"source": "ollama-direct", "model": model}


def gold_dataset_name(name):
    """The grader needs the GOLD dataset (test patches + FAIL_TO_PASS), not a derived bm25
    retrieval variant. Strip the retrieval suffix so predictions made against …_bm25_13K are
    graded against the original princeton-nlp/SWE-bench_Lite."""
    for suffix in ("_bm25_13K", "_bm25_27K", "_bm25_40K", "_bm25_50k_8k", "_oracle"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def extract_patch(reply):
    """Lift the best unified-diff candidate from a chat reply → a git-apply-able patch string.

    Prefers a fenced block that actually contains diff markers; falls back to a raw `diff --git`
    region. Returns "" when the reply contains no patch (scored as an empty, unresolved patch)."""
    reply = reply or ""
    for m in _FENCE.finditer(reply):
        block = m.group(1)
        if "diff --git" in block or "\n@@" in block or block.startswith("@@"):
            return block.strip() + "\n"
    idx = reply.find("diff --git")
    if idx != -1:
        return reply[idx:].strip() + "\n"
    return ""


def build_prompt(ex):
    """Single-shot prompt for one instance. Uses the dataset's retrieval `text` when present
    (BM25 variants), else a no-context fallback (problem statement only) + a WARN flag."""
    text = ex.get("text")
    if text:
        return text, True   # ready-made retrieval prompt; it carries its own format instruction
    prompt = (f"Repository: {ex.get('repo','?')} @ {ex.get('base_commit','')}\n\n"
              f"Resolve the following issue by editing the repository's source.\n\n"
              f"{ex.get('problem_statement','')}" + PATCH_INSTRUCTION)
    return prompt, False


def _bump(hist, key):
    key = str(key or "?")
    hist[key] = hist.get(key, 0) + 1


def read_report(run_id):
    """Find + parse the report JSON the official harness writes (`<model>.<run_id>.json` in CWD),
    tolerant of schema drift across swebench versions. Returns (resolved, total) or (None, None)."""
    import glob
    cands = glob.glob(os.path.join(ROOT, f"*{run_id}*.json"))
    if not cands:
        print(f"(no report *{run_id}*.json — see logs/run_evaluation/{run_id}/)")
        return None, None
    path = max(cands, key=os.path.getmtime)
    try:
        rep = json.load(open(path, encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"(couldn't parse report {path}: {e})")
        return None, None
    total = rep.get("total_instances") or rep.get("submitted_instances") or rep.get("total")
    resolved = rep.get("resolved_instances")
    if resolved is None and isinstance(rep.get("resolved_ids"), list):
        resolved = len(rep["resolved_ids"])
    if resolved is None:
        resolved = rep.get("resolved")
    print(f"report -> {os.path.relpath(path, ROOT)}")
    return resolved, total


def grade(a, pred_path):
    """Shell out to the official execution-grader (Docker or Modal). Honest preflight: if the
    backend isn't available, save predictions and tell the user to grade later — never crash."""
    import importlib, shutil, subprocess
    gold = gold_dataset_name(a.dataset)
    run_id = f"keystone-{a.ts}"
    cmd = [sys.executable, "-m", "swebench.harness.run_evaluation",
           "--dataset_name", gold, "--predictions_path", pred_path,
           "--run_id", run_id, "--max_workers", str(a.max_workers)]
    if a.grade_backend == "modal":
        cmd += ["--modal", "true"]

    try:
        importlib.import_module("swebench")
    except Exception:  # noqa: BLE001
        print("swebench not installed — `pip install swebench`. Predictions saved; grade later.")
        return None, None
    if a.grade_backend == "docker" and not shutil.which("docker"):
        print("docker not on PATH — start Docker (or --grade-backend modal). Predictions saved.")
        return None, None

    print("\nGRADING (execution-graded):", " ".join(cmd), flush=True)
    try:
        rc = subprocess.call(cmd, cwd=ROOT)
    except Exception as e:  # noqa: BLE001
        print(f"grader failed to launch: {e}. Predictions saved; grade later.")
        return None, None
    if rc != 0:
        print(f"grader exited rc={rc} — see output above / logs/run_evaluation/{run_id}/")
    return read_report(run_id)


def run_eval(a):
    from datasets import load_dataset
    print(f"Loading {a.dataset} [{a.split}] ...", flush=True)
    ds = load_dataset(a.dataset, split=a.split)
    n = len(ds) if a.full else min(a.limit, len(ds))

    out_dir = os.path.join(ROOT, "data", "eval", "swebench")
    os.makedirs(out_dir, exist_ok=True)
    pred_path = os.path.join(out_dir, f"{a.label}-{a.ts}.jsonl")
    detail_path = os.path.join(out_dir, f"{a.label}-{a.ts}.detail.jsonl")

    sources, models, with_patch, no_ctx = {}, {}, 0, 0
    t0 = time.time()
    print(f"\nDriving Keystone chat @ {a.host}:{a.port}  provider={a.provider or 'auto'}  "
          f"model={a.label}\n", flush=True)
    print(f"{'instance':<40} {'patch':<6} {'served'}", flush=True)

    with open(pred_path, "w", encoding="utf-8") as pf, open(detail_path, "w", encoding="utf-8") as df:
        for i in range(n):
            ex = ds[i]
            prompt, has_ctx = build_prompt(ex)
            if not has_ctx:
                no_ctx += 1
            try:
                if a.direct:
                    text, done = ollama_chat(a.model, prompt, a.num_ctx, a.timeout,
                                             a.ollama_host, a.ollama_port)
                else:
                    text, done = chat_complete(a.host, a.port, prompt, a.provider, a.agent,
                                               a.mcp, a.route_intent, a.timeout)
            except ConnectionError as e:
                print(f"\nFATAL: {e}\nStart the server and (for --provider ollama) the local "
                      f"model, then retry. Partial predictions kept at {pred_path}.", flush=True)
                sys.exit(2)
            patch = extract_patch(text)
            with_patch += int(bool(patch))
            served = f"{done.get('source','?')}/{done.get('model','?')}"
            _bump(sources, done.get("source"))
            _bump(models, done.get("model"))

            # OFFICIAL swebench prediction schema — fed verbatim to run_evaluation.
            pf.write(json.dumps({
                "instance_id": ex["instance_id"],
                "model_patch": patch,
                "model_name_or_path": a.label,
            }, ensure_ascii=False) + "\n")
            df.write(json.dumps({
                "instance_id": ex["instance_id"], "repo": ex.get("repo"),
                "has_context": has_ctx, "patch_bytes": len(patch),
                "served_source": done.get("source"), "served_model": done.get("model"),
                "reply_head": text[:300],
            }, ensure_ascii=False) + "\n")
            print(f"{ex['instance_id']:<40} {'yes ' if patch else 'NONE'}  {served}", flush=True)

    dt = time.time() - t0
    summary = {
        "benchmark": "swebench-chat", "ts": a.ts, "label": a.label, "engine": "keystone-chat",
        "dataset": a.dataset, "split": a.split, "provider": a.provider or "auto",
        "n": n, "with_patch": with_patch, "no_context": no_ctx,
        "served_sources": sources, "served_models": models,
        "wall_s": round(dt, 1), "sec_per_instance": round(dt / n, 1) if n else 0.0,
        "resolved": None,  # filled below only if --grade actually measured it
        "note": "resolved% is execution-graded by the official swebench harness",
    }
    print(f"\nPREDICTIONS {with_patch}/{n} produced a patch  served={sources}")
    if no_ctx:
        print(f"WARNING: {no_ctx}/{n} instances had NO retrieved file context (problem-only) — "
              f"those will score ~0. Use a BM25 dataset (…_bm25_13K) for a fair single-shot run.")
    print(f"predictions -> {os.path.relpath(pred_path, ROOT)}")

    if a.grade:
        resolved, total = grade(a, pred_path)
        total = total or n
        if resolved is not None and total:
            pct = round(resolved / total, 3)
            summary.update(resolved=resolved, resolved_pct=pct, graded=True,
                           grade_backend=a.grade_backend)
            print(f"\nVERDICT swebench-chat resolved = {resolved}/{total} = {pct*100:.1f}%")
            with open(os.path.join(ROOT, "data", "eval", "leaderboard.jsonl"), "a",
                      encoding="utf-8") as f:
                f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    else:
        print("\nGRADE later (Docker + `pip install swebench`):")
        print(f"  python -m swebench.harness.run_evaluation \\\n"
              f"    --dataset_name {gold_dataset_name(a.dataset)} \\\n"
              f"    --predictions_path {os.path.relpath(pred_path, ROOT)} \\\n"
              f"    --run_id keystone-{a.ts} --max_workers {a.max_workers}")
    print(json.dumps(summary))


def selftest():
    """Offline proof that patch extraction + helpers work — no server, no dataset."""
    fails = 0
    fenced = ("Sure:\n```diff\ndiff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n"
              "@@ -1 +1 @@\n-old\n+new\n```\n")
    ok = extract_patch(fenced).startswith("diff --git") and "+new" in extract_patch(fenced)
    print(f"[selftest] fenced diff block      -> {ok}"); fails += 0 if ok else 1

    raw = "diff --git a/y.py b/y.py\n@@ -2 +2 @@\n-a\n+b\n"
    ok = extract_patch(raw).startswith("diff --git") and "+b" in extract_patch(raw)
    print(f"[selftest] raw diff (no fence)    -> {ok}"); fails += 0 if ok else 1

    ok = extract_patch("Just prose, no patch here.") == ""
    print(f"[selftest] prose-only (no patch)  -> {ok}"); fails += 0 if ok else 1

    _, has_ctx = build_prompt({"problem_statement": "boom", "repo": "a/b"})
    print(f"[selftest] no-context fallback flagged -> {not has_ctx}"); fails += 0 if not has_ctx else 1
    _, has_ctx = build_prompt({"text": "retrieved files + problem ..."})
    print(f"[selftest] retrieval text used    -> {has_ctx}"); fails += 0 if has_ctx else 1

    ok = gold_dataset_name("princeton-nlp/SWE-bench_Lite_bm25_13K") == "princeton-nlp/SWE-bench_Lite"
    print(f"[selftest] gold dataset strip     -> {ok}"); fails += 0 if ok else 1

    print("SELFTEST:", "PASS" if fails == 0 else f"FAIL ({fails})")
    sys.exit(0 if fails == 0 else 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="keystone-chat-swebench")
    ap.add_argument("--dataset", default="princeton-nlp/SWE-bench_Lite",
                    help="HF dataset; use a *_bm25_13K variant for retrieved file context")
    ap.add_argument("--split", default="test")
    ap.add_argument("--provider", default="ollama", help="ollama|anthropic|openai|... or '' for auto")
    ap.add_argument("--agent", default="keystone")
    ap.add_argument("--route-intent", default="coding_change", dest="route_intent")
    ap.add_argument("--mcp", action="store_true")
    ap.add_argument("--host", default=os.environ.get("KEYSTONE_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("KEYSTONE_PORT", "4177")))
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--full", action="store_true", help="run the whole split")
    ap.add_argument("--direct", action="store_true",
                    help="bypass the Keystone agent; hit ollama /api/chat directly (clean model test)")
    ap.add_argument("--model", default="qwen2.5-coder:latest", help="ollama model for --direct")
    ap.add_argument("--num-ctx", type=int, default=16384, dest="num_ctx",
                    help="ollama context window for --direct (oracle/bm25 prompts are large)")
    ap.add_argument("--ollama-host", default="127.0.0.1", dest="ollama_host")
    ap.add_argument("--ollama-port", type=int, default=11434, dest="ollama_port")
    ap.add_argument("--timeout", type=int, default=300, help="per-request chat timeout (s)")
    ap.add_argument("--ts", default=str(int(time.time())))
    ap.add_argument("--grade", action="store_true",
                    help="after predicting, shell out to the official swebench grader")
    ap.add_argument("--grade-backend", default="docker", choices=("docker", "modal"),
                    dest="grade_backend", help="execution backend for grading")
    ap.add_argument("--max-workers", type=int, default=4, dest="max_workers")
    ap.add_argument("--selftest", action="store_true", help="offline patch-extraction proof; no server")
    a = ap.parse_args()
    if a.selftest:
        selftest()
    run_eval(a)


if __name__ == "__main__":
    main()
