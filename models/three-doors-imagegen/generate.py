#!/usr/bin/env python
"""
Three Doors local image generator — SD1.5 + LCM (4-step) + IP-Adapter, conditioned
on the canonical character reference art (data/lore/character-refs/*.jpg).

This is the on-box Phase-3/4 backend for the OSS image adapter (epic #1844). ComfyUI
is not installed here, but .venv-train already ships diffusers + CUDA torch, so the
local generator is a diffusers pipeline — model-agnostic by design (swap to Flux/SDXL
when those weights are fetched). IP-Adapter feeds the hand-drawn character canon in as
an image prompt so the generated scene inherits the character instead of drifting.

Everything except the IP-Adapter image encoder (auto-fetched once) runs from the local
HF cache, fully offline. Fits an 8GB RTX 3070.

Usage:
  python generate.py --char lantern --prompt "<scene>" --out data/images/x.png \
      --scale 0.6 --steps 4 --seed 42
"""
import argparse
import os
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CHAR_REFS = {
    "lantern": REPO / "data/lore/character-refs/lantern-canonical.jpg",
    "eclipse": REPO / "data/lore/character-refs/eclipse-canonical.jpg",
    "keystone": REPO / "data/lore/character-refs/keystone-canonical.jpg",
    "blinkbug": REPO / "data/lore/character-refs/blinkbug-canonical.jpg",
}

SD15 = "runwayml/stable-diffusion-v1-5"
LCM_LORA = "latent-consistency/lcm-lora-sdv1-5"
IP_REPO = "h94/IP-Adapter"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", choices=sorted(CHAR_REFS), required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=float, default=0.6, help="IP-Adapter strength 0..1")
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--guidance", type=float, default=1.5, help="LCM likes low CFG")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=512)
    args = ap.parse_args()

    ref_path = CHAR_REFS[args.char]
    if not ref_path.exists():
        print(f"[gen] reference art missing: {ref_path}", file=sys.stderr)
        return 2

    import torch
    from diffusers import StableDiffusionPipeline, LCMScheduler
    from diffusers.utils import load_image

    if not torch.cuda.is_available():
        print("[gen] CUDA not available in this interpreter", file=sys.stderr)
        return 3

    t0 = time.time()
    print(f"[gen] loading {SD15} (fp16, cuda)…", flush=True)
    pipe = StableDiffusionPipeline.from_pretrained(
        SD15, torch_dtype=torch.float16, safety_checker=None, requires_safety_checker=False
    )
    pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)
    pipe.to("cuda")

    print("[gen] loading LCM-LoRA (4-step) + IP-Adapter…", flush=True)
    pipe.load_lora_weights(LCM_LORA)
    pipe.fuse_lora()
    # SD1.5 IP-Adapter; image_encoder auto-downloads from the repo on first run.
    pipe.load_ip_adapter(IP_REPO, subfolder="models", weight_name="ip-adapter_sd15.bin")
    pipe.set_ip_adapter_scale(args.scale)
    pipe.enable_vae_slicing()

    ref = load_image(str(ref_path))
    gen = torch.Generator("cuda").manual_seed(args.seed)
    print(f"[gen] rendering '{args.char}' · scale={args.scale} · {args.steps} steps…", flush=True)
    image = pipe(
        prompt=args.prompt,
        ip_adapter_image=ref,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance,
        height=args.size,
        width=args.size,
        generator=gen,
    ).images[0]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out)
    dt = time.time() - t0
    print(f"[gen] saved: {out}  ({dt:.1f}s total)")
    print(f"SAVED::{out}")  # machine-parseable marker for the Node driver
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
