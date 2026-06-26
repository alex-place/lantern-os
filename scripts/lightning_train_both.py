#!/usr/bin/env python3
"""
lightning_train_both.py — one-shot Lightning AI dispatch that trains BOTH Ouro
adapters on an Ampere GPU and pushes each as a folder to the public HF repo.

Unlike scripts/lightning_dispatch.py (the weekly continual-training path, which
trains one adapter and uploads a resumable output.csf), this trains:
  - coding-adapter/     (Σ₀ session coding data)
  - capability-adapter/ (coding + Hermes FC positives + xLAM negatives)
and pushes both to lanternfounder/ouro-checkpoints, mirroring
notebooks/ouro_train_both_adapters.ipynb.

It reuses the studio/teamspace resolution from lightning_dispatch so the auth
defaults (user alexplace7, teamspace custom-ml-model-development-project, studio
ouro-training) stay in one place.

Usage:
  python scripts/lightning_train_both.py            # dispatch on L4 (bf16)
  python scripts/lightning_train_both.py --machine A100
  python scripts/lightning_dispatch.py poll --studio ouro-training   # watch it
"""
import argparse
import json
import os
import sys
import tempfile

# reuse the studio plumbing (auth, teamspace/owner resolution, SDK import)
import lightning_dispatch as ld

HF_REPO = os.environ.get("HF_TRAINING_REPO_FULL", "lanternfounder/ouro-checkpoints")

# Runs ON the Lightning studio. bf16 is gated arch-aware inside train-qlora-ouro.py
# (cc>=8.0); L4 (cc 8.9) / A100 (cc 8.0) qualify, so no NaN-prone fp16 fallback.
REMOTE = r'''#!/usr/bin/env python3
import subprocess, sys, os, json, pathlib
HF_REPO = "{hf_repo}"
STEPS   = {steps}
BASE    = "ByteDance/Ouro-1.4B"
SEQ, LORA_R, EPOCHS = 1536, 32, 3

subprocess.run([sys.executable, "-m", "pip", "install", "-q",
    "transformers>=4.57,<4.58", "peft>=0.10", "bitsandbytes>=0.43",
    "datasets", "accelerate", "scipy", "huggingface_hub", "zstandard"], check=True)

REPO = "/teamspace/studios/this_studio/lantern-os"
if not os.path.isdir(REPO):
    env = dict(os.environ); env["GIT_LFS_SKIP_SMUDGE"] = "1"
    subprocess.run(["git", "clone", "--depth", "1",
                    "https://github.com/alex-place/lantern-os", REPO], env=env, check=True)
os.chdir(REPO)
os.environ["HF_HOME"] = "/tmp/hf-cache"

from huggingface_hub import login, upload_folder, upload_file
login(token=os.environ["HF_TOKEN"])

M = "models/lantern-sigma0-coder"
def merge(srcs, out):
    n = 0
    with open(out, "w", encoding="utf-8") as f:
        for s in srcs:
            for line in pathlib.Path(s).read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line: continue
                try: json.loads(line)
                except Exception: continue
                f.write(line + "\n"); n += 1
    print("built", out, "rows", n); return out

coding = M + "/training-data.jsonl"
capability = merge([M + "/training-data.jsonl", M + "/fc-hermes.jsonl", M + "/fc-negatives.jsonl"],
                   "/tmp/capability.jsonl")

def train(data, out):
    args = [sys.executable, "scripts/train-qlora-ouro.py", "--base", BASE, "--data", data,
            "--out", out, "--seq", str(SEQ), "--lora-r", str(LORA_R), "--epochs", str(EPOCHS)]
    if STEPS > 0: args += ["--max-steps", str(STEPS)]
    print("TRAIN:", " ".join(args), flush=True)
    subprocess.run(args, check=True)
    final = os.path.join(out, "final")
    return final if os.path.isdir(final) else out

ca = train(coding, "/tmp/out-coding")
upload_folder(folder_path=ca, path_in_repo="coding-adapter", repo_id=HF_REPO,
              repo_type="model", commit_message="coding adapter (lightning)")
print(json.dumps({{"adapter": "coding-adapter", "status": "pushed"}}), flush=True)

pa = train(capability, "/tmp/out-capability")
upload_folder(folder_path=pa, path_in_repo="capability-adapter", repo_id=HF_REPO,
              repo_type="model", commit_message="capability adapter (lightning)")

card = ("---\nlicense: apache-2.0\nbase_model: ByteDance/Ouro-1.4B\nlibrary_name: peft\n"
        "tags: [lora, qlora, ouro, sigma0, lantern-os]\n---\n"
        "# Ouro-1.4B Σ₀ adapters\n\n"
        "- `coding-adapter/` — Σ₀ coding adapter (Claude-session coding data).\n"
        "- `capability-adapter/` — coding + function-calling positives (Hermes) + irrelevance negatives (xLAM).\n\n"
        "Recipe: QLoRA r=32/α=64, seq 1536, 3 epochs, bf16. "
        "See https://github.com/alex-place/lantern-os (docs/SIGMA0-OURO-CODER.md).\n")
open("/tmp/README.md", "w").write(card)
upload_file(path_or_fileobj="/tmp/README.md", path_in_repo="README.md",
            repo_id=HF_REPO, repo_type="model", commit_message="model card")
print(json.dumps({{"status": "done", "adapters": ["coding-adapter", "capability-adapter"]}}), flush=True)
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=600, help="--max-steps per adapter (-1 = full epochs)")
    ap.add_argument("--machine", default="L4", help="Lightning Machine name (L4, A100, T4, ...)")
    args = ap.parse_args()

    ld._check_auth()
    _, Machine = ld._sdk()
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print(json.dumps({"error": "HF_TOKEN not set in dispatch environment"})); sys.exit(1)

    mach = getattr(Machine, args.machine, None)
    if mach is None:
        print(json.dumps({"error": f"unknown machine {args.machine!r}"})); sys.exit(1)

    script = REMOTE.format(hf_repo=HF_REPO, steps=args.steps)
    local = os.path.join(tempfile.gettempdir(), "ouro_train_both_lightning.py")
    with open(local, "w", encoding="utf-8") as f:
        f.write(script)

    try:
        studio = ld._get_studio()
        if str(studio.status).lower() != "running":
            studio.start(mach)
        else:
            try: studio.switch_machine(mach)
            except Exception: pass
        remote_name = "ouro_train_both_lightning.py"
        studio.upload_file(local, remote_name)
        # HF_TOKEN inlined so the studio can push; studio is private to the owner.
        studio.run(f"HF_TOKEN='{hf_token}' nohup python {remote_name} > /tmp/train.log 2>&1 &")
        print(json.dumps({"status": "running", "studio": ld.STUDIO_NAME, "machine": args.machine,
                          "hf_repo": HF_REPO, "log": "/tmp/train.log",
                          "poll": "python scripts/lightning_dispatch.py poll --studio ouro-training"}))
    except Exception as e:
        print(json.dumps({"error": str(e), "studio": ld.STUDIO_NAME}))
        sys.exit(1)


if __name__ == "__main__":
    main()
