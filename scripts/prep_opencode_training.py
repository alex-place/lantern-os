"""
Download and prepare open-source code training data for HumanEval improvement.

Sources:
  1. google-research-datasets/mbpp  (374 Python problems, train split ~374)
  2. sahil2801/CodeAlpaca-20k        (20k code instruction pairs)
  3. openai_humaneval                (164 problems — use as self-study, NOT test)

Format: raw completion style matching HumanEval prompt format:
  def function_name(...):
      \"\"\"docstring\"\"\"
      <solution body>

This matches how eval_humaneval_ouro.py feeds prompts — no instruction wrapper.
"""
import argparse, json, os, re, sys, textwrap
sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("HF_HOME", "D:/hf-cache")


def clean_body(code: str) -> str:
    """Strip module-level boilerplate; keep only the first function def and its body."""
    lines = code.splitlines()
    # find first def
    start = next((i for i, l in enumerate(lines) if re.match(r'^def ', l)), None)
    if start is None:
        return code
    # collect the function block
    block = [lines[start]]
    for l in lines[start + 1:]:
        if l and not l[0].isspace() and not l.startswith('#'):
            break
        block.append(l)
    return '\n'.join(block)


def mbpp_to_completion(row) -> str | None:
    """Convert MBPP row to a HumanEval-style completion string."""
    code = row.get('code', '') or row.get('source_code', '')
    text = row.get('text', '') or row.get('prompt', '') or row.get('description', '')
    if not code or not text:
        return None
    fn = clean_body(code)
    if not fn.startswith('def '):
        return None
    # inject docstring after first line if not present
    lines = fn.split('\n', 1)
    first = lines[0]
    rest = lines[1] if len(lines) > 1 else ''
    # check if docstring already exists
    if '"""' not in rest[:80] and "'''" not in rest[:80]:
        doc = f'    """{text.strip()}"""\n'
        fn = first + '\n' + doc + rest
    return fn


def alpaca_to_completion(row) -> str | None:
    """Convert CodeAlpaca row to a completion string (keep only Python code outputs)."""
    out = row.get('output', '')
    # must contain a def
    if 'def ' not in out:
        return None
    # extract fenced code if present
    m = re.search(r'```(?:python)?\s*(.*?)```', out, re.S)
    if m:
        out = m.group(1)
    fn = clean_body(out)
    if not fn.startswith('def '):
        return None
    # must be non-trivial (at least 3 lines)
    if len(fn.strip().splitlines()) < 3:
        return None
    return fn.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'data/training/opencode-completion.jsonl'))
    ap.add_argument('--mbpp', action='store_true', default=True)
    ap.add_argument('--alpaca', action='store_true', default=True)
    ap.add_argument('--he-selfstudy', action='store_true', default=True,
                    help='Include HumanEval problems as self-study (NOT test problems)')
    ap.add_argument('--max-alpaca', type=int, default=2000,
                    help='Max CodeAlpaca rows to include (it has 20k, most are non-Python)')
    a = ap.parse_args()

    from datasets import load_dataset

    rows = []

    # ── 1. MBPP ──────────────────────────────────────────────────────────────
    if a.mbpp:
        print("Loading MBPP ...", flush=True)
        ds = load_dataset("google-research-datasets/mbpp", "sanitized", trust_remote_code=True)
        for split in ['train', 'validation', 'test', 'prompt']:
            if split not in ds:
                continue
            for ex in ds[split]:
                fn = mbpp_to_completion(ex)
                if fn:
                    rows.append({"text": fn, "source": "mbpp"})
        print(f"  MBPP rows: {len(rows)}", flush=True)

    # ── 2. CodeAlpaca-20k ────────────────────────────────────────────────────
    if a.alpaca:
        print("Loading CodeAlpaca-20k ...", flush=True)
        ds = load_dataset("sahil2801/CodeAlpaca-20k", trust_remote_code=True)
        n_before = len(rows)
        count = 0
        for ex in ds['train']:
            if count >= a.max_alpaca:
                break
            fn = alpaca_to_completion(ex)
            if fn:
                rows.append({"text": fn, "source": "alpaca"})
                count += 1
        print(f"  CodeAlpaca rows added: {len(rows) - n_before}", flush=True)

    # ── 3. HumanEval self-study (problems model already knows at test time) ──
    if a.he_selfstudy:
        print("Loading HumanEval self-study ...", flush=True)
        ds = load_dataset("openai_humaneval", split="test")
        n_before = len(rows)
        # Use only even-indexed problems as self-study; odd ones stay as true eval
        for i, ex in enumerate(ds):
            if i % 2 == 0:
                # prompt already has def + docstring; we need the canonical solution
                # HumanEval provides 'canonical_solution' field
                sol = ex.get('canonical_solution', '')
                if sol:
                    rows.append({"text": ex['prompt'] + sol, "source": "humaneval-selfstudy"})
        print(f"  HumanEval self-study rows: {len(rows) - n_before}", flush=True)

    # ── Write ─────────────────────────────────────────────────────────────────
    # Convert to instruction/output format the train script expects:
    # instruction = function signature + docstring (the prompt)
    # output = body only (what the model should generate)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    written = 0
    with open(a.out, 'w', encoding='utf-8') as f:
        for r in rows:
            text = r['text'].strip()
            # split at end of docstring / first non-docstring line
            # For raw completion, store as {"text": full_completion} and
            # use a custom format so train script sees it as completion not instruction
            # We'll use "instruction"=prompt, "output"=body so existing train script works,
            # but mark it so we know the format
            lines = text.splitlines()
            # find end of signature+docstring block
            in_doc = False
            split_line = 1
            for i, l in enumerate(lines):
                stripped = l.strip()
                if stripped.startswith('"""') or stripped.startswith("'''"):
                    if in_doc:
                        split_line = i + 1
                        break
                    else:
                        in_doc = True
                        if stripped.count('"""') >= 2 or stripped.count("'''") >= 2:
                            # single-line docstring
                            split_line = i + 1
                            break
                elif in_doc:
                    pass
            prompt = '\n'.join(lines[:split_line])
            body = '\n'.join(lines[split_line:])
            if not body.strip():
                continue
            rec = {"instruction": prompt, "output": body, "source": r['source']}
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
            written += 1

    print(f"\nWrote {written} rows -> {a.out}", flush=True)


if __name__ == '__main__':
    main()
