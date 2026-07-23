"""
QLoRA-VTD fine-tune of the TINY coder (Qwen2.5-Coder-0.5B) on the spiral's own
verified-trace corpus (ADR-0030, Phase 1). The training target for each problem is the
cascade's EXEC-VERIFIED solution — especially the frontier RESCUES (the hard tail the
0.5B couldn't do alone). Baking those into the weights is the mechanism that retrieval
could not deliver (measured: retrieval HURT the 0.5B).

Uses the model's NATIVE chat template for both train and (later) eval, so base-vs-adapter
is apples-to-apples. Completion-only loss (mask the user turn). bf16 on Ampere + 4-bit nf4.

    C:/dev/lantern-os/.venv-train/Scripts/python.exe scripts/train_qlora_qwen_coder.py \
        --base Qwen/Qwen2.5-Coder-0.5B-Instruct \
        --data data/eval/spiral/vtd-corpus.jsonl \
        --out  D:/lantern-train/qwen05-vtd --epochs 4
"""
import argparse
import json
import os

if os.name == "nt":
    os.environ.setdefault("HF_HOME", "D:/hf-cache")


def load_records(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else [parsed]
    except json.JSONDecodeError:
        return [json.loads(l) for l in raw.splitlines() if l.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="Qwen/Qwen2.5-Coder-0.5B-Instruct")
    ap.add_argument("--data", default="data/eval/spiral/vtd-corpus.jsonl")
    ap.add_argument("--out", default="D:/lantern-train/qwen05-vtd")
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--max-steps", type=int, default=-1)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--seq", type=int, default=1024)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--val-size", type=int, default=12)
    a = ap.parse_args()

    from datasets import Dataset
    import torch
    from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig,
                              Trainer, TrainingArguments, TrainerCallback, default_data_collator)
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    print(f"CUDA: {torch.cuda.is_available()} | base: {a.base}")
    if not torch.cuda.is_available():
        print("ERROR: CUDA required."); return 1
    _cc = torch.cuda.get_device_capability()
    use_bf16 = torch.cuda.is_bf16_supported() and _cc >= (8, 0)
    compute_dtype = torch.bfloat16 if use_bf16 else torch.float16
    use_4bit = _cc >= (7, 5)
    print(f"precision: {'bf16' if use_bf16 else 'fp16'} (cc {_cc[0]}.{_cc[1]}) | 4-bit: {use_4bit}")

    tok = AutoTokenizer.from_pretrained(a.base, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    load_kwargs = dict(device_map="auto", trust_remote_code=True)
    if use_4bit:
        load_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=compute_dtype, bnb_4bit_use_double_quant=True)
    else:
        load_kwargs["torch_dtype"] = compute_dtype
    model = AutoModelForCausalLM.from_pretrained(a.base, attn_implementation="sdpa", **load_kwargs)
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model) if use_4bit else (
        model.gradient_checkpointing_enable() or model.enable_input_require_grads() or model)
    model = get_peft_model(model, LoraConfig(
        r=a.lora_r, lora_alpha=2 * a.lora_r, lora_dropout=0.0, bias="none",
        task_type="CAUSAL_LM", target_modules="all-linear"))
    model.print_trainable_parameters()

    # Build {prompt, solution} rows (accept instruction/output too), format with the NATIVE
    # chat template, and mask the user turn so loss lands only on the verified solution.
    records = load_records(a.data)
    rows = []
    for r in records:
        if not isinstance(r, dict):
            continue
        prompt = r.get("prompt") or r.get("instruction") or ""
        sol = r.get("solution") or r.get("output") or ""
        if not (prompt and sol):
            continue
        full = tok.apply_chat_template(
            [{"role": "user", "content": prompt}, {"role": "assistant", "content": sol}],
            tokenize=False)
        prompt_only = tok.apply_chat_template(
            [{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True)
        rows.append({"full": full, "prompt_only": prompt_only})
    print(f"training rows: {len(rows)}  (from {len(records)} records)")
    if len(rows) < 8:
        print("ERROR: too few verified traces to train a meaningful adapter (need >= ~8)."); return 2
    ds = Dataset.from_list(rows)

    def tok_fn(b):
        enc = tok(b["full"], truncation=True, max_length=a.seq, padding="max_length")
        labels = []
        for ids, am, po in zip(enc["input_ids"], enc["attention_mask"], b["prompt_only"]):
            plen = len(tok(po, truncation=True, max_length=a.seq)["input_ids"])
            labels.append([-100 if (am[j] == 0 or j < plen) else ids[j] for j in range(len(ids))])
        enc["labels"] = labels
        return enc
    ds = ds.map(tok_fn, batched=True, remove_columns=["full", "prompt_only"])

    val_size = min(a.val_size, max(1, len(ds) // 5))
    split = ds.train_test_split(test_size=val_size, seed=42, shuffle=True)
    train_ds, eval_ds = split["train"], split["test"]
    print(f"train rows: {len(train_ds)}  val rows: {len(eval_ds)}")

    class OverfitTripwire(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kwargs):
            if (logs and "loss" in logs and state.epoch is not None
                    and state.epoch < 2.0 and logs["loss"] < 0.05):
                print(f"OVERFIT TRIPWIRE: loss {logs['loss']:.3f} < 0.05 at epoch {state.epoch:.2f} — stopping.")
                control.should_training_stop = True
            return control

    os.makedirs(a.out, exist_ok=True)
    trainer = Trainer(
        model=model, train_dataset=train_ds, eval_dataset=eval_ds,
        data_collator=default_data_collator, callbacks=[OverfitTripwire()],
        args=TrainingArguments(
            output_dir=a.out, num_train_epochs=a.epochs, max_steps=a.max_steps,
            per_device_train_batch_size=1, gradient_accumulation_steps=a.grad_accum, learning_rate=a.lr,
            bf16=use_bf16, fp16=not use_bf16, max_grad_norm=1.0,
            warmup_ratio=0.05, weight_decay=0.01, lr_scheduler_type="cosine",
            eval_strategy="steps", eval_steps=max(5, len(train_ds) // a.grad_accum),
            load_best_model_at_end=True, metric_for_best_model="eval_loss", greater_is_better=False,
            logging_steps=2, save_strategy="steps", save_steps=max(5, len(train_ds) // a.grad_accum),
            save_total_limit=4, optim="paged_adamw_8bit",
            gradient_checkpointing=True, report_to="none"))
    # Resume from the newest checkpoint when the output dir already has one — a killed
    # run (timeout guard, session death) continues instead of retraining from step 0.
    import glob as _glob
    _ckpts = _glob.glob(os.path.join(a.out, "checkpoint-*"))
    trainer.train(resume_from_checkpoint=True if _ckpts else None)
    print(f"best checkpoint (held-out eval_loss): {trainer.state.best_model_checkpoint}")
    final = os.path.join(a.out, "final")
    model.save_pretrained(final); tok.save_pretrained(final)
    print(f"adapter saved -> {final}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
