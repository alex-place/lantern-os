#!/usr/bin/env python3
"""
Harvest coding-task candidates from the system's own runs into the Σ₀ Ouro Coder
training pipeline (#781, continual-training loop — "close the flywheel").

WHAT THIS IS
  The input side of the offline self-training loop. It gathers `{fn, instruction,
  code, asserts}` coding candidates produced by Lantern's own agents/runs, NORMALIZES
  them, dedups, and writes a single `--extra-candidates` JSONL. That file is then
  EXECUTION-VERIFIED downstream by build_ouro_coding_dataset.load_extra_candidates
  (compile + exec + run asserts in an isolated subprocess) — only green code reaches
  training. This script therefore does NOT trust any "verified" flag on its inputs;
  per the Σ₀ ground-truth rule, a model's claim that its code works does not count —
  only a green subprocess does. Harvest gathers; the build stage is the judge.

  See scripts/continual_ouro_pipeline.py for the full loop (harvest -> verify -> train
  -> eval -> eval-gated promote) and docs/SIGMA0-CONTINUAL-TRAINING.md for the design
  + the Σ₀-briefing boundary (this is OFFLINE/opt-in; it is NOT wired into the live
  Observe->Converge request loop, which the North Star forbids from retraining weights).

SOURCES (each optional; all that are present are merged)
  --source-corpus PATH   a multi-agent corpus receipt JSON with result.tasks[] =
                         [{fn, instruction, code, asserts, category?}, ...]
                         (default: data/ouro-corpus-raw.json — the 12-agent #781 run)
  --source-jsonl PATH    a flat JSONL of {fn, instruction, code, asserts} rows. This is
                         the LIVE-RUN extension point: point it at any future stream of
                         coding successes emitted by autowork/keystone/chat once those
                         surfaces log code + executable asserts. Repeatable.

  NOTE ON SOURCES WE DELIBERATELY DO NOT HARVEST:
    * data/eval/humaneval/*.jsonl passing completions — training on HumanEval would
      CONTAMINATE the pass@1 eval the loop optimizes. Excluded on purpose.
    * lessons.db — that is the Kalshi/trading lessons store (trade_history, position_
      state, ...), not a coding-success source.

NORMALIZATION (robust to real agent output, not just the placeholder corpus)
  Agent corpora commonly emit the placeholder name `fn` in code/asserts/instruction
  while labeling the task with a descriptive `fn` field (e.g. "swap_case"). We rename
  the DEFINED top-level function to the descriptive name consistently across
  instruction + code + asserts so the verifier accepts it and the training signal uses
  real names. Hardening (from adversarial review #781):
    * the defined function is found by AST (first MODULE-SCOPE FunctionDef), NOT a regex
      that would grab a class method or a helper defined first;
    * a target name that shadows a Python builtin the body calls (sum/min/sorted/...) is
      suffixed, so the rename can't turn `return sum(x)` into infinite recursion;
    * distinct tasks that normalize to the SAME descriptive name are disambiguated
      (name_2, name_3) instead of silently dropped — only byte-identical code is a dup;
    * the placeholder `fn` is renamed in asserts too (code context, safe), but NOT
      blindly in instruction prose (that corrupted legitimate English/param uses of "fn").

    .venv-train/Scripts/python scripts/harvest_coding_corpus.py \
        --source-corpus data/ouro-corpus-raw.json \
        --out data/ouro-harvest-candidates.jsonl
"""
import argparse
import ast
import builtins
import hashlib
import json
import keyword
import os
import re
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CORPUS = os.path.join(ROOT, "data", "ouro-corpus-raw.json")
DEFAULT_OUT = os.path.join(ROOT, "data", "ouro-harvest-candidates.jsonl")

INSTR_SUFFIX = "Output only the function code."
_BUILTIN_NAMES = set(dir(builtins))


def _module_def_names(code):
    """Names of all MODULE-SCOPE (top-level) `def`s via AST. None if the code does not
    parse, [] if it defines no top-level function. Unlike a regex this ignores class
    methods and nested helpers, so we never rename a helper/method by mistake (review
    #781: a regex grabbed the first `def` anywhere and corrupted multi-def/class rows)."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return None
    return [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]


def _valid_ident(name):
    return bool(name) and name.isidentifier() and not keyword.iskeyword(name)


def _rename_fn(text, old, new):
    """Word-boundary rename of identifier `old` -> `new` in a code/assert/instruction
    string. Safe because `\\bold\\b` will not match inside longer identifiers."""
    if not old or old == new:
        return text
    return re.sub(rf"\b{re.escape(old)}\b", new, text)


def normalize_candidate(raw, idx):
    """Coerce one raw task dict into a verifier-ready {fn, instruction, code, asserts}
    candidate, renaming the placeholder function name to its descriptive name.
    Returns (candidate|None, reason). Collision disambiguation happens in main()."""
    fn_field = str(raw.get("fn") or "").strip()
    code = str(raw.get("code") or "").strip()
    instruction = str(raw.get("instruction") or "").strip()
    asserts = raw.get("asserts") or raw.get("checks") or []

    if not code or not instruction:
        return None, "missing code/instruction"
    if not isinstance(asserts, list) or not asserts:
        return None, "no asserts"

    defs = _module_def_names(code)
    if defs is None:
        return None, "code does not parse"
    if not defs:
        return None, "code defines no top-level function"

    # Pick the ENTRY function to rename (`defined`) and the desired name (`target`).
    # Rule: only rename ONE entry function, and never a helper/method.
    #   * fn_field already names a top-level def -> it's the entry; rename nothing (keep helpers)
    #   * exactly one top-level def -> that's the entry; rename it to the descriptive name
    #   * many defs incl. the placeholder `fn` -> `fn` is the entry; rename only it
    #   * many defs, none match -> ambiguous; drop rather than guess and corrupt
    want = fn_field if _valid_ident(fn_field) else None
    if want and want in defs:
        defined, target = want, want
    elif len(defs) == 1:
        defined = defs[0]
        target = want or (defs[0] if (_valid_ident(defs[0]) and defs[0] != "fn") else f"task_{idx}")
    elif "fn" in defs:
        defined, target = "fn", (want or f"task_{idx}")
    else:
        return None, "ambiguous: multiple top-level defs, none match fn field"

    # Don't let the target shadow a builtin the body may call (sum/min/sorted/list/...),
    # which would rename `def fn(x): return sum(x)` into `def sum(x): return sum(x)` —
    # infinite recursion that the verifier then (correctly) drops, losing a good example.
    if target in _BUILTIN_NAMES:
        target = target + "_fn"

    # Rename the DEFINED function (and all its references) to the target name across
    # code, asserts and instruction so the three stay consistent for training.
    code = _rename_fn(code, defined, target)
    asserts = [_rename_fn(str(a), defined, target) for a in asserts]
    if defined != target:
        instruction = _rename_fn(instruction, defined, target)
    # The placeholder `fn` may still appear in the ASSERTS (a self-inconsistent input:
    # descriptive `def`, but asserts call `fn`). Asserts are code, so renaming the bare
    # placeholder there is safe and salvages the row. We do NOT do this to the instruction
    # prose, where `fn` can legitimately be an English word or a parameter name.
    if "fn" not in (defined, target):
        asserts = [_rename_fn(a, "fn", target) for a in asserts]

    if f"def {target}" not in code:
        return None, "rename did not produce def target (unexpected)"

    # asserts must be real assert statements (the verifier requires this too).
    asserts = [a.strip() for a in asserts if a.strip().startswith("assert")]
    if not asserts:
        return None, "no assert-statements after normalization"

    if not instruction.endswith(INSTR_SUFFIX):
        instruction = instruction.rstrip(". ") + ". " + INSTR_SUFFIX

    return {"fn": target, "instruction": instruction, "code": code, "asserts": asserts}, "ok"


def _disambiguate(cand, used_names):
    """If cand['fn'] collides with an already-kept DISTINCT task, suffix it (name_2,
    name_3, ...) and re-rename consistently, so distinct rows aren't silently dropped by
    name-dedup here OR downstream in load_extra_candidates."""
    base = cand["fn"]
    if base not in used_names:
        return cand
    k = 2
    new = f"{base}_{k}"
    while new in used_names:
        k += 1
        new = f"{base}_{k}"
    cand["code"] = _rename_fn(cand["code"], base, new)
    cand["asserts"] = [_rename_fn(a, base, new) for a in cand["asserts"]]
    cand["instruction"] = _rename_fn(cand["instruction"], base, new)
    cand["fn"] = new
    return cand


def load_corpus(path):
    """Read result.tasks[] from a multi-agent corpus receipt JSON."""
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    tasks = (d.get("result") or {}).get("tasks") or d.get("tasks") or []
    return tasks, {"summary": d.get("summary"), "agentCount": d.get("agentCount")}


def load_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main():
    ap = argparse.ArgumentParser(description="Harvest coding candidates for the Σ₀ Ouro continual-training loop")
    ap.add_argument("--source-corpus", default=DEFAULT_CORPUS,
                    help="multi-agent corpus receipt JSON (result.tasks[]); '' to skip")
    ap.add_argument("--source-jsonl", action="append", default=[],
                    help="flat JSONL of {fn,instruction,code,asserts}; repeatable (live-run extension point)")
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()

    raw_rows = []        # (row, source_label)
    provenance = []
    if a.source_corpus and os.path.exists(a.source_corpus):
        tasks, meta = load_corpus(a.source_corpus)
        raw_rows += [(t, "corpus") for t in tasks]
        provenance.append({"source": a.source_corpus, "kind": "corpus", "n": len(tasks), **meta})
    elif a.source_corpus:
        print(f"[warn] corpus not found: {a.source_corpus}")
    for jp in a.source_jsonl:
        if os.path.exists(jp):
            rows = load_jsonl(jp)
            raw_rows += [(r, "jsonl") for r in rows]
            provenance.append({"source": jp, "kind": "jsonl", "n": len(rows)})
        else:
            print(f"[warn] jsonl source not found: {jp}")

    kept, seen_names, seen_hashes, drop_reasons = [], set(), set(), {}
    n_disambiguated = 0
    for i, (raw, src) in enumerate(raw_rows):
        cand, reason = normalize_candidate(raw, i)
        if cand is None:
            drop_reasons[reason] = drop_reasons.get(reason, 0) + 1
            continue
        # True duplicate = identical code body -> drop (hash check FIRST, before name).
        h = hashlib.sha1(cand["code"].encode("utf-8")).hexdigest()
        if h in seen_hashes:
            drop_reasons["dup code body"] = drop_reasons.get("dup code body", 0) + 1
            continue
        # Distinct code that happens to share a descriptive name -> disambiguate, keep.
        if cand["fn"] in seen_names:
            cand = _disambiguate(cand, seen_names)
            h = hashlib.sha1(cand["code"].encode("utf-8")).hexdigest()
            n_disambiguated += 1
        seen_hashes.add(h)
        seen_names.add(cand["fn"])
        cand["_source"] = src
        cand["_harvested_at"] = int(time.time())
        kept.append(cand)

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        for c in kept:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    print(f"harvested {len(kept)} candidate coding tasks from {len(raw_rows)} raw rows -> {a.out}")
    for src in provenance:
        print(f"  source: {src['kind']} n={src['n']} ({src['source']})")
    if n_disambiguated:
        print(f"  disambiguated {n_disambiguated} same-name-distinct-code task(s) (kept, suffixed)")
    if drop_reasons:
        print("  dropped (will be re-checked by execution-verify downstream anyway):")
        for reason, c in sorted(drop_reasons.items(), key=lambda kv: -kv[1]):
            print(f"    x{c}: {reason}")
    print("\nNext: execution-verify + train via scripts/continual_ouro_pipeline.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
