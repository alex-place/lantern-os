"""
Double-blind A/B study of the Σ₀ chat backend.

System A vs B per prompt are {native adaptive Q-exit loop, stock fixed-depth}, but
which letter maps to which is randomized per prompt with a fixed seed and written
to a SEALED KEY the evaluator does not read until after scoring. The model is
loaded ONCE; both arms use identical weights — the only difference is the inference
policy (the native latent loop vs Ouro's stock generate).

    HF_HOME=D:/hf-cache .venv-train/Scripts/python scripts/blind_study.py [base] [adapter]

Outputs:
    data/eval/blind-transcript.jsonl   {id, prompt, A, B, depthA?, depthB?}  (no labels)
    data/eval/blind-key.json           {id: {A: sys, B: sys}}  (sealed — read AFTER scoring)
"""
import json
import os
import random
import sys

sys.path.insert(0, "src")
os.environ.setdefault("HF_HOME", "D:/hf-cache")

base = sys.argv[1] if len(sys.argv) > 1 else "ByteDance/Ouro-1.4B"
adapter = sys.argv[2] if len(sys.argv) > 2 else None
SEED = 20260619
MAX_TOK = 28
Q = 0.5

from sigma0.loop_lm import Sigma0LoopLM  # noqa: E402
import torch  # noqa: E402

m = Sigma0LoopLM.load(base, adapter=adapter)
print(f"loaded {base} adapter={'yes' if adapter else 'no'} max_steps={m.max_steps}", flush=True)


def stock(prompt):
    """Ouro's own generate(): fixed full depth, greedy."""
    ids = m.tok(prompt, return_tensors="pt").to(m.model.device)
    with torch.no_grad():
        out = m.model.generate(**ids, max_new_tokens=MAX_TOK, do_sample=False,
                               pad_token_id=m.tok.eos_token_id)
    return m.tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()


def native(prompt):
    r = m.generate(prompt, q=Q, max_new_tokens=MAX_TOK)
    return r["text"].strip(), r["mean_depth"]


rows = [json.loads(l) for l in open("data/eval/sigma0-prompts.jsonl", encoding="utf-8") if l.strip()]
rng = random.Random(SEED)
transcript, key = [], {}
for r in rows:
    p = r["prompt"]
    nat_text, nat_depth = native(p)
    stk_text = stock(p)
    arms = {"native": {"text": nat_text, "depth": nat_depth},
            "stock":  {"text": stk_text, "depth": m.max_steps}}
    order = ["native", "stock"]
    rng.shuffle(order)                       # double-blind: randomize A/B per prompt
    a_sys, b_sys = order
    transcript.append({"id": r["id"], "prompt": p,
                       "A": arms[a_sys]["text"], "B": arms[b_sys]["text"],
                       "depthA": arms[a_sys]["depth"], "depthB": arms[b_sys]["depth"]})
    key[str(r["id"])] = {"A": a_sys, "B": b_sys}
    print(f"#{r['id']} done", flush=True)

os.makedirs("data/eval", exist_ok=True)
with open("data/eval/blind-transcript.jsonl", "w", encoding="utf-8") as f:
    for t in transcript:
        f.write(json.dumps(t, ensure_ascii=False) + "\n")
with open("data/eval/blind-key.json", "w", encoding="utf-8") as f:
    json.dump(key, f, indent=2)
print("\nwrote data/eval/blind-transcript.jsonl (blind) + blind-key.json (sealed)", flush=True)
