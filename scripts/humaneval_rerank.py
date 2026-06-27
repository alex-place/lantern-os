"""
Phase 3 (issue #1292) — test-time reranking for HumanEval.

Pick the best of N sampled candidates using ONLY signals that are safe and
ground-truthed:

  1. the `>>>` doctest examples ALREADY PRESENT in each HumanEval prompt
     (in-prompt, author-provided → genuine ground truth, not model-invented), and
  2. self-consistency (agreement of outputs across the sampled candidates).

We deliberately do NOT ask the model to write its own tests: arXiv:2501.12793
shows self-generated tests bias selection and *lower* pass@1. The hidden HumanEval
test suite is used ONLY to score the FINALLY-selected candidate (the real pass@1)
— never to choose it.

GPU-free by design: this module reranks already-generated candidate *strings*.
Only candidate generation (in eval_humaneval_ouro.py) needs the model, so the
selection logic here is unit-testable on a CPU with mock candidates.

Public API:
    extract_examples(prompt, entry_point) -> [(call_src, expected_src), ...]
    evaluate_candidate(candidate, examples, entry_point, timeout) -> dict
    rerank(candidates, prompt, entry_point, timeout) -> (best_candidate, info)
"""
import ast
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter


def _docstring_lines(prompt):
    """Return the prompt's lines; the `>>>` scan works directly on them (HumanEval
    keeps its examples inside the function docstring, which is part of `prompt`)."""
    return prompt.splitlines()


def _is_literal(src):
    try:
        ast.literal_eval(src)
        return True
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return False


def extract_examples(prompt, entry_point):
    """Pull (call, expected) pairs from the prompt's `>>>` doctests.

    Two shapes are recognised, both author-written (safe ground truth):
        >>> entry_point(args)
        expected_literal
    and the inline-assertion shape:
        >>> entry_point(args) == expected_literal

    Only calls to `entry_point` whose expected value is a Python *literal*
    (number/str/bool/None/tuple/list/dict) are kept — that filters out
    `print(...)` examples and anything we cannot compare safely. Returns [] when
    the docstring carries no usable example (the caller then falls back to
    self-consistency)."""
    pref = entry_point + "("
    out = []
    lines = _docstring_lines(prompt)
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if not s.startswith(">>>"):
            i += 1
            continue
        call = s[3:].strip()
        expected = None
        # inline-assertion shape: ">>> f(x) == 3"  (split on a top-level ==)
        if "==" in call:
            lhs, rhs = call.split("==", 1)
            lhs, rhs = lhs.strip(), rhs.strip()
            if lhs.startswith(pref) and _is_literal(rhs):
                out.append((lhs, rhs))
            i += 1
            continue
        # two-line shape: call on the >>> line, expected on the next content line
        j = i + 1
        while j < len(lines):
            t = lines[j].strip()
            if t == "" or t.startswith(">>>"):
                break
            expected = t
            break
        if call.startswith(pref) and expected is not None and _is_literal(expected):
            out.append((call, expected))
        i += 1
    return out


def _harness(examples):
    """Program tail that runs each example against the candidate's namespace and
    prints one JSON line: [[repr(value), passed_bool], ...]. Exceptions are caught
    per-example so one bad example never sinks an otherwise-correct candidate."""
    body = ["import json as __json", "__res = []"]
    for call, expected in examples:
        body += [
            "try:",
            f"    __v = ({call})",
            f"    __res.append([repr(__v), bool(__v == ({expected}))])",
            "except Exception as __e:",
            "    __res.append(['ERR:' + type(__e).__name__, False])",
        ]
    body.append('print("RERANK_RESULT " + __json.dumps(__res))')
    return "\n".join(body)


def evaluate_candidate(candidate, examples, entry_point, timeout=6):
    """Run `candidate` against the extracted examples in a sandboxed subprocess.

    Returns {passes, total, sig, ok}:
      passes — how many in-prompt examples the candidate satisfies,
      sig    — tuple of per-example output reprs (the self-consistency signature),
      ok     — the program ran to completion (compiles + no crash before output).
    A candidate that does not parse/import returns passes=0, ok=False."""
    total = len(examples)
    if candidate is None:
        return {"passes": 0, "total": total, "sig": ("__noparse__",), "ok": False}
    program = candidate + "\n\n" + _harness(examples)
    path = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(program)
            path = f.name
        r = subprocess.run([sys.executable, path], capture_output=True, timeout=timeout, text=True)
        line = next((ln for ln in r.stdout.splitlines() if ln.startswith("RERANK_RESULT ")), None)
        if line is None:
            return {"passes": 0, "total": total, "sig": ("__crash__",), "ok": False}
        res = json.loads(line[len("RERANK_RESULT "):])
        passes = sum(1 for _, ok in res if ok)
        sig = tuple(r0 for r0, _ in res)
        return {"passes": passes, "total": total, "sig": sig, "ok": True}
    except subprocess.TimeoutExpired:
        return {"passes": 0, "total": total, "sig": ("__timeout__",), "ok": False}
    except Exception as e:  # pragma: no cover - defensive
        return {"passes": 0, "total": total, "sig": (f"__runner:{e}__",), "ok": False}
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


def _normalize_source(src):
    """Coarse self-consistency key when there are no runnable examples: collapse
    whitespace so trivially-formatted twins cluster together."""
    return " ".join((src or "").split())


def rerank(candidates, prompt, entry_point, timeout=6):
    """Select the best candidate. Returns (best_candidate_or_None, info).

    Strategy:
      * Drop candidates that did not parse (None).
      * If the prompt has usable `>>>` examples: keep the candidates that pass the
        MOST examples; break ties by self-consistency (largest cluster of
        identical output signatures), then by sample order.
      * If the prompt has NO usable examples: fall back to self-consistency on the
        normalized source (largest identical-source cluster), then sample order.
    info carries the method + per-candidate scores for an auditable record (Σ₀)."""
    idx = [k for k, c in enumerate(candidates) if c is not None]
    if not idx:
        return None, {"method": "none", "n_examples": 0, "n_candidates": 0}

    examples = extract_examples(prompt, entry_point)

    if not examples:
        groups = Counter(_normalize_source(candidates[k]) for k in idx)
        best_key = max(idx, key=lambda k: (groups[_normalize_source(candidates[k])], -k))
        return candidates[best_key], {
            "method": "self-consistency", "n_examples": 0,
            "n_candidates": len(idx), "selected_index": best_key,
        }

    evals = {k: evaluate_candidate(candidates[k], examples, entry_point, timeout) for k in idx}
    best_score = max(evals[k]["passes"] for k in idx)
    top = [k for k in idx if evals[k]["passes"] == best_score]

    if len(top) > 1:
        sig_counts = Counter(evals[k]["sig"] for k in top)
        # largest output cluster among the top scorers; ties → earliest sample
        top.sort(key=lambda k: (-sig_counts[evals[k]["sig"]], k))

    chosen = top[0]
    return candidates[chosen], {
        "method": "examples", "n_examples": len(examples), "n_candidates": len(idx),
        "best_example_passes": best_score, "selected_index": chosen,
        "scores": {str(k): evals[k]["passes"] for k in idx},
    }
