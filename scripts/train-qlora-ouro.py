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

if os.name == "nt":  # Windows local dev only — don't stomp HF_HOME on Linux/Kaggle
    os.environ.setdefault("HF_HOME", "D:/hf-cache")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="ByteDance/Ouro-1.4B")
    ap.add_argument("--data", default="models/lantern-sigma0-coder/training-data.jsonl")
    ap.add_argument("--out", default="D:/lantern-train/ouro-sigma0-adapters")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--max-steps", type=int, default=-1, help="override epochs (smoke test); -1 = use epochs")
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--lora-r", type=int, default=16, help="LoRA rank; alpha=2*r (handoff recipe: 32)")
    ap.add_argument("--seq", type=int, default=1536)  # audited p99=1219 on the FC corpus; 1024 truncates 3% from the END (cuts the tool call)
    a = ap.parse_args()

    import torch
    from datasets import Dataset
    from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig,
                              Trainer, TrainingArguments, default_data_collator)
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

    from transformers import AutoConfig
    cfg = AutoConfig.from_pretrained(a.base, trust_remote_code=True)
    # OuroConfig (newer transformers / Python 3.12) may lack pad_token_id — set it from bos.
    if not hasattr(cfg, "pad_token_id") or cfg.pad_token_id is None:
        cfg.pad_token_id = getattr(cfg, "bos_token_id", tok.pad_token_id)

    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                             bnb_4bit_compute_dtype=compute_dtype, bnb_4bit_use_double_quant=True)
    try:
        model = AutoModelForCausalLM.from_pretrained(
            a.base, config=cfg, quantization_config=bnb, device_map="auto", trust_remote_code=True,
            attn_implementation="sdpa")   # ouro_serve.py has used sdpa since #775; mirror here
    except (ValueError, TypeError):
        model = AutoModelForCausalLM.from_pretrained(
            a.base, config=cfg, quantization_config=bnb, device_map="auto", trust_remote_code=True)
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model)
    # all-linear is robust for a custom (trust_remote_code) architecture whose
    # exact projection names we don't want to hardcode.
    model = get_peft_model(model, LoraConfig(
        r=a.lora_r, lora_alpha=2 * a.lora_r, lora_dropout=0.05, bias="none",
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

    # Completion-only loss: mask the prompt (### Instruction … ### Response:\n) AND the
    # padding so gradients land only on the tool-call/answer tokens (recipe: prompt-masking
    # ~+1% and matters for FC). pad == eos here, so we mask padding via attention_mask,
    # NOT by token id, which would also wipe the real end-of-answer eos.
    def tok_fn(b):
        enc = tok(b["text"], truncation=True, max_length=a.seq, padding="max_length")
        labels_batch = []
        for text, ids, am in zip(b["text"], enc["input_ids"], enc["attention_mask"]):
            prompt = text.split("### Response:\n", 1)[0] + "### Response:\n"
            plen = len(tok(prompt, truncation=True, max_length=a.seq)["input_ids"])
            labels_batch.append([-100 if (am[j] == 0 or j < plen) else ids[j]
                                 for j in range(len(ids))])
        enc["labels"] = labels_batch
        return enc
    ds = ds.map(tok_fn, batched=True, remove_columns=["text"])

    os.makedirs(a.out, exist_ok=True)
    trainer = Trainer(
        model=model, train_dataset=ds,
        data_collator=default_data_collator,  # tok_fn already padded + built masked labels; don't let the LM collator overwrite them
        args=TrainingArguments(
            output_dir=a.out, num_train_epochs=a.epochs, max_steps=a.max_steps,
            per_device_train_batch_size=1,
            gradient_accumulation_steps=8, learning_rate=a.lr,
            bf16=use_bf16, fp16=not use_bf16, max_grad_norm=1.0, warmup_ratio=0.03,
            logging_steps=10, save_strategy="steps", save_steps=150, save_total_limit=2,
            optim="paged_adamw_8bit",
            gradient_checkpointing=True, report_to="none"))
    trainer.train()

    final = os.path.join(a.out, "final")
    model.save_pretrained(final); tok.save_pretrained(final)
    print(f"adapter saved -> {final}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
