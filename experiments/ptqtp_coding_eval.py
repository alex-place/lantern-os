r"""
ptqtp_coding_eval.py — does PTQTP quantization cost coding capability? HumanEval FP16 vs PTQTP (#2206).

Loads Qwen2.5-Coder, runs HumanEval greedy at FP16, then PTQTP-quantizes every linear in place
(experiments.ptqtp_quantize.ptqtp_matrix) and re-runs the SAME problems. pass@1 delta is the money
metric: the perplexity check said 7B degrades ~5% — does that touch actual code synthesis?

Run:  .venv-train/Scripts/python.exe experiments/ptqtp_coding_eval.py --model Qwen/Qwen2.5-Coder-7B-Instruct --n 20
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")
from datasets import load_dataset  # noqa: E402  MUST precede torch (pyarrow/CUDA DLL conflict on Windows, #2264)
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "experiments"))
sys.path.insert(0, str(REPO / "scripts"))
from ptqtp_quantize import ptqtp_matrix  # noqa: E402
from eval_humaneval_ouro import run_test  # noqa: E402  (subprocess exec sandbox)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def extract_code(text, prompt, entry_point):
    """Pull a runnable candidate from the chat completion: prefer a fenced block that defines the
    entry point; else stitch the prompt with the continuation."""
    import re
    blocks = re.findall(r"```(?:python)?\s*(.*?)```", text, re.S)
    for b in blocks:
        if f"def {entry_point}" in b:
            try:
                compile(b, "<c>", "exec"); return b
            except SyntaxError:
                pass
    # else: treat text as a continuation of the prompt body
    cand = prompt + text
    for c in (cand, prompt + text.split("```")[0]):
        try:
            compile(c, "<c>", "exec"); return c
        except SyntaxError:
            continue
    return None


def run_humaneval(model, tok, problems, max_new=320):
    passed = 0
    fails = {}
    for p in problems:
        msg = [{"role": "user", "content":
                "Complete this Python function. Return ONLY the full function in a ```python code block.\n\n"
                + p["prompt"]}]
        text = tok.apply_chat_template(msg, tokenize=False, add_generation_prompt=True)
        ids = tok(text, return_tensors="pt").to(model.device)
        with torch.no_grad():
            gen = model.generate(**ids, max_new_tokens=max_new, do_sample=False,
                                 pad_token_id=tok.eos_token_id)
        comp = tok.decode(gen[0, ids["input_ids"].shape[1]:], skip_special_tokens=True)
        cand = extract_code(comp, p["prompt"], p["entry_point"])
        ok, why = run_test(cand, p["test"], p["entry_point"])
        passed += int(ok)
        if not ok:
            fails[why] = fails.get(why, 0) + 1
    return passed, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-7B-Instruct")
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--iters", type=int, default=8)
    a = ap.parse_args()

    print(f"[ptqtp-code] loading {a.model} ...", flush=True)
    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        a.model, trust_remote_code=True, torch_dtype=torch.float16, device_map="cuda")
    model.eval()
    ds = load_dataset("openai_humaneval", split="test")
    problems = [ds[i] for i in range(a.n)]

    print(f"[ptqtp-code] HumanEval n={a.n} @ FP16 ...", flush=True)
    t0 = time.time()
    fp16_pass, fp16_fails = run_humaneval(model, tok, problems)
    fp16_s = time.time() - t0
    print(f"  FP16 pass@1 = {fp16_pass}/{a.n} ({fp16_pass/a.n:.3f})  fails={fp16_fails}  {fp16_s:.0f}s", flush=True)

    print("[ptqtp-code] PTQTP-quantizing all linears ...", flush=True)
    tq = time.time()
    for name, mod in model.named_modules():
        if isinstance(mod, nn.Linear) and "lm_head" not in name:
            rec, _ = ptqtp_matrix(mod.weight.data, 128, a.iters)
            mod.weight.data.copy_(rec)
    print(f"  quantized in {time.time()-tq:.0f}s", flush=True)

    print(f"[ptqtp-code] HumanEval n={a.n} @ PTQTP ...", flush=True)
    t1 = time.time()
    pq_pass, pq_fails = run_humaneval(model, tok, problems)
    pq_s = time.time() - t1
    print(f"  PTQTP pass@1 = {pq_pass}/{a.n} ({pq_pass/a.n:.3f})  fails={pq_fails}  {pq_s:.0f}s", flush=True)

    report = {
        "task": "PTQTP coding-capability check: HumanEval FP16 vs PTQTP (#2206)",
        "model": a.model, "n": a.n,
        "fp16_pass_at_1": round(fp16_pass / a.n, 3), "fp16_passed": fp16_pass, "fp16_fails": fp16_fails,
        "ptqtp_pass_at_1": round(pq_pass / a.n, 3), "ptqtp_passed": pq_pass, "ptqtp_fails": pq_fails,
        "delta_pass_at_1": round((pq_pass - fp16_pass) / a.n, 3),
        "verdict": ("coding capability PRESERVED under PTQTP (delta small vs FP16)"
                    if pq_pass >= fp16_pass - max(1, a.n // 10) else
                    "coding capability degraded under PTQTP"),
        "evidence_class": "MEASURED",
        "caveats": (f"n={a.n} (binomial noise), greedy, chat-format extraction; PTQTP weights are stored "
                    "DEQUANTIZED (fp16) so this measures quality only — the paper's 4.63x speed needs a "
                    "packed-ternary kernel (out of scope, see T-SAR #2207)."),
    }
    OUT = REPO / "data" / "sigma0" / "ptqtp_coding_report.json"
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[ptqtp-code] ===== RESULT =====")
    print(f"  FP16 {report['fp16_pass_at_1']} -> PTQTP {report['ptqtp_pass_at_1']} (delta {report['delta_pass_at_1']})")
    print(f"  VERDICT: {report['verdict']}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
