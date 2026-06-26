#!/usr/bin/env python3
"""
lightning_train_sigma0.py — make the FIRST Σ₀ Convergence adapter on Qwen-7B (#1207/#1208).

One self-contained Lightning run that:
  1. pulls MBPP (a TRAIN set with test asserts — distinct from HumanEval, which we must
     NOT train on to avoid contaminating our eval),
  2. distills VERIFY-GATED Σ₀ traces from a frontier teacher (scripts/gen_sigma0_traces.py):
     the teacher solves under the Σ₀ prompt and the code must pass the asserts to be kept,
  3. merges with the curated coding pairs,
  4. trains Qwen2.5-Coder-7B QLoRA on the result,
  5. pushes the adapter to HF (lanternfounder/ouro-checkpoints/<subfolder>).

Adapters are base-specific: this produces a Qwen adapter (the Ouro LoRA cannot load on Qwen).
Eval it with scripts/eval_sigma0_adapter.py before promoting (the #1208 gate).

Usage:
  python scripts/lightning_train_sigma0.py            # 300 traces, 400 steps, L4
  python scripts/lightning_dispatch.py poll --studio sigma0-train
"""
import argparse
import json
import os
import sys
import tempfile

import lightning_dispatch as ld

STUDIO = "sigma0-train"
HF_REPO = "lanternfounder/ouro-checkpoints"

REMOTE = r'''#!/usr/bin/env python3
import subprocess, sys, os, json, re, pathlib

N_TRACES  = {n_traces}
STEPS     = {steps}
TEACHER   = "{teacher}"
HF_REPO   = "{hf_repo}"
SUBFOLDER = "{subfolder}"
BASE      = "Qwen/Qwen2.5-Coder-7B-Instruct"

subprocess.run([sys.executable, "-m", "pip", "install", "-q",
    "transformers>=4.57,<4.58", "peft>=0.10", "bitsandbytes>=0.43", "datasets",
    "accelerate", "scipy", "huggingface_hub", "requests"], check=True)

REPO = "/teamspace/studios/this_studio/lantern-os"
if not os.path.isdir(REPO):
    env = dict(os.environ); env["GIT_LFS_SKIP_SMUDGE"] = "1"
    subprocess.run(["git", "clone", "--depth", "1",
                    "https://github.com/alex-place/lantern-os", REPO], env=env, check=True)
os.chdir(REPO); os.environ["HF_HOME"] = "/tmp/hf-cache"

# 1) MBPP -> tasks.jsonl {{instruction, asserts, fn}}
from datasets import load_dataset
ds = load_dataset("mbpp", split="train")
tasks_path = "/tmp/mbpp-tasks.jsonl"
nt = 0
with open(tasks_path, "w", encoding="utf-8") as f:
    for r in ds:
        tests = r.get("test_list") or []
        if not tests:
            continue
        m = re.search(r"assert\s+(\w+)\s*\(", tests[0])
        fn = m.group(1) if m else ""
        f.write(json.dumps({{"instruction": r["text"].strip(),
                             "asserts": "\n".join(tests), "fn": fn}}) + "\n")
        nt += 1
print("mbpp tasks:", nt, flush=True)

# 2) verify-gated Σ₀ trace distillation (teacher solves; asserts must pass)
subprocess.run([sys.executable, "scripts/gen_sigma0_traces.py",
    "--tasks", tasks_path, "--out", "data/distill/sigma0-traces.jsonl",
    "--teacher", TEACHER, "--limit", str(N_TRACES)], check=True)

# 3) merge curated pairs + verified Σ₀ traces (dedup by output)
def lines(p):
    pp = pathlib.Path(p)
    return [l for l in (pp.read_text(encoding="utf-8").splitlines() if pp.exists() else []) if l.strip()]
combined = "/tmp/sigma0-combined.jsonl"
seen, n = set(), 0
with open(combined, "w", encoding="utf-8") as out:
    for src in ["models/lantern-sigma0-coder/training-data.jsonl", "data/distill/sigma0-traces.jsonl"]:
        for ln in lines(src):
            try: d = json.loads(ln)
            except Exception: continue
            o = (d.get("output") or "").strip()
            if not d.get("instruction") or not o or o in seen:
                continue
            seen.add(o)
            out.write(json.dumps({{"instruction": d["instruction"], "input": d.get("input", ""),
                                   "output": d["output"]}}) + "\n"); n += 1
print("combined rows:", n, flush=True)
if n < 50:
    print(json.dumps({{"status": "error", "why": "too few training rows", "rows": n}})); sys.exit(1)

# 4) train Qwen-7B QLoRA
subprocess.run([sys.executable, "scripts/train-qlora-ouro.py",
    "--base", BASE, "--data", combined, "--out", "/tmp/out",
    "--seq", "1536", "--lora-r", "32", "--epochs", "3", "--max-steps", str(STEPS)], check=True)

# 5) push adapter
from huggingface_hub import login, upload_folder
login(token=os.environ["HF_TOKEN"])
final = "/tmp/out/final" if os.path.isdir("/tmp/out/final") else "/tmp/out"
upload_folder(folder_path=final, path_in_repo=SUBFOLDER, repo_id=HF_REPO,
              repo_type="model", commit_message="Sigma0 Qwen-7B coder adapter (#1207)")
print(json.dumps({{"status": "done", "adapter": SUBFOLDER, "combined_rows": n}}), flush=True)
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-traces", type=int, default=300, help="verify-gated Σ₀ traces to mint")
    ap.add_argument("--steps", type=int, default=400, help="--max-steps cap")
    ap.add_argument("--teacher", default="claude-opus-4-8")
    ap.add_argument("--subfolder", default="sigma0-qwen-coder-adapter")
    ap.add_argument("--machine", default="L4")
    args = ap.parse_args()

    ld._check_auth()
    _, Machine = ld._sdk()
    for need in ("HF_TOKEN", "ANTHROPIC_API_KEY"):
        if not os.environ.get(need):
            print(json.dumps({"error": f"{need} not set in dispatch env"})); sys.exit(1)
    mach = getattr(Machine, args.machine, None)
    if mach is None:
        print(json.dumps({"error": f"unknown machine {args.machine!r}"})); sys.exit(1)

    script = REMOTE.format(n_traces=args.n_traces, steps=args.steps, teacher=args.teacher,
                           hf_repo=HF_REPO, subfolder=args.subfolder)
    local = os.path.join(tempfile.gettempdir(), "sigma0_train_lightning.py")
    with open(local, "w", encoding="utf-8") as f:
        f.write(script)

    try:
        studio = ld._get_studio(STUDIO)
        if str(studio.status).lower() != "running":
            studio.start(mach)
        else:
            try: studio.switch_machine(mach)
            except Exception: pass
        studio.upload_file(local, "sigma0_train_lightning.py")
        env_prefix = (f"HF_TOKEN='{os.environ['HF_TOKEN']}' "
                      f"ANTHROPIC_API_KEY='{os.environ['ANTHROPIC_API_KEY']}' ")
        studio.run(f"{env_prefix}nohup python sigma0_train_lightning.py > /tmp/train.log 2>&1 &")
        print(json.dumps({"status": "running", "studio": STUDIO, "machine": args.machine,
                          "n_traces": args.n_traces, "steps": args.steps,
                          "hf": f"{HF_REPO}/{args.subfolder}",
                          "poll": f"python scripts/lightning_dispatch.py poll --studio {STUDIO}"}))
    except Exception as e:
        print(json.dumps({"error": str(e), "studio": STUDIO})); sys.exit(1)


if __name__ == "__main__":
    main()
