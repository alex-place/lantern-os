"""
Measure the VTD lift: base Qwen2.5-Coder-0.5B vs base+adapter on HELD-OUT MBPP problems
(never in the training corpus), exec-verified pass@1. Same native chat template + name
tolerance as training/generation, so the comparison is apples-to-apples and honest.

    C:/dev/lantern-os/.venv-train/Scripts/python.exe scripts/eval_qwen_coder.py \
        --base Qwen/Qwen2.5-Coder-0.5B-Instruct \
        --adapter D:/lantern-train/qwen05-vtd/final \
        --data data/eval/mbpp-full.jsonl --offset 400 --limit 50
"""
import argparse
import json
import os
import re
import subprocess
import tempfile

if os.name == "nt":
    os.environ.setdefault("HF_HOME", "D:/hf-cache")


def extract_code(text):
    m = re.search(r"```(?:python|py)?\s*([\s\S]*?)```", text, re.I)
    return (m.group(1) if m else text).strip()


def alias_shim(entry):
    return (f"\ntry:\n    {entry}\nexcept NameError:\n    import types as _t\n"
            f"    _fns=[v for k,v in list(globals().items()) if isinstance(v,_t.FunctionType) and not k.startswith('_')]\n"
            f"    if len(_fns)==1:\n        globals()['{entry}']=_fns[0]\n")


def passes(code, tests, entry, timeout=10):
    body = code + alias_shim(entry) + "\n" + "\n".join(t["test"] for t in tests) + "\n"
    with tempfile.TemporaryDirectory() as d:
        fp = os.path.join(d, "case.py")
        with open(fp, "w", encoding="utf-8") as f:
            f.write(body)
        try:
            subprocess.run(["python", fp], cwd=d, timeout=timeout, capture_output=True,
                           check=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            return True
        except Exception:
            return False


def eval_model(model, tok, problems, max_new=400):
    import torch
    solved = []
    for p in problems:
        prompt = f"{p['prompt']}\n(The function must be named EXACTLY `{p['entry_point']}`.) Reply with ONLY a Python code block."
        text = tok.apply_chat_template([{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True)
        ids = tok(text, return_tensors="pt").to(model.device)
        with torch.no_grad():
            out = model.generate(**ids, max_new_tokens=max_new, do_sample=False,
                                  pad_token_id=tok.pad_token_id or tok.eos_token_id)
        gen = tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)
        ok = passes(extract_code(gen), p["tests"], p["entry_point"])
        solved.append(ok)
    return solved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="Qwen/Qwen2.5-Coder-0.5B-Instruct")
    ap.add_argument("--adapter", default=None)
    ap.add_argument("--data", default="data/eval/mbpp-full.jsonl")
    ap.add_argument("--offset", type=int, default=400)
    ap.add_argument("--limit", type=int, default=50)
    a = ap.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    with open(a.data, encoding="utf-8") as f:
        allp = [json.loads(l) for l in f if l.strip()]
    problems = allp[a.offset:a.offset + a.limit]
    print(f"HELD-OUT eval: {len(problems)} MBPP problems [{a.offset}..{a.offset + len(problems)}]")

    tok = AutoTokenizer.from_pretrained(a.base, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    dtype = torch.bfloat16 if (torch.cuda.is_available() and torch.cuda.is_bf16_supported()) else torch.float16
    base = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=dtype, device_map="auto", trust_remote_code=True)
    base.train(False)

    base_res = eval_model(base, tok, problems)
    base_pass = sum(base_res)
    print(f"\nBASE  {a.base}: pass@1 = {base_pass}/{len(problems)} = {base_pass / len(problems):.2f}")

    if a.adapter:
        from peft import PeftModel
        adapted = PeftModel.from_pretrained(base, a.adapter)
        adapted.train(False)
        adp_res = eval_model(adapted, tok, problems)
        adp_pass = sum(adp_res)
        print(f"+VTD  {a.adapter}: pass@1 = {adp_pass}/{len(problems)} = {adp_pass / len(problems):.2f}")
        fixed = [problems[i]["id"] for i in range(len(problems)) if adp_res[i] and not base_res[i]]
        broke = [problems[i]["id"] for i in range(len(problems)) if base_res[i] and not adp_res[i]]
        print(f"\nDELTA: {adp_pass - base_pass:+d}   fixed by VTD: {fixed}   regressed: {broke}")
        print("=> VTD LIFTED the tiny model on held-out." if adp_pass > base_pass
              else "=> no net lift (honest null/negative — report it).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
