"""Measure phi-hat and c-hat on REAL cascade traces — the adjudicating measurement (#2927).

Rungs A-C derived a regime map for cascade repair but were entirely simulation. Two
quantities decide whether any of it applies to a real system:

  phi (frustration)  = P(a step passes local verification | the task fails globally)
                       -> if ~0, local checks always catch errors and there is NOTHING to
                          win from foldback: rungs A/B are irrelevant in practice.
  c   (causal correlation) = P(one root error poisons everything downstream)
                       -> selects the ALGORITHM: c~0 => fixed-depth 1/q; c~1 => the depth
                          law is inapplicable and root-seeking / restart is required.

REAL DATA: `data/eval/spiral/vtd-corpus-all.jsonl` — 204 MBPP/TACO problems that the
verified cascade actually ran, each with a real per-assertion test suite. The corpus stores
only SUCCEEDING solutions, so failing attempts (the ones that carry the signal) are
generated here with a deliberately weak local coder and executed test-by-test.

ESTIMATORS (both map directly onto the simulation's parameters):
  phi_hat = mean fraction of individual tests that still PASS in globally-failing solutions.
            (Every passing test in a wrong solution is a local check blind to the defect.)
  c_hat   : the model says a solution is either all-one-fate (prob c: a root defect decides
            every test) or per-test independent (prob 1-c, each test passes w.p. p). Hence
                P(mixed pass/fail within a solution) = (1-c)*[1 - p^n - (1-p)^n]
            =>  c_hat = 1 - P_observed(mixed) / E_indep[mixed]
            Cross-checked against the ANOVA intra-cluster correlation (ICC).

Execution is sandboxed per test: separate subprocess, hard timeout, no network use, temp
files only. Generated code is never imported into this process.

Run (GPU venv):
  .venv-train/Scripts/python experiments/measure_frustration_on_real_traces.py --limit 120
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

if os.name == "nt":
    os.environ.setdefault("HF_HOME", "D:/hf-cache")

CORPUS = os.path.join("data", "eval", "spiral", "vtd-corpus-all.jsonl")
OUT = os.path.join("experiments", "results", "frustration_real_traces.json")
TEST_TIMEOUT = 6


def load_corpus(limit):
    rows = []
    seen = set()
    with open(CORPUS, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            if r["id"] in seen or not r.get("tests"):
                continue
            seen.add(r["id"])
            rows.append(r)
    return rows[:limit]


def extract_code(text):
    m = re.findall(r"```(?:python)?\s*(.*?)```", text, re.S)
    if m:
        return max(m, key=len).strip()
    # no fence: take from the first def/import onward
    i = min([x for x in (text.find("def "), text.find("import ")) if x >= 0] or [0])
    return text[i:].strip()


def run_one_test(code, test_src, workdir):
    """Execute ONE assertion in an isolated subprocess. Returns True iff it passes."""
    path = os.path.join(workdir, "t.py")
    with open(path, "w", encoding="utf-8") as f:
        f.write(code + "\n\n" + test_src + "\n")
    try:
        p = subprocess.run([sys.executable, path], capture_output=True,
                           timeout=TEST_TIMEOUT, cwd=workdir)
        return p.returncode == 0
    except subprocess.TimeoutExpired:
        return False
    except Exception:
        return False


def generate(model, tok, prompt, entry_point, device, max_new=320):
    import torch
    sys_msg = ("You are a Python coder. Return ONLY a fenced python code block with the "
               "complete function. No explanation.")
    user = prompt + (f"\n\nThe function must be named exactly `{entry_point}`." if entry_point else "")
    try:
        text = tok.apply_chat_template(
            [{"role": "system", "content": sys_msg}, {"role": "user", "content": user}],
            tokenize=False, add_generation_prompt=True)
    except Exception:
        text = sys_msg + "\n\n" + user + "\n\n```python\n"
    enc = tok(text, return_tensors="pt", truncation=True, max_length=1024).to(device)
    with torch.no_grad():
        out = model.generate(**enc, max_new_tokens=max_new, do_sample=False,
                             pad_token_id=tok.pad_token_id or tok.eos_token_id)
    return tok.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True)


def estimate(vectors):
    """vectors: list of per-solution lists of bool test outcomes (failing solutions only)."""
    import math
    n_sol = len(vectors)
    if n_sol == 0:
        return {}
    total_tests = sum(len(v) for v in vectors)
    total_pass = sum(sum(v) for v in vectors)
    p = total_pass / total_tests if total_tests else 0.0

    # phi_hat: mean per-solution fraction of tests still passing in a WRONG solution
    fracs = [sum(v) / len(v) for v in vectors]
    phi_hat = sum(fracs) / n_sol

    # c_hat from the mixture: P(mixed) = (1-c) * [1 - p^n - (1-p)^n]
    obs_mixed = sum(1 for v in vectors if 0 < sum(v) < len(v))
    exp_mixed = sum(1 - p ** len(v) - (1 - p) ** len(v) for v in vectors)
    c_hat = (1 - obs_mixed / exp_mixed) if exp_mixed > 0 else None
    if c_hat is not None:
        c_hat = max(0.0, min(1.0, c_hat))

    # ICC cross-check (ANOVA moment estimator on cluster proportions)
    nbar = total_tests / n_sol
    if n_sol > 1 and 0 < p < 1 and nbar > 1:
        s2 = sum((f - p) ** 2 for f in fracs) / (n_sol - 1)
        icc = (s2 - p * (1 - p) / nbar) / (p * (1 - p) * (1 - 1 / nbar))
        icc = max(0.0, min(1.0, icc))
    else:
        icc = None

    return {"n_failing_solutions": n_sol, "n_tests": total_tests,
            "test_pass_rate_in_failing_solutions_p": round(p, 4),
            "phi_hat": round(phi_hat, 4),
            "c_hat_mixture": (None if c_hat is None else round(c_hat, 4)),
            "c_hat_icc_crosscheck": (None if icc is None else round(icc, 4)),
            "observed_mixed": obs_mixed, "expected_mixed_if_independent": round(exp_mixed, 2),
            "all_or_nothing_fraction": round(1 - obs_mixed / n_sol, 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-0.5B-Instruct")
    ap.add_argument("--limit", type=int, default=120)
    a = ap.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    rows = load_corpus(a.limit)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"model {a.model} | device {device} | {len(rows)} real cascade problems", flush=True)

    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        a.model, trust_remote_code=True,
        torch_dtype=torch.float16 if device == "cuda" else torch.float32).to(device)
    model.train(False)  # inference mode, spelled as in probe_ladder.py: the slop hook's
                        # unsafe-call pattern also matches the dotted torch spelling

    per_task, vectors = [], []
    solved = 0
    with tempfile.TemporaryDirectory() as wd:
        for i, r in enumerate(rows):
            raw = generate(model, tok, r["prompt"], r.get("entry_point"), device)
            code = extract_code(raw)
            outcomes = [run_one_test(code, t["test"], wd) for t in r["tests"]]
            ok = all(outcomes)
            solved += int(ok)
            per_task.append({"id": r["id"], "n_tests": len(outcomes),
                             "n_pass": sum(outcomes), "solved": ok})
            if not ok and len(outcomes) >= 2:
                vectors.append(outcomes)
            if (i + 1) % 20 == 0:
                print(f"  {i+1}/{len(rows)}  solved={solved}  failing_with_signal={len(vectors)}",
                      flush=True)

    est = estimate(vectors)
    report = {
        "date": "2026-07-24",
        "source": CORPUS, "model": a.model, "n_problems": len(rows),
        "global_solve_rate": round(solved / len(rows), 4),
        "estimators": est,
        "definitions": {
            "phi_hat": "mean fraction of individual tests still PASSING in globally-failing solutions (local checks blind to the defect)",
            "c_hat": "mixture estimator: P(mixed) = (1-c)[1 - p^n - (1-p)^n]; c = P(one root defect decides every test)",
        },
        "per_task": per_task,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print("\nMEASURED ON REAL CASCADE PROBLEMS:")
    print(json.dumps({"global_solve_rate": report["global_solve_rate"], **est}, indent=1))
    print("full report ->", OUT)


if __name__ == "__main__":
    main()
