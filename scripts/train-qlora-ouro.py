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


def load_training_records(path):
    """Accept the Kaggle JSON array and legacy local JSONL files."""
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else [parsed]
    except json.JSONDecodeError:
        records = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return records


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="ByteDance/Ouro-1.4B")
    # Default data comes from the E-B prep pipeline (scripts/eb_prep_corpus.py), NOT the
    # old models/lantern-sigma0-coder/training-data.jsonl path — that file was never in the
    # repo, so the default silently pointed at nothing (every dispatch failed at data-load).
    # Override with $OURO_TRAIN_DATA or --data.
    ap.add_argument("--data", default=os.environ.get("OURO_TRAIN_DATA", "data/eval/distill.jsonl"))
    ap.add_argument("--out", default="D:/lantern-train/ouro-sigma0-adapters")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--max-steps", type=int, default=-1, help="override epochs (smoke test); -1 = use epochs")
    ap.add_argument("--resume", default=None, help="resume training: 'auto' finds latest checkpoint in --out, or pass a checkpoint dir path")
    ap.add_argument("--warm-start", default=None, help="load LoRA weights (adapter_model.safetensors) from this checkpoint dir as init; fresh optimizer/scheduler/step-count (safetensors-only, no torch.load — sidesteps CVE-2025-32434's torch>=2.6 gate on --resume)")
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--lora-r", type=int, default=16, help="LoRA rank; alpha=2*r (handoff recipe: 32)")
    ap.add_argument("--seq", type=int, default=1536)  # audited p99=1219 on the FC corpus; 1024 truncates 3% from the END (cuts the tool call)
    ap.add_argument("--val-size", type=int, default=100, help="held-out val records for best-checkpoint selection (#2729)")
    ap.add_argument("--seed", type=int, default=int(os.environ.get("OURO_SEED", "42")),
                    help="RNG seed for the val split + weight init + data order (TrainingArguments seed/data_seed). "
                         "Vary across runs of the SAME recipe to get an honest multi-seed variance estimate — a "
                         "single-seed pass@1 can't separate a real lift from single-problem noise at n=164 (#2766).")
    ap.add_argument("--tripwire-loss", type=float, default=float(os.environ.get("OURO_TRIPWIRE_LOSS", "0.2")),
                    help="abort if TRAIN loss < this before epoch 2 (crude memorization guard). Set 0 to DISABLE "
                         "and rely on the held-out val best-checkpoint selection — which is the proper overfit guard "
                         "and only runs at eval_steps=50, so a hot-LR tripwire can fire before it ever evaluates (#2729).")
    a = ap.parse_args()

    # datasets must be imported before torch on Windows to avoid pyarrow/CUDA DLL conflict
    from datasets import Dataset
    import torch
    from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig,
                              Trainer, TrainingArguments, default_data_collator)
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    # Monkey-patch: Ouro-1.4B's modeling_ouro.py looks up ROPE_INIT_FUNCTIONS['default']
    # which was removed in transformers>=4.53. Restore it if missing.
    try:
        from transformers.modeling_rope_utils import ROPE_INIT_FUNCTIONS, _compute_default_rope_parameters
        if "default" not in ROPE_INIT_FUNCTIONS:
            ROPE_INIT_FUNCTIONS["default"] = _compute_default_rope_parameters
            print("patched: ROPE_INIT_FUNCTIONS['default'] restored")
    except Exception as _rope_e:
        print(f"rope patch skipped: {_rope_e}")

    print(f"CUDA: {torch.cuda.is_available()} | base: {a.base}")
    if not torch.cuda.is_available():
        print("ERROR: CUDA required."); return 1

    # bf16 over fp16 on Ampere+ : fp16 QLoRA on this reasoning-LM overflows gradients
    # (observed grad_norm=nan on a smoke run), which max_grad_norm clipping then
    # propagates into the LoRA weights -> a NaN/garbage adapter. bf16 has fp32's
    # exponent range, so no overflow. Fall back to fp16 only if bf16 is unsupported.
    #
    # bf16 needs Ampere (cc>=8.0). torch.cuda.is_bf16_supported() returns a FALSE
    # POSITIVE on pre-Ampere cards (it passed on a Kaggle P100, cc 6.0), after
    # which the first bf16 op crashes with `CUDA error: no kernel image is
    # available for execution on the device`. Gate on the hardware capability so
    # T4 (7.5) and P100 (6.0) correctly drop to fp16. NOTE: this model's recipe
    # really wants bf16 — pre-Ampere fp16 risks the NaN adapter described above,
    # so an Ampere GPU (Lightning A10, Colab A100/L4) is the right target.
    _cc = torch.cuda.get_device_capability()
    use_bf16 = torch.cuda.is_bf16_supported() and _cc >= (8, 0)
    compute_dtype = torch.bfloat16 if use_bf16 else torch.float16
    print(f"precision: {'bf16' if use_bf16 else 'fp16'} (cc {_cc[0]}.{_cc[1]})")

    tok = AutoTokenizer.from_pretrained(a.base, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    from transformers import AutoConfig
    cfg = AutoConfig.from_pretrained(a.base, trust_remote_code=True)
    # OuroConfig (newer transformers / Python 3.12) may lack pad_token_id — set it from bos.
    if not hasattr(cfg, "pad_token_id") or cfg.pad_token_id is None:
        cfg.pad_token_id = getattr(cfg, "bos_token_id", tok.pad_token_id)

    # bitsandbytes 4-bit (nf4) kernels are only compiled for compute capability
    # >= 7.5 (Turing+). On a Pascal P100 (cc 6.0) — which Kaggle assigns at random
    # alongside T4 — loading a 4-bit model crashes mid-run with
    # `CUDA error: no kernel image is available for execution on the device`.
    # Ouro-1.4B is small enough to fit unquantized on a 16 GB card, so on older
    # GPUs we skip 4-bit and load in compute_dtype with plain (non-Q) LoRA.
    use_4bit = _cc >= (7, 5)
    print(f"GPU cc: {_cc[0]}.{_cc[1]} | 4-bit QLoRA: {use_4bit}")

    load_kwargs = dict(config=cfg, device_map="auto", trust_remote_code=True)
    if use_4bit:
        load_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=compute_dtype, bnb_4bit_use_double_quant=True)
    else:
        load_kwargs["torch_dtype"] = compute_dtype

    try:
        model = AutoModelForCausalLM.from_pretrained(
            a.base, **load_kwargs,
            attn_implementation="sdpa")   # ouro_serve.py has used sdpa since #775; mirror here
    except (ValueError, TypeError):
        model = AutoModelForCausalLM.from_pretrained(a.base, **load_kwargs)
    model.config.use_cache = False
    if use_4bit:
        model = prepare_model_for_kbit_training(model)
    else:
        # Non-quantized LoRA still needs grad checkpointing + input grads for
        # memory; prepare_model_for_kbit_training's non-quant equivalents.
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()
    # all-linear is robust for a custom (trust_remote_code) architecture whose
    # exact projection names we don't want to hardcode.
    model = get_peft_model(model, LoraConfig(
        r=a.lora_r, lora_alpha=2 * a.lora_r, lora_dropout=0.0, bias="none",  # dropout 0 at 2k scale (#2729 recipe)
        task_type="CAUSAL_LM", target_modules="all-linear"))
    model.print_trainable_parameters()

    if a.warm_start:
        from safetensors.torch import load_file
        sd = load_file(os.path.join(a.warm_start, "adapter_model.safetensors"))
        # saved adapter files omit the adapter name (e.g. "...lora_A.weight"); the live
        # PeftModel's state dict expects it re-inserted (e.g. "...lora_A.default.weight").
        # peft's own set_peft_model_state_dict auto-remap is unreliable on this stack (only
        # matched 69/338 keys, silently leaving the rest at random LoRA init) — load directly.
        sd = {(k[:-len(".weight")] + ".default.weight" if k.endswith(".weight") else k): v
              for k, v in sd.items()}
        res = model.load_state_dict(sd, strict=False)
        missing_lora = [k for k in res.missing_keys if "lora_" in k]
        unexpected_lora = [k for k in res.unexpected_keys if "lora_" in k]
        print(f"warm-started LoRA weights from {a.warm_start} "
              f"(missing_lora={len(missing_lora)}, unexpected_lora={len(unexpected_lora)})")
        if missing_lora or unexpected_lora:
            raise RuntimeError(f"warm-start key mismatch: missing={missing_lora[:3]} "
                                f"unexpected={unexpected_lora[:3]} — refusing to train from a "
                                f"partially-random adapter; fix the key remap")

    rows = []
    records = load_training_records(a.data)
    for r in records:
        if not isinstance(r, dict):
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

    # ── Selection loop (#2729) — the real bug this fixes ────────────────────────────────
    # Without a val split + best-checkpoint selection the trainer is SELECTION-BLIND: it
    # keeps the LAST step, not the BEST, which violates the freshness law (Σ_G §1 —
    # internal signals must select on held-out truth, not the training set). 2026 LoRA
    # consensus (Thinking Machines `lora_without_regret`; Unsloth): a small held-out val
    # split, eval every 50 steps, `load_best_model_at_end` on eval_loss.
    val_size = min(a.val_size, max(1, len(ds) // 5))
    split = ds.train_test_split(test_size=val_size, seed=a.seed, shuffle=True)
    train_ds, eval_ds = split["train"], split["test"]
    print(f"train rows: {len(train_ds)}  val rows: {len(eval_ds)} (held-out for best-checkpoint selection)")

    # Overfit tripwire (#2729): if train loss collapses below 0.2 before the model has seen
    # the corpus twice (epoch 2), we are memorizing noise, not learning signal — abort and
    # keep the best checkpoint found so far rather than shipping a memorized adapter.
    from transformers import TrainerCallback

    class OverfitTripwire(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kwargs):
            thr = a.tripwire_loss
            if (thr > 0 and logs and "loss" in logs and state.epoch is not None
                    and state.epoch < 2.0 and logs["loss"] < thr):
                print(f"OVERFIT TRIPWIRE: train loss {logs['loss']:.3f} < {thr} at epoch "
                      f"{state.epoch:.2f} (< 2) — aborting to avoid a memorized adapter.")
                control.should_training_stop = True
            return control

    os.makedirs(a.out, exist_ok=True)
    trainer = Trainer(
        model=model, train_dataset=train_ds, eval_dataset=eval_ds,
        data_collator=default_data_collator,  # tok_fn already padded + built masked labels; don't let the LM collator overwrite them
        callbacks=[OverfitTripwire()],
        args=TrainingArguments(
            output_dir=a.out, num_train_epochs=a.epochs, max_steps=a.max_steps,
            per_device_train_batch_size=1,
            # effective batch 16 → ~3 epochs of 2k records ≈ 375 steps (NOT the old fixed 600)
            gradient_accumulation_steps=16, learning_rate=a.lr,
            bf16=use_bf16, fp16=not use_bf16, max_grad_norm=1.0,
            warmup_ratio=0.05, weight_decay=0.01, lr_scheduler_type="cosine",  # #2729 recipe
            eval_strategy="steps", eval_steps=50,                              # selection loop
            load_best_model_at_end=True, metric_for_best_model="eval_loss", greater_is_better=False,
            logging_steps=10, save_strategy="steps", save_steps=50, save_total_limit=12,
            optim="paged_adamw_8bit", seed=a.seed, data_seed=a.seed,
            gradient_checkpointing=True, report_to="none"))
    resume_arg = True if a.resume == "auto" else (a.resume or None)
    trainer.train(resume_from_checkpoint=resume_arg)
    print(f"best checkpoint selected on held-out eval_loss: {trainer.state.best_model_checkpoint}")

    final = os.path.join(a.out, "final")
    model.save_pretrained(final); tok.save_pretrained(final)
    print(f"adapter saved -> {final}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
