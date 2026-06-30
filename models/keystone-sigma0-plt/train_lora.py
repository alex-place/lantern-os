#!/usr/bin/env python3
"""QLoRA SFT for Keystone-Σ₀ PLT — adapter-only over a frozen base (ADR-0010).

Per ADR-0010, weight adjustment is adapter-only: the bootstrapped base stays
frozen, updates land in a replaceable LoRA adapter regenerable from verified
experience. This script is the minimal, correct training path that runs on a
single ≥24 GB GPU (4-bit base + LoRA + gradient checkpointing through the 2-loop
PLT forward).

    # 1. one-time, on the GPU box:
    python download_and_patch.py --out ./checkpoint
    python check_parity.py --model ./checkpoint        # MUST pass before training
    # 2. train:
    python train_lora.py --model ./checkpoint --data data/sample_sft.jsonl --out ./adapter

Dataset: JSONL, one object per line, either
    {"prompt": "...", "completion": "..."}        # loss on completion only
or  {"text": "..."}                                # loss on the whole sequence

This is a SCAFFOLD: defaults are tiny/safe so a first run completes quickly and
proves the pipeline. Scale epochs/data/rank for real runs. Run sanity-check
collapse/eval gates (ADR-0010) before trusting an adapter.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_jsonl(path: str):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="patched checkpoint dir")
    ap.add_argument("--data", required=True, help="JSONL SFT data")
    ap.add_argument("--out", default="./adapter")
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--alpha", type=int, default=32)
    ap.add_argument("--max-len", type=int, default=1024)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=16)
    args = ap.parse_args()

    import torch
    from transformers import (AutoModelForCausalLM, AutoTokenizer,
                              BitsAndBytesConfig, Trainer, TrainingArguments)
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from torch.utils.data import Dataset

    tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    bnb = BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model, quantization_config=bnb, device_map="cuda:0",
        trust_remote_code=True)
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(
        model, use_gradient_checkpointing=True)
    model.model.gradient_checkpointing = True  # our PLT loop honors this flag

    # LoRA on the standard projections (the gate is tiny — left frozen by default).
    lora = LoraConfig(
        r=args.rank, lora_alpha=args.alpha, lora_dropout=0.05, bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    rows = load_jsonl(args.data)

    class SFT(Dataset):
        def __len__(self):
            return len(rows)

        def __getitem__(self, i):
            r = rows[i]
            if "text" in r:
                ids = tok(r["text"], truncation=True, max_length=args.max_len)["input_ids"]
                labels = list(ids)
            else:
                p = tok(r["prompt"], truncation=True, max_length=args.max_len)["input_ids"]
                c = tok(r["completion"], truncation=True,
                        max_length=args.max_len - len(p))["input_ids"]
                ids = p + c
                labels = [-100] * len(p) + list(c)   # loss on completion only
            return {"input_ids": ids, "labels": labels}

    def collate(batch):
        maxlen = max(len(b["input_ids"]) for b in batch)
        pad = tok.pad_token_id
        input_ids, labels, attn = [], [], []
        for b in batch:
            n = maxlen - len(b["input_ids"])
            input_ids.append(b["input_ids"] + [pad] * n)
            labels.append(b["labels"] + [-100] * n)
            attn.append([1] * len(b["input_ids"]) + [0] * n)
        return {
            "input_ids": torch.tensor(input_ids),
            "labels": torch.tensor(labels),
            "attention_mask": torch.tensor(attn),
        }

    targs = TrainingArguments(
        output_dir=args.out, num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr, bf16=True, logging_steps=1, save_strategy="epoch",
        report_to=[], optim="paged_adamw_8bit", warmup_ratio=0.03,
        lr_scheduler_type="cosine", gradient_checkpointing=True,
    )
    Trainer(model=model, args=targs, train_dataset=SFT(),
            data_collator=collate).train()

    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)
    print(f"\n✓ adapter saved → {args.out}  (base frozen; ADR-0010 adapter-only)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
