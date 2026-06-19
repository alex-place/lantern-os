"""
Prove the native Σ₀ Q-exit loop is real: realized latent depth should adapt to
the Q-exit threshold q (and to input difficulty), not stay fixed at total_ut_steps.

    HF_HOME=D:/hf-cache PYTHONPATH=src .venv-train/Scripts/python scripts/test_sigma0_loop.py [base] [adapter]
"""
import sys
sys.path.insert(0, "src")
from sigma0.loop_lm import Sigma0LoopLM  # noqa: E402

base = sys.argv[1] if len(sys.argv) > 1 else "ByteDance/Ouro-1.4B"
adapter = sys.argv[2] if len(sys.argv) > 2 else None

m = Sigma0LoopLM.load(base, adapter=adapter)
print(f"loaded {base} (max_steps={m.max_steps}, adapter={'yes' if adapter else 'no'})", flush=True)

prompt = "What is 2+2? Answer with the number only."
for q in (0.3, 0.6, 0.95):
    r = m.generate(prompt, q=q, max_new_tokens=20)
    print(f"q={q:>4}  mean_depth={r['mean_depth']}/{m.max_steps}  tokens={r['tokens']}  reply={r['text'][:60]!r}", flush=True)

print("\nIf mean_depth rises with q, the native adaptive latent loop is working "
      "(stock Ouro generate runs fixed full depth).", flush=True)
