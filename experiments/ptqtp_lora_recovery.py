r"""
ptqtp_lora_recovery.py — can a light LoRA recover the PTQTP coding tax at FULL compression? (#2206)

#2206 showed 2-plane PTQTP (~3.4 bits, 4.7x) costs coding pass@1 (7B: 0.95->0.80). A 3rd plane
recovers it but drops to 3.1x. The other recovery path is a "light QAT touch-up": keep the 4.7x
2-plane quantization and add a small LoRA fine-tuned on code — does the adapter buy the coding back
while the base stays maximally compressed? Product-relevant: ship a 4.7x coder + a tiny adapter.

Flow (Qwen2.5-Coder-1.5B, memory-feasible to LoRA-train after quantization):
  1. HumanEval FP16 baseline
  2. PTQTP 2-plane quantize every linear in place -> HumanEval (the tax)
  3. add LoRA, QLoRA-train on a general coding SFT corpus (DISJOINT from HumanEval test) -> HumanEval

Run:  .venv-train/Scripts/python.exe experiments/ptqtp_lora_recovery.py --n 50 --train-rows 2000 --steps 300
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")
from datasets import Dataset, load_dataset  # noqa: E402  before torch (pyarrow/CUDA DLL, #2264)
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
from transformers import (AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments,  # noqa: E402
                          default_data_collator)
from peft import LoraConfig, get_peft_model  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "experiments"))
sys.path.insert(0, str(REPO / "scripts"))
from ptqtp_quantize import ptqtp_matrix  # noqa: E402
from ptqtp_coding_eval import run_humaneval  # noqa: E402  (chat HumanEval + exec sandbox)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--train-rows", type=int, default=2000)
    ap.add_argument("--steps", type=int, default=300)
    ap.add_argument("--planes", type=int, default=2)
    ap.add_argument("--seq", type=int, default=640)
    ap.add_argument("--no-quant", action="store_true", help="CONTROL: skip PTQTP, just FP16+LoRA (isolates SFT benefit from recovery)")
    a = ap.parse_args()

    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(a.model, trust_remote_code=True,
                                                 torch_dtype=torch.float16, device_map="cuda")
    model.eval()
    ds = load_dataset("openai_humaneval", split="test")
    problems = [ds[i] for i in range(a.n)]

    def he(tag):
        p, fails = run_humaneval(model, tok, problems)
        print(f"[recovery] HumanEval @ {tag}: {p}/{a.n} = {p/a.n:.3f}  fails={fails}", flush=True)
        return round(p / a.n, 3)

    print("[recovery] 1) FP16 baseline", flush=True)
    fp16 = he("FP16")

    if a.no_quant:
        print("[recovery] 2) CONTROL: no quantization (FP16 base kept)", flush=True)
        ptqtp = fp16
    else:
        print(f"[recovery] 2) PTQTP {a.planes}-plane quantize in place", flush=True)
        t0 = time.time()
        for name, mod in model.named_modules():
            if isinstance(mod, nn.Linear) and "lm_head" not in name:
                rec, _ = ptqtp_matrix(mod.weight.data, 128, 8, n_planes=a.planes)
                mod.weight.data.copy_(rec)
                del rec
        torch.cuda.empty_cache()
        print(f"  quantized in {time.time()-t0:.0f}s", flush=True)
        ptqtp = he("PTQTP")

    print(f"[recovery] 3) LoRA fine-tune on {a.train_rows} coding rows / {a.steps} steps", flush=True)
    rows = [json.loads(l) for l in
            open(REPO / "models/lantern-sigma0-coder/humaneval-train.jsonl", encoding="utf-8")
            if l.strip()][: a.train_rows]
    texts = []
    for r in rows:
        instr = (r.get("instruction", "") + ("\n" + r["input"] if r.get("input") else "")).strip()
        out = r.get("output", "")
        if instr and out:
            texts.append({"text": f"### Instruction:\n{instr}\n\n### Response:\n{out}{tok.eos_token}"})

    def tok_fn(b):
        enc = tok(b["text"], truncation=True, max_length=a.seq, padding="max_length")
        labels = []
        for text, ids, am in zip(b["text"], enc["input_ids"], enc["attention_mask"]):
            plen = len(tok(text.split("### Response:\n", 1)[0] + "### Response:\n",
                           truncation=True, max_length=a.seq)["input_ids"])
            labels.append([-100 if (am[j] == 0 or j < plen) else ids[j] for j in range(len(ids))])
        enc["labels"] = labels
        return enc

    tds = Dataset.from_list(texts).map(tok_fn, batched=True, remove_columns=["text"])
    model.train()
    model.gradient_checkpointing_enable(); model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
                                             task_type="CAUSAL_LM", target_modules="all-linear"))
    model.print_trainable_parameters()
    trainer = Trainer(model=model, train_dataset=tds, data_collator=default_data_collator,
                      args=TrainingArguments(output_dir="D:/lantern-train/ptqtp-lora-recovery",
                                             per_device_train_batch_size=1, gradient_accumulation_steps=8,
                                             max_steps=a.steps, learning_rate=2e-4, bf16=True,
                                             logging_steps=25, save_strategy="no", warmup_ratio=0.03,
                                             gradient_checkpointing=True, optim="paged_adamw_8bit",
                                             report_to="none"))
    trainer.train()
    model.eval()
    recovered = he("PTQTP+LoRA")

    report = {
        "task": "recover the PTQTP coding tax with a light LoRA at full compression (#2206)",
        "model": a.model, "n_humaneval": a.n, "planes": a.planes,
        "train_rows": len(texts), "steps": a.steps,
        "pass_at_1": {"fp16": fp16, "ptqtp": ptqtp, "ptqtp_plus_lora": recovered},
        "tax": round(ptqtp - fp16, 3), "recovery": round(recovered - ptqtp, 3),
        "net_vs_fp16": round(recovered - fp16, 3),
        "verdict": ("LoRA RECOVERS the quantization coding tax at full 4.7x compression"
                    if recovered >= ptqtp + 0.05 else
                    "LoRA does not meaningfully recover the tax in this budget"),
        "evidence_class": "MEASURED",
        "caveats": ("Qwen2.5-Coder-1.5B, HumanEval n small, general coding SFT ('humaneval-train.jsonl' "
                    "= general Python instructions, no HumanEval/ test ids found — low but nonzero "
                    "contamination risk), short LoRA run. PTQTP weights dequantized (quality not speed)."),
    }
    OUT = REPO / "data" / "sigma0" / "ptqtp_lora_recovery_report.json"
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[recovery] ===== RESULT =====")
    print(f"  FP16 {fp16} -> PTQTP {ptqtp} (tax {report['tax']}) -> +LoRA {recovered} (recovery {report['recovery']})")
    print(f"  VERDICT: {report['verdict']}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
