"""
ouro_serve_smoketest.py — prove the rebuilt venv can load Ouro and generate coherently.

Standalone (no server): loads the base model fp16 on CUDA and greedily generates a few
tokens. A coherent, non-repeating output confirms the recurrent KV cache works on the pinned
transformers; a `✅✅✅`-style loop or an exception is the failure signal.

Run:  D:/lantern-venv-train/Scripts/python.exe scripts/ouro_serve_smoketest.py
"""
import os
import time

os.environ.setdefault("HF_HOME", "D:/hf-cache")

import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

from ouro_compat import patch_universal_transformer_cache  # noqa: E402

MID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
print(f"[smoke] transformers load of {MID}  cuda={torch.cuda.is_available()}", flush=True)
if not torch.cuda.is_available():
    print("[smoke] WARNING: CUDA not visible — this venv's torch is CPU-only", flush=True)

t = time.time()
tok = AutoTokenizer.from_pretrained(MID, trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained(
    MID, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
model.eval()
_patched = patch_universal_transformer_cache()
print(f"[smoke] UniversalTransformerCache patch applied to: {_patched}", flush=True)
load_s = time.time() - t
dev = next(model.parameters()).device
vram = torch.cuda.memory_allocated() / 1e9 if torch.cuda.is_available() else 0.0
print(f"[smoke] loaded in {load_s:.1f}s  device={dev}  vram={vram:.2f}GB", flush=True)

prompt = "The capital of France is"
ids = tok(prompt, return_tensors="pt").to(dev)
t = time.time()
with torch.no_grad():
    out = model.generate(**ids, max_new_tokens=16, do_sample=False)
gen = tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)
gen_s = time.time() - t
print(f"[smoke] prompt: {prompt!r}", flush=True)
print(f"[smoke] gen:    {gen!r}", flush=True)
print(f"[smoke] 16 tokens in {gen_s:.1f}s ({16/gen_s:.1f} tok/s)", flush=True)

# crude degeneration check: the collapse symptom is a single token repeated
toks = gen.split()
degenerate = len(toks) >= 4 and len(set(toks)) == 1
print(f"[smoke] {'FAIL — degenerate repeat loop (cache bug?)' if degenerate else 'OK — coherent output, model loads and generates'}", flush=True)
