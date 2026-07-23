import os
os.environ.setdefault("HF_HOME", "D:/hf-cache")
from huggingface_hub import snapshot_download
for m in ["Qwen/Qwen2.5-1.5B-Instruct", "Qwen/Qwen2.5-7B-Instruct"]:
    print(f"downloading {m} ...", flush=True)
    snapshot_download(m, ignore_patterns=["*.pth", "*.onnx", "original/*"])
    print(f"  done {m}", flush=True)
print("ALL DONE", flush=True)
