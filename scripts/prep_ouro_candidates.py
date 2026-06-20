"""
Normalize model-generated coding-task candidates into clean {fn,instruction,code,asserts}
rows for build_ouro_coding_dataset.py --extra-candidates (#781).

The generator (a Workflow fan-out) returned tasks where the function was often a literal
placeholder `fn` and where `<`/`>` arrived HTML-escaped (`&lt;`/`&gt;`). This script:
  1. html.unescape() code / asserts / instruction (idempotent if already clean),
  2. detects each task's real function name (the one its asserts call), and renames it
     whole-word to the task's meaningful logical name so the model is taught real names,
  3. drops obviously-malformed rows (no identifier, no asserts) and dedups by logical name.

It does NOT decide correctness — that is the execution-verifier's job downstream. This is
purely a textual normalizer; anything it produces still has to pass sandboxed execution.

    python scripts/prep_ouro_candidates.py <raw-workflow-output.json> [out.jsonl]
"""
import html
import json
import os
import re
import sys

DEFAULT_OUT = "models/lantern-sigma0-coder/coding-extra.candidates.jsonl"
_IDENT = re.compile(r"^[A-Za-z_]\w*$")


def called_name(asserts):
    for a in asserts:
        m = re.search(r"assert\s+(?:not\s+)?([A-Za-z_]\w*)\s*\(", a)
        if m:
            return m.group(1)
    return None


def top_def(code):
    names = re.findall(r"(?m)^\s*def\s+([A-Za-z_]\w*)\s*\(", code)
    return names[-1] if names else None  # last top-level def = the public fn (helpers precede it)


def rename(text, old, new):
    return re.sub(r"\b" + re.escape(old) + r"\b", new, text)


def load_raw(path):
    text = open(path, encoding="utf-8").read()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        i = text.find("{")
        return json.loads(text[i:]) if i >= 0 else {"tasks": []}


def main():
    if len(sys.argv) < 2:
        print("usage: prep_ouro_candidates.py <raw.json> [out.jsonl]", file=sys.stderr)
        return 2
    raw = load_raw(sys.argv[1])
    out_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    # accept either the bare {count,tasks} return value or the full workflow envelope
    # {summary, logs, result:{count,tasks}}, or a top-level list of tasks.
    if isinstance(raw, list):
        tasks = raw
    elif isinstance(raw.get("result"), dict) and "tasks" in raw["result"]:
        tasks = raw["result"]["tasks"]
    else:
        tasks = raw.get("tasks", [])

    rows, seen, skipped = [], set(), 0
    for t in tasks:
        target = (t.get("fn") or "").strip()
        code = html.unescape(t.get("code") or "")
        instr = html.unescape(t.get("instruction") or "")
        asserts = [html.unescape(a) for a in (t.get("asserts") or [])]
        if not (_IDENT.match(target) and code.strip() and asserts):
            skipped += 1
            continue
        actual = called_name(asserts) or top_def(code)
        if actual and actual != target:
            code = rename(code, actual, target)
            instr = rename(instr, actual, target)
            asserts = [rename(a, actual, target) for a in asserts]
        if target in seen:
            skipped += 1
            continue
        seen.add(target)
        rows.append({"fn": target, "instruction": instr, "code": code, "asserts": asserts})

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"normalized {len(rows)} candidates ({skipped} skipped) -> {out_path}")


if __name__ == "__main__":
    raise SystemExit(main())
