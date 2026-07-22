#!/usr/bin/env python3
"""
modal_dispatch.py — programmatic Modal (modal.com) dispatch for Ouro training.

The Modal twin of scripts/lightning_dispatch.py: same CLI contract (dispatch /
poll / stop, each prints one JSON line) so lib/training-dispatcher.js can drive
it identically. Modal is serverless — instead of a persistent Studio we spawn a
detached function-call on an L4 worker and poll it by its call id.

Why a second provider at all: the GPU-training orchestration fans out to every
`automatable` provider at once (dispatchAllAutomatable), so registering Modal
alongside Lightning makes one "dispatch-all" run the SAME job on two independent
clouds concurrently — redundancy against a preemption / driver break on either,
plus a free reproducibility cross-check (both are seeded). See
docs/SIGMA0-EB-L4-RUNBOOK.md §"Dual-provider redundant execution".

Auth env (set User-scope, same mechanism as the Lightning keys):
  MODAL_TOKEN_ID, MODAL_TOKEN_SECRET  — modal.com → Settings → API Tokens
  HF_TOKEN / HF_TRAINING_REPO         — checkpoint transport out of the worker
  MODAL_GPU                           — GPU type (default L4; must be bf16-capable,
                                        same constraint as Lightning — the Ouro QLoRA
                                        recipe NaNs in fp16 on pre-Ampere silicon)

Usage:
  python scripts/modal_dispatch.py dispatch --steps 600 --checkpoint-uri <uri> --hf-repo ouro-checkpoints
  python scripts/modal_dispatch.py poll --job-id <function_call_id>
  python scripts/modal_dispatch.py stop --job-id <function_call_id>
"""

import argparse
import json
import os
import sys

# modal is imported at module scope because @app.function MUST decorate a global-scope
# function (Modal rejects nested-scope decoration). Guarded so `--help` and a
# missing-install still emit a clean JSON error instead of an ImportError traceback.
try:
    import modal
except ImportError:
    modal = None

APP_NAME = os.environ.get("MODAL_APP_NAME", "ouro-training")
GPU = os.environ.get("MODAL_GPU", "L4")
# GPUs without native bf16 (pre-Ampere) — refused, exactly as lightning_dispatch does:
# fp16 QLoRA on this reasoning LM overflows to a NaN adapter. L4 (Ada, cc 8.9) is the
# cheapest bf16 Modal GPU; A10G / A100 / H100 also qualify. T4 does not.
NON_BF16_GPUS = {"T4"}


def _modal():
    if modal is None:
        print(json.dumps({"error": "modal_not_installed", "fix": "pip install modal"}))
        sys.exit(1)
    return modal


def _check_auth():
    if not os.environ.get("MODAL_TOKEN_ID") or not os.environ.get("MODAL_TOKEN_SECRET"):
        print(json.dumps({
            "error": "missing_credentials",
            "required": ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
            "where": "modal.com → Settings → API Tokens",
        }))
        sys.exit(1)


def _check_gpu():
    name = (GPU or "").strip().upper().split(":")[0]  # "L4:2" -> "L4"
    if name in NON_BF16_GPUS:
        print(json.dumps({
            "error": "non_bf16_gpu", "gpu": name,
            "message": (f"{name} has no native bf16; the Ouro QLoRA recipe needs bf16. "
                        f"Set MODAL_GPU to a bf16 GPU (L4, A10G, A100, H100)."),
        }))
        sys.exit(1)


# The training body — byte-for-byte the same steps as lightning_dispatch.TRAIN_SCRIPT
# (clone repo, QLoRA fine-tune train-qlora-ouro.py, CSF-pack, upload to HF), so the
# two providers run the identical job. Deps are baked into the image (below), not
# pip-installed at runtime, so cold starts are fast and the environment is pinned.
def _train_body(steps: int, hf_repo: str, checkpoint_file: str, repo_ref: str = "master") -> dict:
    import json as _json
    import os as _os
    import subprocess
    import sys as _sys

    def _run_logged(cmd, tag, env=None):
        """Run a subprocess capturing output; ALWAYS print the tail (so `modal app logs`
        shows it) and raise with the tail on failure. The first E-B dispatches died with an
        opaque 'signal 6' because output wasn't captured — never again."""
        print(f"[{tag}] $ {' '.join(cmd)}", flush=True)
        p = subprocess.run(cmd, env=env, capture_output=True, text=True)
        tail = ((p.stdout or "")[-2000:] + "\n--- stderr ---\n" + (p.stderr or "")[-4000:])
        print(f"[{tag}] exit={p.returncode}\n{tail}", flush=True)
        if p.returncode != 0:
            raise RuntimeError(f"{tag} failed (exit {p.returncode}); tail:\n{tail[-1500:]}")
        return p

    repo = "/root/lantern-os"
    if not _os.path.exists(repo):
        clone_env = {**_os.environ, "GIT_LFS_SKIP_SMUDGE": "1"}
        # -b <ref>: train from a branch when its data/scripts haven't merged yet.
        _run_logged(["git", "clone", "--depth", "1", "-b", repo_ref,
                     "https://github.com/alex-place/lantern-os", repo],
                    "clone", env=clone_env)
    _os.chdir(repo)
    _sys.path.insert(0, _os.path.join(repo, "src"))

    # Ouro's custom modeling looks up ROPE_INIT_FUNCTIONS['default'] (dropped in
    # transformers>=4.53); restore it before the model loads. Mirrors the guard in
    # train-qlora-ouro.py and the Kaggle/Lightning dispatch bodies.
    try:
        from transformers.modeling_rope_utils import ROPE_INIT_FUNCTIONS
        if "default" not in ROPE_INIT_FUNCTIONS:
            from transformers.modeling_rope_utils import _compute_default_rope_parameters
            ROPE_INIT_FUNCTIONS["default"] = _compute_default_rope_parameters
    except Exception:
        pass

    import csf
    from huggingface_hub import hf_hub_download, upload_file

    resume_arg = []
    if checkpoint_file:
        local_csf = hf_hub_download(repo_id=hf_repo, filename=checkpoint_file, repo_type="model")
        csf.unpack(local_csf, "/root/checkpoint")
        resume_arg = ["--resume", "/root/checkpoint"]  # trainer arg is --resume (not --resume_from; #2535 class)

    # Ensure real SFT data exists — the old models/lantern-sigma0-coder/training-data.jsonl
    # path was never in the repo. Prep it from open datasets (the worker has egress) if absent.
    data_path = _os.environ.get("OURO_TRAIN_DATA", "data/eval/distill.jsonl")
    if not _os.path.exists(data_path):
        _run_logged([_sys.executable, "scripts/eb_prep_corpus.py", "--allow-download",
                     "--distill-n", "2000", "--rlvr-n", "1000"], "prep")
    train_env = {**_os.environ, "HF_HOME": "/root/hf-cache"}
    _run_logged(
        [_sys.executable, "scripts/train-qlora-ouro.py",
         "--base", "ByteDance/Ouro-1.4B",
         "--data", data_path,
         "--out", "/root/output",
         "--epochs", "3",            # #2729: 3 epochs WITH best-checkpoint selection, not a fixed 600
         "--max-steps", str(steps),  # -1 (default) => use epochs; pass >0 only for a smoke test
         "--seq", "1536",
         *resume_arg],
        "train", env=train_env,
    )

    manifest = csf.pack(["/root/output"], "/root/output.csf")
    token = _os.environ.get("HF_TOKEN") or _os.environ.get("HUGGINGFACE_TOKEN")
    uploaded = False
    # Namespace the artifact by provider — Lightning uploads "output.csf"; a concurrent
    # dual-provider run must NOT clobber it. This keeps both twins' adapters for the
    # cross-check (reconcile via scripts/reconcile_dual_provider.py).
    remote_name = "output.modal.csf"
    if token:
        upload_file(path_or_fileobj="/root/output.csf", path_in_repo=remote_name,
                    repo_id=hf_repo, repo_type="model", token=token)
        uploaded = True
    return {"status": "done", "steps": steps, "provider": "modal", "artifact": remote_name,
            "sha256": manifest.get("footer_sha256"), "uploaded_to_hf": uploaded}


# ── module-scope Modal app / image / function (required: @app.function must be global) ──
# Deps pinned in the image (transformers 4.57.x for Ouro's custom loop; bitsandbytes for
# 4-bit QLoRA; scipy for the Σ_θ gate legs). Built once and cached by Modal, keyed on this
# dependency set. Defined only when modal is importable so `--help` still works without it.
if modal is not None:
    _image = (
        modal.Image.debian_slim(python_version="3.11")
        .apt_install("git")
        .pip_install(
            "torch", "transformers>=4.57,<4.58", "peft>=0.10", "bitsandbytes>=0.43",
            "datasets", "accelerate", "scipy", "huggingface_hub", "zstandard",
        )
    )
    app = modal.App(APP_NAME)
    _secret = modal.Secret.from_dict({
        "HF_TOKEN": os.environ.get("HF_TOKEN", ""),
        "HUGGINGFACE_TOKEN": os.environ.get("HF_TOKEN", ""),
    })

    @app.function(gpu=GPU, image=_image, secrets=[_secret], timeout=24 * 60 * 60,
                  memory=32768)  # 32 GiB host RAM — datasets+torch import headroom
    def train(steps: int, hf_repo: str, checkpoint_file: str, repo_ref: str = "master") -> dict:
        return _train_body(steps, hf_repo, checkpoint_file, repo_ref)
else:
    app = None
    train = None


def cmd_dispatch(args):
    _check_auth()
    _check_gpu()
    _modal()  # exits cleanly if modal is unavailable
    hf_repo = args.hf_repo or os.environ.get("HF_TRAINING_REPO", "ouro-checkpoints")
    checkpoint_file = os.path.basename(args.checkpoint_uri) if args.checkpoint_uri else ""
    try:
        # Detached run: the spawned call keeps running on Modal after this client exits,
        # so the JS dispatcher can return immediately and poll by call id later.
        with app.run(detach=True):
            call = train.spawn(args.steps, hf_repo, checkpoint_file, args.repo_ref)
            job_id = call.object_id
        result = {"status": "running", "provider": "modal", "jobId": job_id,
                  "gpu": GPU, "steps": args.steps, "app": APP_NAME,
                  "checkpoint_uri": args.checkpoint_uri or "",
                  "dashboard": f"https://modal.com/apps/{APP_NAME}"}
    except Exception as e:  # noqa: BLE001 — surface any SDK/auth error as a logged failure
        result = {"error": "modal_dispatch_failed", "detail": str(e), "app": APP_NAME}
    print(json.dumps(result))


def cmd_poll(args):
    _check_auth()
    modal = _modal()
    try:
        fc = modal.FunctionCall.from_id(args.job_id)
        try:
            res = fc.get(timeout=0)
            result = {"provider": "modal", "jobId": args.job_id, "status": "done", "result": res}
        except TimeoutError:
            result = {"provider": "modal", "jobId": args.job_id, "status": "running"}
        except modal.exception.OutputExpiredError:
            # Completed long enough ago that Modal expired the output — treat as done.
            result = {"provider": "modal", "jobId": args.job_id, "status": "done",
                      "note": "output expired (completed earlier)"}
        except Exception as e:  # noqa: BLE001 — the function raised: a real failure
            result = {"provider": "modal", "jobId": args.job_id, "status": "failed",
                      "failureMessage": str(e)}
    except Exception as e:  # noqa: BLE001 — could not resolve the call id
        result = {"error": "modal_poll_failed", "jobId": args.job_id, "detail": str(e)}
    print(json.dumps(result))


def cmd_stop(args):
    _check_auth()
    modal = _modal()
    try:
        modal.FunctionCall.from_id(args.job_id).cancel()
        result = {"provider": "modal", "jobId": args.job_id, "status": "stopped"}
    except Exception as e:  # noqa: BLE001
        result = {"error": "modal_stop_failed", "jobId": args.job_id, "detail": str(e)}
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description="Modal dispatch for Ouro training")
    sub = parser.add_subparsers(dest="command")

    p_dispatch = sub.add_parser("dispatch")
    p_dispatch.add_argument("--steps", type=int, default=-1,
                            help="-1 (default) => train 3 epochs w/ best-checkpoint selection (#2729); "
                                 ">0 forces a fixed max-steps (smoke tests only)")
    p_dispatch.add_argument("--checkpoint-uri", default="")
    p_dispatch.add_argument("--hf-repo", default="")
    p_dispatch.add_argument("--repo-ref", default=os.environ.get("MODAL_REPO_REF", "master"),
                            help="git branch/ref the worker clones (data+scripts source)")

    p_poll = sub.add_parser("poll")
    p_poll.add_argument("--job-id", required=True)

    p_stop = sub.add_parser("stop")
    p_stop.add_argument("--job-id", required=True)

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
