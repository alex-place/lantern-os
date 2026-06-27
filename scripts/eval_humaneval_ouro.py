"""
Real HumanEval pass@1 for the Σ₀ Ouro Coder (Ouro-1.4B + Σ₀ LoRA).

Replaces the 3-task toy harness with the canonical 164-problem HumanEval set and
FAITHFUL sandboxed execution (build `completion + test + check(entry_point)`, run
in a subprocess with a timeout — the same contract OpenAI's human-eval uses).

Generation uses Ouro's STOCK cached `generate()` (the FAST product path), not the
no-cache Q-exit loop (which is ~1 s/token and quadratic → infeasible for 164×N tokens).
So this measures the model Lantern actually serves in FAST mode.

    .venv-train/Scripts/python scripts/eval_humaneval_ouro.py --limit 20      # quick real estimate
    .venv-train/Scripts/python scripts/eval_humaneval_ouro.py --full          # all 164 (slow)

Outputs:
    data/eval/humaneval/<label>-<ts>.jsonl    per-problem detail
    data/eval/leaderboard.jsonl               one summary row {benchmark:humaneval, pass@1, n, ...}
"""
import argparse, json, os, re, subprocess, sys, time, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("HF_HOME", "D:/hf-cache")
# canonical HumanEval completion stops: ONLY true top-level boundaries (column 0).
# NB: do NOT stop on "\n#" or "\nprint(" — the model writes comments/prints INSIDE the
# body, and stopping there truncates a valid function (smoke: it emitted "\n#" and died).
# "\nassert " and "\ndef test_" catch model self-appended unit-test blocks.
STOP = ["\ndef ", "\nclass ", "\nif __name__", "\n\n\n", "\n```",
        "\nassert ", "\ndef test_",
        # punctuation-spam patterns Ouro emits after valid code
        ", , , ", '","","', " , , "]


def trim_body(body):
    body = body.replace("\t", "    ")   # model indents with tabs; prompt uses spaces → TabError
    for s in STOP:
        k = body.find(s)
        if k != -1:
            body = body[:k]
    # Detect repetition loops — two strategies:
    #
    # 1. Prefix repetition: body starts with X; X appears again later.
    #    Ouro often emits the correct body then repeats from the beginning.
    #    Use the first 30 non-space chars as the key to avoid false-positives
    #    on short variable names that legitimately appear multiple times.
    prefix = body[:30].strip()
    if len(prefix) >= 10:
        second = body.find(prefix, 30)
        if second != -1:
            body = body[:second]
    #
    # 2. Inline return repetition: "return X" immediately followed by "return X".
    #    Catches patterns like "return resultreturn result".
    m = re.search(r'(return \w+)\1', body)
    if m:
        body = body[:m.start() + len(m.group(1))]
    return body.rstrip()


def _repair_first_line(body):
    """Best-effort repair of common fragment patterns from the Ouro separator strip.

    Ouro emits <endoftext>(expr) as body start; after skip_special_tokens the '(' is
    gone, leaving 'expr)' as the first token.  Two common cases:
      'x, y) = rhs'  → '(x, y) = rhs'   (tuple-unpack fragment)
      'expr, ...'    → 'return expr, ...'  (return-value fragment)
    """
    lines = body.split('\n', 1)
    first = lines[0]
    rest = ('\n' + lines[1]) if len(lines) > 1 else ''
    stripped = first.lstrip()
    indent = first[:len(first) - len(stripped)]
    # tuple-unpack missing opening paren: "ids, var) = rhs"
    if re.match(r'\w[\w,\s]*\) =', stripped) and not stripped.startswith('('):
        return indent + '(' + stripped + rest
    # bare expression (not a statement keyword) → try prepending 'return'
    kw = ('return', 'if', 'for', 'while', 'try', 'with', 'raise', 'yield',
          'pass', 'break', 'continue', 'import', 'from', 'def', 'class',
          'assert', '#')
    if stripped and not any(stripped.startswith(k) for k in kw):
        # Only prepend 'return' for expressions, not assignment statements.
        # Detect assignment: bare '=' not preceded/followed by =, !, <, >
        has_assign = bool(re.search(r'(?<![=!<>])=(?!=)', stripped))
        if not has_assign and re.match(r'[a-zA-Z_\d\("]', stripped):
            return indent + 'return ' + stripped + rest
    return body


def _normalize_body_indent(body):
    """Ensure function body lines are at the expected 4-space base indentation.

    The model sometimes emits the body with:
    a) First line at col 0, subsequent lines already at 4+ (only first line broken).
    b) ALL lines at relative-to-zero indent (whole body needs +4 shift).
    Distinguish by checking whether the SECOND non-empty line is also at col 0.
    """
    lines = body.split('\n')
    nonempty = [(i, l) for i, l in enumerate(lines) if l.strip()]
    if not nonempty:
        return body
    first_idx, first_line = nonempty[0]
    if first_line and first_line[0] in (' ', '\t'):
        return body  # already indented — nothing to do
    # First line is at col 0.
    if len(nonempty) > 1 and nonempty[1][1] and nonempty[1][1][0] not in (' ', '\t'):
        # Second nonempty line also at col 0 → all lines need +4
        lines = [('    ' + l if l.strip() else l) for l in lines]
    else:
        # Only first line needs +4 (rest already have correct absolute indent)
        lines[first_idx] = '    ' + first_line
    return '\n'.join(lines)


def make_candidate(text, entry_point, he_prompt):
    """Canonical HumanEval: candidate = prompt (signature+docstring+imports) + generated body.
    Strip any fenced/instruct wrapper the model may add, then keep the indented continuation.
    Returns a compile-valid candidate or None."""
    # if the model wrapped output in a fence, take the fenced content
    m = re.search(r"```(?:python)?\s*(.*?)```", text, re.S)
    if m:
        c = m.group(1)
        i = c.find(f"def {entry_point}")
        if i >= 0:               # model re-emitted the whole function → use prompt preamble + it
            di = he_prompt.find(f"def {entry_point}")
            preamble = he_prompt[:di] if di >= 0 else ""
            lines = c[i:].splitlines()
            blk = [lines[0]]
            for ln in lines[1:]:
                if ln.strip() == "" or ln[:1] in (" ", "\t"):
                    blk.append(ln)
                else:
                    break
            cand = (preamble + "\n".join(blk).rstrip()).replace("\t", "    ")
            try:
                compile(cand, "<c>", "exec"); return cand
            except SyntaxError:
                pass
        text = c                 # else treat fenced content as the body continuation
    body = _normalize_body_indent(trim_body(text))
    if not body.strip():
        return None
    repaired = _repair_first_line(body)
    # Pass 1: try clean compile on raw body then repaired body.
    # Do NOT fall through to drop-lines here — the docstring-only function would
    # compile but return None, blocking the repair path from ever running.
    for candidate_body in [body, repaired]:
        cand = he_prompt + candidate_body
        try:
            compile(cand, "<c>", "exec"); return cand
        except SyntaxError:
            pass
    # Pass 2: drop-lines fallback (raw then repaired), but only accept if the
    # result retains at least one real body line beyond the prompt skeleton.
    min_prompt_lines = len(he_prompt.splitlines())
    for candidate_body in [body, repaired]:
        cand = he_prompt + candidate_body
        lines = cand.splitlines()
        while len(lines) > min_prompt_lines + 1:
            lines.pop()
            try:
                compile("\n".join(lines), "<c>", "exec"); return "\n".join(lines)
            except SyntaxError:
                continue
    return None


def run_test(candidate, test_src, entry_point, timeout=12):
    if candidate is None:
        return False, "no-parse"
    program = candidate + "\n\n" + test_src + f"\n\ncheck({entry_point})\n"
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(program)
        path = f.name
    try:
        r = subprocess.run([sys.executable, path], capture_output=True, timeout=timeout, text=True)
        ok = r.returncode == 0
        return ok, ("" if ok else (r.stderr.strip().splitlines() or ["?"])[-1][:120])
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except Exception as e:
        return False, f"runner: {e}"
    finally:
        try: os.unlink(path)
        except OSError: pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="ouro-fast-humaneval")
    ap.add_argument("--base-model", default="ByteDance/Ouro-1.4B")
    ap.add_argument("--adapter", default=os.environ.get("OURO_ADAPTER", "D:/lantern-train/ouro-sigma0-adapters/final"))
    ap.add_argument("--limit", type=int, default=20, help="number of problems (from the start)")
    ap.add_argument("--full", action="store_true", help="run all 164")
    ap.add_argument("--max-new", type=int, default=300)
    ap.add_argument("--ts", default=str(int(time.time())))
    a = ap.parse_args()

    # datasets must be imported before torch on Windows to avoid pyarrow/CUDA DLL conflict
    from datasets import load_dataset
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    print("Loading HumanEval (openai_humaneval) ...", flush=True)
    ds = load_dataset("openai_humaneval", split="test")
    n = len(ds) if a.full else min(a.limit, len(ds))

    print(f"Loading {a.base_model} + adapter={a.adapter} ...", flush=True)
    tok = AutoTokenizer.from_pretrained(a.base_model, trust_remote_code=True)
    # Ouro uses token 0 as both bos and eos — use bos as pad so pad_token_id != eos_token_id.
    # When pad==eos, HF generate() interprets the first generated eos as immediate stop,
    # returning 1 token even for code-completion prompts.
    tok.pad_token = tok.bos_token
    model = AutoModelForCausalLM.from_pretrained(a.base_model, trust_remote_code=True,
                                                 dtype=torch.float16, device_map="auto")
    if a.adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, a.adapter)
    model.eval()

    out_dir = os.path.join(ROOT, "data", "eval", "humaneval")
    os.makedirs(out_dir, exist_ok=True)
    detail_path = os.path.join(out_dir, f"{a.label}-{a.ts}.jsonl")

    detail, n_ok, t0 = [], 0, time.time()
    print(f"\n{'task':<14} {'pass':<5} {'note'}", flush=True)
    for i in range(n):
        ex = ds[i]
        # canonical completion: feed the raw signature+docstring, let the model continue the code
        ids = tok(ex["prompt"], return_tensors="pt").input_ids.to(model.device)
        attn = torch.ones_like(ids)
        with torch.no_grad():
            # eos_token_id=None: Ouro uses token 0 (endoftext) as a separator BEFORE
            # the generated body, not after — so disabling eos-stopping lets the
            # model emit the body; stop_strings catch the end of the function.
            out = model.generate(ids, attention_mask=attn, max_new_tokens=a.max_new, do_sample=False,
                                 repetition_penalty=1.1, pad_token_id=tok.pad_token_id,
                                 eos_token_id=None,
                                 stop_strings=STOP, tokenizer=tok)
        # skip_special_tokens strips the leading endoftext separator token
        text = tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True)
        # strip chat-role prefix emitted by models overtrained on conversation data
        text = re.sub(r'^assistant\s*[:\n]\s*', '', text, flags=re.IGNORECASE)
        cand = make_candidate(text, ex["entry_point"], ex["prompt"])
        ok, note = run_test(cand, ex["test"], ex["entry_point"])
        n_ok += int(ok)
        row = {"task_id": ex["task_id"], "entry_point": ex["entry_point"],
               "ok": ok, "note": note, "completion": text[:600]}
        detail.append(row)
        # write each result immediately so a pipeline timeout doesn't lose all data
        with open(detail_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"{ex['task_id']:<14} {'OK ' if ok else 'x  '}  {note}", flush=True)

    dt = time.time() - t0
    # #774/fix-7: note histogram — parse-failure/timeout/assert-fail breakdown
    note_counts = {}
    for d in detail:
        if not d["ok"]:
            key = d["note"][:40] if d["note"] else "unknown"
            # bucket by prefix so minor variations collapse (e.g. "assert …")
            bucket = "no-parse" if key == "no-parse" else \
                     "timeout" if key == "timeout" else \
                     "assert" if key.startswith("assert") else \
                     "exec-error" if key.startswith("Traceback") or key.startswith("runner") else \
                     "other"
            note_counts[bucket] = note_counts.get(bucket, 0) + 1
    summary = {
        # reconciled schema — "benchmark" key shared across all eval scripts (#776)
        "benchmark": "humaneval",
        "ts": a.ts, "label": a.label, "engine": "ouro-fast-cached",
        "base_model": a.base_model, "adapter": bool(a.adapter),
        "n": n, "subset": (not a.full), "pass@1": round(n_ok / n, 3) if n else 0.0,
        "accuracy": round(n_ok / n, 3) if n else 0.0,  # alias for cross-benchmark summary
        "passed": n_ok, "wall_s": round(dt, 1), "sec_per_problem": round(dt / n, 1) if n else 0.0,
        "failure_breakdown": note_counts,  # #774/fix-7: no-parse/timeout/assert/exec-error counts
    }
    # detail_path already written incrementally above; nothing more to write for per-problem rows
    with open(os.path.join(ROOT, "data", "eval", "leaderboard.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    tag = "HumanEval" + ("" if a.full else f"[first {n}]")
    print(f"\nVERDICT {tag} pass@1 = {summary['pass@1']*100:.1f}%  ({n_ok}/{n})  "
          f"{summary['sec_per_problem']}s/problem", flush=True)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
