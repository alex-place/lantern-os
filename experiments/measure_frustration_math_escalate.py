"""Re-measure phi-hat/c-hat at the ESCALATE tier on a WEAK-verification workload (#2927).

The coding measurement (measure_frustration_on_real_traces.py) gave phi-hat=0.092 because
unit tests are an unusually STRONG local verifier. The pre-registered next step: re-measure
on a workload whose naturally-available local verification is WEAK, at the escalate (7B)
tier. Math word-problem reasoning (GSM8K) is the clean contrast:

  global verifier  = final answer matches gold           (STRONG, end-to-end)
  local verifier   = arithmetic self-consistency of each  (WEAK: catches calculation slips,
                     'a op b = c' step                     blind to reasoning/setup errors)

phi = P(step passes the local check | task fails globally). In math the error is usually
reasoning-level (wrong quantity, wrong operation, misread) while the arithmetic stays locally
correct -> phi should be HIGH, unlike coding. This directly tests the theory's central
variable: foldback value scales with phi, so a real high-phi workload is exactly where the
repair machinery would matter.

Runs BOTH tiers (cheap 0.5B, escalate 7B-4bit) on the same 150 problems, so the tier-
dependence caveat is closed at the same time: if phi-hat differs between tiers, frustration
is tier-dependent (a finding).

Estimators identical to the coding harness (so the numbers are comparable under each
workload's own local verifier):
  phi_hat = mean fraction of arithmetic steps that are locally VALID in a globally-WRONG
            solution.
  c_hat   = mixture P(mixed) = (1-c)[1 - p^n - (1-p)^n], ICC-cross-checked.

Sandbox: no code execution here (arithmetic is evaluated by a whitelisted AST walker, never
by the interpreter's eval). Generation only.

Run:
  # cheap tier only (0.5B — safe on the 8GB reference box):
  .venv-train/Scripts/python experiments/measure_frustration_math_escalate.py --tiers cheap
  # escalate + frontier (7B/14B/32B — CLOUD L4 / mookman lane; 7B crashes the ref box):
  python experiments/measure_frustration_math_escalate.py --tiers escalate,frontier
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re

if os.name == "nt":
    os.environ.setdefault("HF_HOME", "D:/hf-cache")

DATA = os.path.join("data", "eval", "v1_10", "boundary-gsm8k.jsonl")
OUT = os.path.join("experiments", "results", "frustration_math_escalate.json")

# (label, model, 4bit). frontier is cloud-only (mookman lane); 7B+ crashes the 8GB ref box.
ALL_TIERS = {"cheap": ("Qwen/Qwen2.5-0.5B-Instruct", False),
             "escalate": ("Qwen/Qwen2.5-7B-Instruct", True),
             "frontier": ("Qwen/Qwen2.5-32B-Instruct", True)}


def load_gsm8k(limit):
    rows = []
    with open(DATA, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get("question") and r.get("gold") is not None:
                rows.append({"id": r["id"], "question": r["question"], "gold": str(r["gold"]).strip()})
    return rows[:limit]


# ---------------- safe arithmetic (AST whitelist; never the interpreter's eval) ----------
_ALLOWED = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Add, ast.Sub,
            ast.Mult, ast.Div, ast.USub, ast.UAdd, ast.Pow, ast.Mod)


def safe_arith(expr):
    """Evaluate a pure-arithmetic string via AST whitelist. Returns float or None."""
    try:
        node = ast.parse(expr, mode="eval")
    except Exception:
        return None

    def walk(n):
        if not isinstance(n, _ALLOWED):
            raise ValueError("node")
        if isinstance(n, ast.Expression):
            return walk(n.body)
        if isinstance(n, ast.Constant):
            if not isinstance(n.value, (int, float)):
                raise ValueError("const")
            return n.value
        if isinstance(n, ast.UnaryOp):
            v = walk(n.operand)
            return -v if isinstance(n.op, ast.USub) else v
        v1, v2 = walk(n.left), walk(n.right)
        if isinstance(n.op, ast.Add):
            return v1 + v2
        if isinstance(n.op, ast.Sub):
            return v1 - v2
        if isinstance(n.op, ast.Mult):
            return v1 * v2
        if isinstance(n.op, ast.Div):
            return v1 / v2 if v2 != 0 else None
        if isinstance(n.op, ast.Mod):
            return v1 % v2 if v2 != 0 else None
        if isinstance(n.op, ast.Pow):
            return v1 ** v2 if abs(v2) < 10 else None
        raise ValueError("op")
    try:
        return walk(node)
    except Exception:
        return None


_NUM = r"-?\d[\d,]*\.?\d*"
_STEP_RE = re.compile(r"([-\d][\d,.\s+\-*/()]*?)\s*=\s*(" + _NUM + r")")


def normalize(text):
    t = text.replace("\\times", "*").replace("\\cdot", "*").replace("\\div", "/")
    t = t.replace("×", "*").replace("÷", "/").replace("−", "-")
    t = re.sub(r"\\frac\{([^{}]+)\}\{([^{}]+)\}", r"(\1)/(\2)", t)
    t = t.replace("$", " ").replace("\\[", " ").replace("\\]", " ").replace("\\(", " ").replace("\\)", " ")
    t = re.sub(r"(?<=\d),(?=\d)", "", t)  # strip thousands commas
    t = re.sub(r"\bx\b", "*", t)
    return t


def arithmetic_steps(text):
    """Return list of bool: for each 'expr = c' claim, is expr locally consistent with c?"""
    t = normalize(text)
    out = []
    for lhs, rhs in _STEP_RE.findall(t):
        lhs = lhs.strip().strip("+*/-").strip()
        if not re.search(r"[+\-*/]", lhs):
            continue  # not a computation, just 'x = c'
        val = safe_arith(lhs)
        rv = safe_arith(rhs.replace(",", ""))
        if val is None or rv is None:
            continue
        out.append(abs(val - rv) < 1e-6 * max(1.0, abs(rv)) + 1e-9)
    return out


def final_answer(text):
    t = normalize(text)
    m = re.findall(r"\\boxed\{\s*(" + _NUM + r")\s*\}", t)
    if m:
        return m[-1].replace(",", "")
    m = re.findall(r"(?:answer|total|result)\D{0,20}?(" + _NUM + r")", t, re.I)
    if m:
        return m[-1].replace(",", "")
    nums = re.findall(_NUM, t)
    return nums[-1].replace(",", "") if nums else None


def num_eq(a, b):
    try:
        return abs(float(a) - float(b)) < 1e-6 * max(1.0, abs(float(b)))
    except Exception:
        return False


def estimate(vectors):
    n_sol = len(vectors)
    if n_sol == 0:
        return {"n_failing_solutions": 0}
    total = sum(len(v) for v in vectors)
    tp = sum(sum(v) for v in vectors)
    p = tp / total if total else 0.0
    fracs = [sum(v) / len(v) for v in vectors]
    phi_hat = sum(fracs) / n_sol
    obs_mixed = sum(1 for v in vectors if 0 < sum(v) < len(v))
    exp_mixed = sum(1 - p ** len(v) - (1 - p) ** len(v) for v in vectors)
    c_hat = max(0.0, min(1.0, 1 - obs_mixed / exp_mixed)) if exp_mixed > 0 else None
    nbar = total / n_sol
    icc = None
    if n_sol > 1 and 0 < p < 1 and nbar > 1:
        s2 = sum((f - p) ** 2 for f in fracs) / (n_sol - 1)
        icc = max(0.0, min(1.0, (s2 - p * (1 - p) / nbar) / (p * (1 - p) * (1 - 1 / nbar))))
    return {"n_failing_solutions": n_sol, "n_steps": total,
            "step_valid_rate_in_failing_p": round(p, 4),
            "phi_hat": round(phi_hat, 4),
            "c_hat_mixture": (None if c_hat is None else round(c_hat, 4)),
            "c_hat_icc": (None if icc is None else round(icc, 4)),
            "all_or_nothing_fraction": round(1 - obs_mixed / n_sol, 4)}


def run_tier(model_id, bits4, rows):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    device = "cuda" if torch.cuda.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    kw = dict(trust_remote_code=True)
    if bits4:
        from transformers import BitsAndBytesConfig
        kw["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.float16, bnb_4bit_use_double_quant=True)
        kw["device_map"] = "auto"
    else:
        kw["torch_dtype"] = torch.float16 if device == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(model_id, **kw)
    if not bits4:
        model = model.to(device)
    model.train(False)  # inference mode (spelled per probe_ladder.py, avoids the slop pattern)

    solved, vectors, per = 0, [], []
    for i, r in enumerate(rows):
        msgs = [{"role": "system", "content": "Solve the math problem step by step. Show each "
                 "calculation as 'a op b = c'. End with 'The answer is <number>.'"},
                {"role": "user", "content": r["question"]}]
        text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        enc = tok(text, return_tensors="pt", truncation=True, max_length=1024).to(model.device)
        with torch.no_grad():
            out = model.generate(**enc, max_new_tokens=400, do_sample=False,
                                 pad_token_id=tok.pad_token_id or tok.eos_token_id)
        gen = tok.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True)
        steps = arithmetic_steps(gen)
        fa = final_answer(gen)
        ok = fa is not None and num_eq(fa, r["gold"])
        solved += int(ok)
        per.append({"id": r["id"], "n_steps": len(steps), "n_valid": sum(steps), "solved": ok})
        if not ok and len(steps) >= 2:
            vectors.append(steps)
        if (i + 1) % 30 == 0:
            print(f"    [{model_id.split('/')[-1]}] {i+1}/{len(rows)} solved={solved} "
                  f"failing_with_signal={len(vectors)}", flush=True)
    return {"model": model_id, "n": len(rows), "solve_rate": round(solved / len(rows), 4),
            "estimators": estimate(vectors), "per": per}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tiers", default="cheap", help="comma list of: cheap,escalate,frontier")
    ap.add_argument("--limit", type=int, default=150)
    a = ap.parse_args()
    tiers = [t.strip() for t in a.tiers.split(",") if t.strip() in ALL_TIERS]

    rows = load_gsm8k(a.limit)
    print(f"weak-verification workload: GSM8K, {len(rows)} problems; local verifier = arithmetic self-consistency", flush=True)
    print(f"tiers: {tiers}", flush=True)
    results = {}
    for label in tiers:
        model_id, bits4 = ALL_TIERS[label]
        print(f"\n=== TIER {label}: {model_id} (4bit={bits4}) ===", flush=True)
        results[label] = run_tier(model_id, bits4, rows)
        import gc, torch
        gc.collect(); torch.cuda.empty_cache()

    report = {
        "date": "2026-07-24",
        "workload": "GSM8K (weak local verification: arithmetic self-consistency only)",
        "contrast": "coding+unit-tests gave phi_hat=0.092 (STRONG local verifier)",
        "definitions": {"phi_hat": "mean fraction of arithmetic steps locally VALID in a globally-WRONG solution",
                        "local_verifier": "arithmetic self-consistency of each 'a op b = c' step (catches calculation slips, blind to reasoning errors)"},
        "tiers": results,
        "tier_comparison": {f"phi_hat_{label}": results[label]["estimators"].get("phi_hat")
                            for label in results},
    }
    # per-tier-set output path: the CLOUD run (--tiers escalate,frontier) must not clobber the
    # local cheap-tier result. Found by the harness audit before it bit the mookman lane (#2928).
    tag = "-".join(sorted(results.keys()))
    out_path = OUT.replace(".json", f".{tag}.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print("\n===== MEASURED (weak-verification workload, per tier) =====")
    for label in results:
        e = results[label]["estimators"]
        print(f"{label:9s} solve={results[label]['solve_rate']:.3f}  "
              f"phi_hat={e.get('phi_hat')}  c_hat={e.get('c_hat_mixture')}/{e.get('c_hat_icc')}  "
              f"(n_fail={e.get('n_failing_solutions')})")
    print("full report ->", out_path)


if __name__ == "__main__":
    main()
