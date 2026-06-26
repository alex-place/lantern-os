#!/usr/bin/env python3
"""
lightning_eval_7b_vs_ouro.py — small/fast capacity check (#1199).

Runs HumanEval (a SMALL subset) for two BASE models on a Lightning L4 (bf16/fp16,
both fit in 24GB) to answer one question cheaply: does a 7B coder have materially
more raw capacity than Ouro-1.4B, justifying it as the distillation student?

Base-vs-base on purpose: it's the fast capacity signal and doesn't depend on the
in-flight adapter training. Uses a SEPARATE studio (ouro-eval) so it doesn't
collide with the train-both job running on ouro-training.

Usage:
  python scripts/lightning_eval_7b_vs_ouro.py                 # N=10, Qwen2.5-Coder-7B
  python scripts/lightning_eval_7b_vs_ouro.py --n 20 --model-b deepseek-ai/deepseek-coder-6.7b-instruct
  python scripts/lightning_dispatch.py poll --studio ouro-eval   # watch / get RESULT line
"""
import argparse
import json
import os
import sys
import tempfile

import lightning_dispatch as ld

EVAL_STUDIO = "ouro-eval"

REMOTE = r'''#!/usr/bin/env python3
import subprocess, sys, os, json

N       = {n}
MAX_NEW = {max_new}
MODEL_A = "ByteDance/Ouro-1.4B"
MODEL_B = "{model_b}"

subprocess.run([sys.executable, "-m", "pip", "install", "-q",
    "transformers>=4.57,<4.58", "peft>=0.10", "accelerate", "datasets",
    "scipy", "huggingface_hub"], check=True)

REPO = "/teamspace/studios/this_studio/lantern-os"
if not os.path.isdir(REPO):
    env = dict(os.environ); env["GIT_LFS_SKIP_SMUDGE"] = "1"
    subprocess.run(["git", "clone", "--depth", "1",
                    "https://github.com/alex-place/lantern-os", REPO], env=env, check=True)
os.chdir(REPO)
os.environ["HF_HOME"] = "/tmp/hf-cache"

def run_eval(label, model_id):
    print("=== eval", label, model_id, flush=True)
    p = subprocess.run(
        [sys.executable, "scripts/eval_humaneval_ouro.py",
         "--label", label, "--base-model", model_id, "--adapter", "",
         "--limit", str(N), "--max-new", str(MAX_NEW), "--ts", "0"],
        capture_output=True, text=True)
    sys.stdout.write(p.stdout[-1500:])
    if p.returncode != 0:
        sys.stdout.write("\nSTDERR:\n" + p.stderr[-1500:])
    sys.stdout.flush()
    for line in reversed(p.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{{") and '"pass@1"' in line:
            try:
                return json.loads(line)
            except Exception:
                pass
    return {{"label": label, "model": model_id, "error": "no summary", "rc": p.returncode}}

a = run_eval("ouro-1.4b-base", MODEL_A)
b = run_eval("coder-7b-base", MODEL_B)
print("RESULT " + json.dumps({{"a": a, "b": b}}), flush=True)
print(json.dumps({{"status": "done", "a_pass": a.get("pass@1"), "b_pass": b.get("pass@1"),
                  "model_b": MODEL_B, "n": N}}), flush=True)
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10, help="HumanEval problems (small=fast)")
    ap.add_argument("--max-new", type=int, default=256)
    ap.add_argument("--model-b", default="Qwen/Qwen2.5-Coder-7B-Instruct",
                    help="the 7B student candidate")
    ap.add_argument("--machine", default="L4")
    args = ap.parse_args()

    ld._check_auth()
    _, Machine = ld._sdk()
    mach = getattr(Machine, args.machine, None)
    if mach is None:
        print(json.dumps({"error": f"unknown machine {args.machine!r}"})); sys.exit(1)

    script = REMOTE.format(n=args.n, max_new=args.max_new, model_b=args.model_b)
    local = os.path.join(tempfile.gettempdir(), "ouro_eval_lightning.py")
    with open(local, "w", encoding="utf-8") as f:
        f.write(script)

    try:
        studio = ld._get_studio(EVAL_STUDIO)   # separate studio; create_ok=True
        if str(studio.status).lower() != "running":
            studio.start(mach)
        else:
            try: studio.switch_machine(mach)
            except Exception: pass
        remote_name = "ouro_eval_lightning.py"
        studio.upload_file(local, remote_name)
        # log to /tmp/train.log so `lightning_dispatch.py poll --studio ouro-eval` works.
        studio.run(f"nohup python {remote_name} > /tmp/train.log 2>&1 &")
        print(json.dumps({"status": "running", "studio": EVAL_STUDIO, "machine": args.machine,
                          "n": args.n, "model_b": args.model_b,
                          "poll": f"python scripts/lightning_dispatch.py poll --studio {EVAL_STUDIO}"}))
    except Exception as e:
        print(json.dumps({"error": str(e), "studio": EVAL_STUDIO})); sys.exit(1)


if __name__ == "__main__":
    main()
