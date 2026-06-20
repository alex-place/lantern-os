"""
QLoRA fine-tune the REAL Ouro LoopLM (weight-tied recurrent transformer) on the
Σ₀ Claude-session data — the looped equivalent of lantern-sigma0-coder, but on a
genuinely looped base instead of Qwen.

Uses peft + transformers Trainer directly (no trl) so it's stable against the
transformers 4.57 that Ouro's custom code requires.

    .venv-train/Scripts/python scripts/train-qlora-ouro.py \
        --base ByteDance/Ouro-1.4B \
        --data models/lantern-sigma0-coder/training-data.jsonl \
        --out  D:/lantern-train/ouro-sigma0-adapters --epochs 3
"""
import argparse
import json
import os

os.environ.setdefault("HF_HOME", "D:/hf-cache")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="ByteDance/Ouro-1.4B")
    ap.add_argument("--data", default="models/lantern-sigma0-coder/training-data.jsonl")
    ap.add_argument("--out", default="D:/lantern-train/ouro-sigma0-adapters")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--seq", type=int, default=1024)
    a = ap.parse_args()

    import torch
    from datasets import Dataset
    from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig,
                              DataCollatorForLanguageModeling, Trainer, TrainingArguments)
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    print(f"CUDA: {torch.cuda.is_available()} | base: {a.base}")
    if not torch.cuda.is_available():
        print("ERROR: CUDA required."); return 1

    # bf16 over fp16 on Ampere+ : fp16 QLoRA on this reasoning-LM overflows gradients
    # (observed grad_norm=nan on a smoke run), which max_grad_norm clipping then
    # propagates into the LoRA weights -> a NaN/garbage adapter. bf16 has fp32's
    # exponent range, so no overflow. Fall back to fp16 only if bf16 is unsupported.
    use_bf16 = torch.cuda.is_bf16_supported()
    compute_dtype = torch.bfloat16 if use_bf16 else torch.float16
    print(f"precision: {'bf16' if use_bf16 else 'fp16'}")

    tok = AutoTokenizer.from_pretrained(a.base, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                             bnb_4bit_compute_dtype=compute_dtype, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(
        a.base, quantization_config=bnb, device_map="auto", trust_remote_code=True)
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model)
    # all-linear is robust for a custom (trust_remote_code) architecture whose
    # exact projection names we don't want to hardcode.
    model = get_peft_model(model, LoraConfig(
        r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
        task_type="CAUSAL_LM", target_modules="all-linear"))
    model.print_trainable_parameters()

    rows = []
    with open(a.data, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            instr, out = r.get("instruction", ""), r.get("output", "")
            if instr and out:
                rows.append({"text": f"### Instruction:\n{instr}\n\n### Response:\n{out}{tok.eos_token}"})
    print(f"training rows: {len(rows)}")
    ds = Dataset.from_list(rows)

    def tok_fn(b):
        out = tok(b["text"], truncation=True, max_length=a.seq, padding="max_length")
        out["labels"] = out["input_ids"].copy()
        return out
    ds = ds.map(tok_fn, batched=True, remove_columns=["text"])

    os.makedirs(a.out, exist_ok=True)
    trainer = Trainer(
        model=model, train_dataset=ds,
        data_collator=DataCollatorForLanguageModeling(tok, mlm=False),
        args=TrainingArguments(
            output_dir=a.out, num_train_epochs=a.epochs, per_device_train_batch_size=1,
            gradient_accumulation_steps=8, learning_rate=a.lr,
            bf16=use_bf16, fp16=not use_bf16, max_grad_norm=1.0, warmup_ratio=0.03,
            logging_steps=5, save_strategy="epoch", optim="paged_adamw_8bit",
            gradient_checkpointing=True, report_to="none"))
    trainer.train()

    final = os.path.join(a.out, "final")
    model.save_pretrained(final); tok.save_pretrained(final)
    print(f"adapter saved -> {final}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
