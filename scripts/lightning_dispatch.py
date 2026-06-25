#!/usr/bin/env python3
"""
lightning_dispatch.py — programmatic Lightning AI Studio dispatch for Ouro training.

Auth env vars (set via [System.Environment]::SetEnvironmentVariable ... 'User'):
  LIGHTNING_USER_ID         — from lightning.ai → account settings → Keys → Programmatic Login
  LIGHTNING_API_KEY         — same page
  LIGHTNING_STUDIO_USER     — lightning.ai username that owns the teamspace (default: alexplace7)
  LIGHTNING_STUDIO_ORG      — lightning.ai org, OPTIONAL. Leave empty to resolve the teamspace
                               under the user (the default). Set only for an org-owned teamspace.
  LIGHTNING_STUDIO_TEAMSPACE — teamspace name (default: custom-ml-model-development-project —
                               the user-owned teamspace that holds the ouro-training studio)
  LIGHTNING_STUDIO_NAME     — studio to start (default: ouro-training)
  LIGHTNING_MACHINE         — GPU machine to run on (default: L4). MUST be a bf16-capable
                               (Ampere cc>=8.0 or newer) machine: train-qlora-ouro.py
                               requires bf16 (fp16 QLoRA on this reasoning LM overflows to
                               NaN). T4 (Turing, cc 7.5) has NO bf16 and is rejected. The
                               Lightning SDK exposes no "A10"; L4 (Ada, cc 8.9) is the
                               entry bf16 GPU, A100 the next step up. See issue #1171.

Usage:
  python scripts/lightning_dispatch.py dispatch --steps 600 --checkpoint-uri <uri> --hf-repo ouro-checkpoints
  python scripts/lightning_dispatch.py poll --studio ouro-training
  python scripts/lightning_dispatch.py stop --studio ouro-training
"""

import argparse
import json
import os
import sys
import tempfile


def _sdk():
    try:
        from lightning_sdk import Studio, Machine
        return Studio, Machine
    except ImportError:
        print(json.dumps({"error": "lightning_sdk_not_installed",
                          "fix": "pip install lightning-sdk"}))
        sys.exit(1)


def _check_auth():
    uid = os.environ.get("LIGHTNING_USER_ID")
    key = os.environ.get("LIGHTNING_API_KEY")
    if not uid or not key:
        print(json.dumps({
            "error": "missing_credentials",
            "required": ["LIGHTNING_USER_ID", "LIGHTNING_API_KEY"],
            "where": "lightning.ai → account settings → Keys → Programmatic Login",
        }))
        sys.exit(1)
    return uid, key


STUDIO_NAME      = os.environ.get("LIGHTNING_STUDIO_NAME",      "ouro-training")
STUDIO_USER      = os.environ.get("LIGHTNING_STUDIO_USER",      "alexplace7")
STUDIO_ORG       = os.environ.get("LIGHTNING_STUDIO_ORG",       "")
STUDIO_TEAMSPACE = os.environ.get("LIGHTNING_STUDIO_TEAMSPACE", "custom-ml-model-development-project")

# Default to L4 — the cheapest bf16-capable GPU in the Lightning catalog (Ada
# Lovelace, cc 8.9). The recipe needs bf16; T4 (Turing, cc 7.5) has none and
# bakes a NaN adapter (#1171). "A10" is not a Lightning SDK machine name.
STUDIO_MACHINE   = os.environ.get("LIGHTNING_MACHINE",         "L4")

# Machines WITHOUT native bf16 (pre-Ampere). Refuse to dispatch onto these for the
# Ouro recipe — a fp16 QLoRA run silently produces a garbage (NaN) adapter.
NON_BF16_MACHINES = {"T4", "T4_SMALL", "T4_X_2", "T4_X_4", "T4_X_8"}


def _resolve_machine(Machine):
    """Resolve LIGHTNING_MACHINE to a Machine enum value, refusing non-bf16 GPUs.

    Returns (machine, error_dict). On success error_dict is None. The caller
    prints the error and exits so the JS dispatcher logs a real failure instead
    of training a NaN adapter on the wrong hardware."""
    name = (STUDIO_MACHINE or "").strip().upper()
    if name in NON_BF16_MACHINES:
        return None, {
            "error": "non_bf16_machine",
            "machine": name,
            "message": (f"{name} has no native bf16 (pre-Ampere); the Ouro QLoRA recipe "
                        f"requires bf16. Set LIGHTNING_MACHINE to a bf16 GPU (e.g. L4, A100)."),
        }
    machine = getattr(Machine, name, None)
    if machine is None:
        return None, {
            "error": "unknown_machine",
            "machine": name,
            "message": (f"'{name}' is not a Lightning SDK Machine. Use a bf16-capable name "
                        f"such as L4 or A100 (note: there is no 'A10')."),
        }
    return machine, None


def _get_studio(name=None):
    # Resolve the studio under its owner. The teamspace is user-owned
    # (lightning.ai/<user>/<teamspace>), so pass `user=` by default; only pass
    # `org=` when an org-owned teamspace is explicitly configured. Passing org=""
    # to the SDK makes it unable to infer the owner ("Neither name is provided nor
    # can the user be inferred ..."), which is what broke dispatch under #1079.
    Studio, _ = _sdk()
    kwargs = {"name": name or STUDIO_NAME, "teamspace": STUDIO_TEAMSPACE, "create_ok": True}
    if STUDIO_ORG:
        kwargs["org"] = STUDIO_ORG
    else:
        kwargs["user"] = STUDIO_USER
    return Studio(**kwargs)


TRAIN_SCRIPT = """#!/usr/bin/env python3
# Auto-generated by training-dispatcher
import subprocess, sys, json, os

HF_REPO = "{hf_repo}"
CHECKPOINT_FILE = "{checkpoint_file}"
STEPS = {steps}

# Pin transformers 4.57.x: Ouro-1.4B's custom modeling code imports
# layer_type_validation (added in 4.54+), so the old <4.53 pin made model load
# fail with ImportError. train-qlora-ouro.py restores ROPE_INIT_FUNCTIONS['default']
# (dropped in 4.53+, what the old pin avoided), so the bump is safe. This installs
# into the shared env that the train-qlora-ouro.py subprocess below inherits.
subprocess.run([sys.executable, "-m", "pip", "install", "-q",
                "transformers>=4.57,<4.58", "peft>=0.10", "bitsandbytes>=0.43",
                "datasets", "accelerate", "scipy", "huggingface_hub", "zstandard"],
               check=True)

# Clone lantern-os for training script + data (skip LFS blobs — budget exceeded)
REPO = "/tmp/lantern-os"
if not os.path.exists(REPO):
    clone_env = {{**os.environ, "GIT_LFS_SKIP_SMUDGE": "1"}}
    subprocess.run(["git", "clone", "--depth", "1",
                    "https://github.com/alex-place/lantern-os", REPO],
                   env=clone_env, check=True)
os.chdir(REPO)
sys.path.insert(0, os.path.join(REPO, "src"))

import csf
from huggingface_hub import hf_hub_download, upload_file

if CHECKPOINT_FILE:
    local_csf = hf_hub_download(repo_id=HF_REPO, filename=CHECKPOINT_FILE, repo_type="model")
    csf.unpack(local_csf, "/tmp/checkpoint")
    resume_arg = ["--resume_from", "/tmp/checkpoint"]
else:
    resume_arg = []

train_env = {{**os.environ, "HF_HOME": "/tmp/hf-cache"}}
subprocess.run(
    [sys.executable, "scripts/train-qlora-ouro.py",
     "--base", "ByteDance/Ouro-1.4B",
     "--data", "models/lantern-sigma0-coder/training-data.jsonl",
     "--out", "/tmp/output",
     "--max-steps", str(STEPS),
     "--seq", "1536",
     *resume_arg],
    check=True, env=train_env
)

manifest = csf.pack(["/tmp/output"], "/tmp/output.csf")
upload_file(path_or_fileobj="/tmp/output.csf", path_in_repo="output.csf",
            repo_id=HF_REPO, repo_type="model")
print(json.dumps({{"status": "done", "steps": STEPS,
                   "sha256": manifest.get("footer_sha256")}}))
"""


def cmd_dispatch(args):
    _check_auth()
    _, Machine = _sdk()

    machine, mach_err = _resolve_machine(Machine)
    if mach_err:
        print(json.dumps(mach_err))
        sys.exit(1)

    hf_repo = args.hf_repo or os.environ.get("HF_TRAINING_REPO", "ouro-checkpoints")
    checkpoint_uri = args.checkpoint_uri or ""
    checkpoint_file = os.path.basename(checkpoint_uri) if checkpoint_uri else ""
    steps = args.steps

    script_content = TRAIN_SCRIPT.format(
        hf_repo=hf_repo, checkpoint_file=checkpoint_file, steps=steps)
    script_path = os.path.join(tempfile.gettempdir(), "ouro_train_lightning.py")
    # Always write UTF-8: on a Windows dispatch client the default text encoding is
    # cp1252, which turns the em-dash in the script's comments into a lone \x97 byte
    # that the studio's Python 3 rejects ("Non-UTF-8 code ... no encoding declared").
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(script_content)

    try:
        studio = _get_studio()
        status = studio.status
        if str(status).lower() not in ("running",):
            studio.start(machine)
        else:
            try:
                studio.switch_machine(machine)
            except Exception:
                pass  # already on the requested machine
        # Upload to a BARE filename (no directory). studio.run() executes in the
        # studio working dir (/teamspace/studios/this_studio) and upload_file places
        # the file there too. An absolute remote path like "/home/zeus/..." gets
        # mangled by a Windows client's os.path into a single backslash-named file in
        # the cwd, so the run command never found it — keep the path slash-free.
        remote_name = "ouro_train_lightning.py"
        studio.upload_file(script_path, remote_name)
        studio.run(f"nohup python {remote_name} > /tmp/train.log 2>&1 &")
        result = {
            "status": "running", "studio": STUDIO_NAME, "machine": STUDIO_MACHINE,
            "steps": steps, "checkpoint_uri": checkpoint_uri,
            "log_path": "/tmp/train.log",
        }
    except Exception as e:
        result = {"error": str(e), "studio": STUDIO_NAME}

    print(json.dumps(result))


def cmd_poll(args):
    _check_auth()
    try:
        studio = _get_studio(args.studio)
        last_line = None
        try:
            raw = studio.run("tail -1 /tmp/train.log 2>/dev/null || echo ''")
            last_line = (raw or "").strip()
        except Exception:
            pass
        done = last_line and '"status": "done"' in last_line
        result = {
            "studio": args.studio,
            "studio_status": str(studio.status),
            "status": "done" if done else "running",
            "last_log_line": last_line,
        }
    except Exception as e:
        result = {"error": str(e), "studio": args.studio}

    print(json.dumps(result))


def cmd_stop(args):
    _check_auth()
    try:
        studio = _get_studio(args.studio)
        studio.stop()
        result = {"status": "stopped", "studio": args.studio}
    except Exception as e:
        result = {"error": str(e), "studio": args.studio}

    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description="Lightning AI dispatch for Ouro training")
    sub = parser.add_subparsers(dest="command")

    p_dispatch = sub.add_parser("dispatch")
    p_dispatch.add_argument("--steps", type=int, default=600)
    p_dispatch.add_argument("--checkpoint-uri", default="")
    p_dispatch.add_argument("--hf-repo", default="")

    p_poll = sub.add_parser("poll")
    p_poll.add_argument("--studio", default=STUDIO_NAME)

    p_stop = sub.add_parser("stop")
    p_stop.add_argument("--studio", default=STUDIO_NAME)

    args = parser.parse_args()
    if args.command == "dispatch":
        cmd_dispatch(args)
    elif args.command == "poll":
        cmd_poll(args)
    elif args.command == "stop":
        cmd_stop(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
