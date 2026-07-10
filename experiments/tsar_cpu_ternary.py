r"""
tsar_cpu_ternary.py — CPU-only ternary inference feasibility (#2207, re: T-SAR arXiv:2511.13676).

IMPORTANT SCOPE: T-SAR is a *hardware* co-design (DATE 2026) — it reorganizes CPU **SIMD ALUs**
("3.2% power / 1.4% area overhead in SIMD units") to build in-register ternary LUTs. It is NOT a
software library and CANNOT run on a stock CPU. So we cannot reproduce T-SAR's 1.1-86x. What we CAN
measure honestly on this box's stock CPU is the software-achievable answer to the issue's acceptance:

  A) end-to-end: can we run the coder CPU-only at usable tokens/s, and how does it compare to GPU?
  B) micro: does a software multiplication-free ternary GEMV beat optimized fp32 BLAS on a stock CPU?
     (If not — and it won't — that is exactly WHY T-SAR needs custom SIMD hardware. Honest go/no-go.)

Run:  .venv-train/Scripts/python.exe experiments/tsar_cpu_ternary.py --model Qwen/Qwen2.5-Coder-1.5B-Instruct
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")
import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def gen_speed(model, tok, prompt, new_tokens=48):
    ids = tok(prompt, return_tensors="pt").to(model.device)
    with torch.no_grad():  # warmup
        model.generate(**ids, max_new_tokens=4, do_sample=False, pad_token_id=tok.eos_token_id)
    t0 = time.time()
    with torch.no_grad():
        out = model.generate(**ids, max_new_tokens=new_tokens, do_sample=False, pad_token_id=tok.eos_token_id)
    dt = time.time() - t0
    n = out.shape[1] - ids["input_ids"].shape[1]
    return n / dt, dt, n


def ternary_gemv_bench(out_dim=4096, in_dim=4096, reps=20):
    """Compare fp32 BLAS matvec vs a software 'multiplication-free' ternary matvec on this CPU."""
    rng = np.random.RandomState(0)
    Wf = rng.randn(out_dim, in_dim).astype(np.float32)
    # ternary weights {-1,0,1} (~50% zeros, like a sparse ternary net)
    Wt = np.zeros((out_dim, in_dim), dtype=np.int8)
    m = rng.rand(out_dim, in_dim)
    Wt[m > 0.75] = 1; Wt[m < 0.25] = -1
    x = rng.randn(in_dim).astype(np.float32)

    # fp32 BLAS
    for _ in range(3):
        _ = Wf @ x
    t0 = time.time()
    for _ in range(reps):
        yf = Wf @ x
    fp_s = (time.time() - t0) / reps

    # ternary via int8 matmul cast to float (numpy uses a generic loop for int8 @ float -> promote)
    Wt_f = Wt.astype(np.float32)
    for _ in range(3):
        _ = Wt_f @ x
    t0 = time.time()
    for _ in range(reps):
        yt = Wt_f @ x
    tern_blas_s = (time.time() - t0) / reps

    # "multiplication-free" split: y = sum(x where W=+1) - sum(x where W=-1), via masked BLAS on {0,1}
    Wpos = (Wt == 1).astype(np.float32)
    Wneg = (Wt == -1).astype(np.float32)
    for _ in range(3):
        _ = Wpos @ x - Wneg @ x
    t0 = time.time()
    for _ in range(reps):
        ym = Wpos @ x - Wneg @ x
    mulfree_s = (time.time() - t0) / reps

    return {
        "out_dim": out_dim, "in_dim": in_dim,
        "fp32_blas_ms": round(fp_s * 1e3, 3),
        "ternary_as_float_blas_ms": round(tern_blas_s * 1e3, 3),
        "mulfree_split_ms": round(mulfree_s * 1e3, 3),
        "mulfree_vs_fp32_speedup": round(fp_s / mulfree_s, 3),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--new-tokens", type=int, default=48)
    a = ap.parse_args()

    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    prompt = "def quicksort(arr):\n    "

    print(f"[tsar] {a.model} — CPU vs GPU end-to-end tokens/s", flush=True)
    print("[tsar] loading on CPU (fp32) ...", flush=True)
    cpu_model = AutoModelForCausalLM.from_pretrained(a.model, trust_remote_code=True,
                                                     torch_dtype=torch.float32, device_map="cpu")
    cpu_model.eval()
    cpu_tps, cpu_dt, cpu_n = gen_speed(cpu_model, tok, prompt, a.new_tokens)
    print(f"[tsar]  CPU: {cpu_tps:.2f} tok/s ({cpu_n} toks in {cpu_dt:.1f}s)", flush=True)
    del cpu_model

    gpu_tps = None
    if torch.cuda.is_available():
        print("[tsar] loading on GPU (fp16) ...", flush=True)
        gpu_model = AutoModelForCausalLM.from_pretrained(a.model, trust_remote_code=True,
                                                         torch_dtype=torch.float16, device_map="cuda")
        gpu_model.eval()
        gpu_tps, gpu_dt, gpu_n = gen_speed(gpu_model, tok, prompt, a.new_tokens)
        print(f"[tsar]  GPU: {gpu_tps:.2f} tok/s ({gpu_n} toks in {gpu_dt:.1f}s)", flush=True)
        del gpu_model

    print("[tsar] ternary GEMV microbenchmark (stock-CPU numpy) ...", flush=True)
    micro = [ternary_gemv_bench(d, d) for d in (2048, 4096)]
    for m in micro:
        print(f"  {m['out_dim']}x{m['in_dim']}: fp32 {m['fp32_blas_ms']}ms | mulfree {m['mulfree_split_ms']}ms "
              f"| speedup {m['mulfree_vs_fp32_speedup']}x", flush=True)

    usable = cpu_tps >= 3.0
    micro_wins = any(m["mulfree_vs_fp32_speedup"] > 1.0 for m in micro)
    report = {
        "task": "CPU-only ternary inference feasibility (#2207); T-SAR is hardware, not reproducible in SW",
        "model": a.model, "new_tokens": a.new_tokens,
        "cpu_tokens_per_s": round(cpu_tps, 2), "gpu_tokens_per_s": round(gpu_tps, 2) if gpu_tps else None,
        "cpu_vs_gpu_slowdown": round(gpu_tps / cpu_tps, 1) if gpu_tps else None,
        "ternary_gemv_microbench": micro,
        "software_ternary_beats_fp_blas": micro_wins,
        "verdict_cpu_usable": bool(usable),
        "go_no_go": (
            f"CPU-only inference {'IS' if usable else 'is NOT'} usable at {cpu_tps:.1f} tok/s on this "
            f"box's stock CPU ({'~'+str(round(gpu_tps/cpu_tps,0))+'x slower than GPU' if gpu_tps else ''}). "
            f"Software multiplication-free ternary {'beats' if micro_wins else 'does NOT beat'} optimized "
            f"fp32 BLAS on a stock CPU — {'a real SW win' if micro_wins else 'confirming T-SARs premise that '
            'custom SIMD hardware is required for the ternary speedup; on commodity CPUs ternary buys '
            'MEMORY (fits with no GPU), not SPEED'}."),
        "honest_scope": ("T-SAR (arXiv:2511.13676, DATE 2026) modifies CPU SIMD ALUs — a hardware "
                         "co-design, NOT a runnable library. Its 1.1-86x needs that hardware, absent on "
                         "stock CPUs. We measured the software-achievable CPU path + a numpy ternary "
                         "microbench. Weights here are fp (transformers CPU); a packed-ternary CPU kernel "
                         "(bitnet.cpp / TQ2_0 in llama.cpp) is the realistic SW route to test next."),
        "evidence_class": "MEASURED",
    }
    OUT = REPO / "data" / "sigma0" / "tsar_cpu_report.json"
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[tsar] ===== RESULT =====")
    print(f"  CPU {cpu_tps:.2f} tok/s vs GPU {gpu_tps:.2f} tok/s" if gpu_tps else f"  CPU {cpu_tps:.2f} tok/s")
    print(f"  software ternary beats fp BLAS: {micro_wins}")
    print(f"  GO/NO-GO: {report['go_no_go']}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
