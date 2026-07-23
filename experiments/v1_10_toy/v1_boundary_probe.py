#!/usr/bin/env python3
"""
V1 knowledge-boundary probe (Gekhman recipe) — the calibration-critical data step.

Pure abstention-SFT over-abstains (2407.18418). The fix: relabel as "I don't know" ONLY what
THIS model actually gets wrong. So we run the BASE model over verifiable questions, check each
answer against ground truth, and emit calibrated honesty targets:

    correct  -> assert  (keep the model's own verified answer)
    wrong    -> abstain ("I don't know." — the honest target for a boundary miss)

gsm8k first (numeric answers = trivial exact-match verifier, no sandbox). Emits both-class rows
ready for the V1 SFT assembler. One GPU job; run detached.

    .venv-train python experiments/v1_10_toy/v1_boundary_probe.py \
        --model Qwen/Qwen2.5-7B-Instruct --bits4 --n 300 --out data/eval/v1_10/boundary-gsm8k.jsonl
"""
import argparse
import json
import os
import re

if os.name == "nt":
    os.environ.setdefault("HF_HOME", "D:/hf-cache")


def gold_answer(ans):
    m = re.search(r"####\s*([-\d,\.]+)", ans)
    return m.group(1).replace(",", "").strip() if m else None


def model_answer(text):
    # Decimal part only when digits follow the dot — otherwise the sentence period of the
    # mandated format "The answer is 72." is captured into the number ("72." != "72"),
    # marking CORRECT answers wrong (measured: this artifact suppressed running-acc to ~0.24
    # and would have mislabeled the Gekhman boundary; tests/test_v1_boundary_parse.py).
    nums = re.findall(r"-?\d[\d,]*(?:\.\d+)?", text)
    return nums[-1].replace(",", "").strip() if nums else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-7B-Instruct")
    ap.add_argument("--bits4", action="store_true")
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--out", default="data/eval/v1_10/boundary-gsm8k.jsonl")
    ap.add_argument("--max-new", type=int, default=320)
    a = ap.parse_args()

    import torch
    from datasets import load_dataset
    from transformers import AutoModelForCausalLM, AutoTokenizer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"boundary probe | {a.model} | 4bit={a.bits4} | n={a.n} | {device}", flush=True)

    ds = load_dataset("openai/gsm8k", "main", split="train").select(range(a.n))
    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    kw = dict(trust_remote_code=True)
    if a.bits4:
        from transformers import BitsAndBytesConfig
        kw["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.float16, bnb_4bit_use_double_quant=True)
        kw["device_map"] = "auto"
    else:
        kw["torch_dtype"] = torch.float16 if device == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(a.model, **kw)
    if not a.bits4:
        model = model.to(device)
    model.train(False)

    rows, correct = [], 0
    for i, ex in enumerate(ds):
        q, gold = ex["question"], gold_answer(ex["answer"])
        msgs = [{"role": "user", "content": q + "\nEnd with 'The answer is <number>.'"}]
        prompt = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        enc = tok(prompt, return_tensors="pt", truncation=True, max_length=1024).to(model.device)
        with torch.no_grad():
            out = model.generate(**enc, max_new_tokens=a.max_new, do_sample=False,
                                 pad_token_id=tok.pad_token_id)
        gen = tok.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True)
        ok = gold is not None and model_answer(gen) == gold
        correct += ok
        rows.append({
            "id": f"bnd-gsm8k-{i:04d}", "question": q, "gold": gold,
            "model_correct": bool(ok),
            "target": gen.strip() if ok else "I don't know.",
            "gen": gen.strip(),  # raw generation kept ALWAYS — makes future re-labeling free
            "honesty_class": "assert" if ok else "abstain",
            "source": "gsm8k-boundary", "meta": {"verifier": "numeric-exact-match", "model": a.model},
        })
        if (i + 1) % 25 == 0:
            print(f"  [{i+1}/{a.n}] running acc {correct/(i+1):.3f}", flush=True)

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    n_assert = sum(1 for r in rows if r["honesty_class"] == "assert")
    print(f"\nwrote {len(rows)} boundary rows -> {a.out}", flush=True)
    print(f"  model accuracy (its knowledge boundary): {correct}/{len(rows)} = {correct/len(rows):.3f}")
    print(f"  assert (keep verified answer): {n_assert} | abstain (relabel IDK): {len(rows)-n_assert}")
    print("  -> the abstain rows are model-CALIBRATED (Gekhman): only its real misses become IDK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
