#!/usr/bin/env python3
"""
sigma0-stream-image.py — persistent loop image server for Sigma0.

SD 1.5 + LCM LoRA + TAESD: ~2.5 GB VRAM, 4-step generation (~3s on RTX 3070).
Stays hot between calls so the Sigma0 Act stage can loop: generate → verify → refine.

Endpoints:
  GET  /health                 → {ok, loaded, vram_gb}
  POST /generate               → {ok, image_path, latency_ms}
                                 body: {prompt, negative?, steps?, seed?, width?, height?}

Config (env):
  SIGMA0_IMAGE_PORT   default 8772
  SIGMA0_IMAGE_MODEL  default runwayml/stable-diffusion-v1-5
  SIGMA0_IMAGE_OUT    default data/images/sigma0
  HF_HOME             default D:/hf-cache
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")

import torch
from diffusers import StableDiffusionPipeline, AutoencoderTiny, LCMScheduler

PORT = int(os.environ.get("SIGMA0_IMAGE_PORT", "8773"))
MODEL_ID = os.environ.get("SIGMA0_IMAGE_MODEL", "runwayml/stable-diffusion-v1-5")
LCM_LORA_ID = "latent-consistency/lcm-lora-sdv1-5"
TAESD_ID = "madebyollin/taesd"

_REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = Path(os.environ.get("SIGMA0_IMAGE_OUT", str(_REPO_ROOT / "data" / "images" / "sigma0")))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

_pipe = None
_device = None


def load_pipeline():
    global _pipe, _device
    _device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if _device == "cuda" else torch.float32

    print(f"[sigma0-image] loading {MODEL_ID} on {_device}...", flush=True)
    pipe = StableDiffusionPipeline.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        safety_checker=None,
        requires_safety_checker=False,
    ).to(_device)

    # LCM scheduler: 4-step generation
    pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)

    # LCM LoRA: unlocks fast inference without quality loss
    pipe.load_lora_weights(LCM_LORA_ID)
    pipe.fuse_lora()

    # TAESD: tiny VAE decoder saves ~1 GB vs the full VAE
    pipe.vae = AutoencoderTiny.from_pretrained(TAESD_ID, torch_dtype=dtype).to(_device)

    pipe.enable_attention_slicing()

    _pipe = pipe
    vram = torch.cuda.memory_allocated() / 1e9 if _device == "cuda" else 0
    print(f"[sigma0-image] ready — active VRAM: {vram:.1f} GB", flush=True)


def _generate(prompt, negative="blurry, low quality, distorted", steps=4, seed=-1, width=512, height=512):
    generator = None if seed == -1 else torch.Generator(_device).manual_seed(seed)
    t0 = time.time()
    result = _pipe(
        prompt=prompt,
        negative_prompt=negative,
        num_inference_steps=steps,
        guidance_scale=1.5,
        width=width,
        height=height,
        generator=generator,
    )
    latency_ms = int((time.time() - t0) * 1000)
    fname = OUTPUT_DIR / f"{int(time.time() * 1000)}.png"
    result.images[0].save(fname)
    rel = str(fname.relative_to(_REPO_ROOT)).replace("\\", "/")
    return {"ok": True, "image_path": rel, "latency_ms": latency_ms}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            vram = torch.cuda.memory_allocated() / 1e9 if (_device == "cuda") else 0
            self._send_json(200, {"ok": True, "loaded": _pipe is not None, "vram_gb": round(vram, 2)})
        else:
            self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/generate":
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send_json(400, {"ok": False, "error": "invalid JSON"})
            return

        prompt   = str(body.get("prompt", "a beautiful scene"))
        negative = str(body.get("negative", "blurry, low quality, distorted"))
        steps    = max(1, min(20, int(body.get("steps", 4))))
        seed     = int(body.get("seed", -1))
        width    = int(body.get("width", 512))
        height   = int(body.get("height", 512))

        if _pipe is None:
            self._send_json(503, {"ok": False, "error": "pipeline not loaded"})
            return

        try:
            result = _generate(prompt, negative=negative, steps=steps, seed=seed, width=width, height=height)
            self._send_json(200, result)
        except Exception as e:
            self._send_json(500, {"ok": False, "error": str(e)})


if __name__ == "__main__":
    load_pipeline()
    print(f"[sigma0-image] listening on 127.0.0.1:{PORT}", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), _Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[sigma0-image] stopped", flush=True)
        sys.exit(0)
