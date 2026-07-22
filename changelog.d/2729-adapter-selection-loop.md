- QLoRA trainer (#2729) gains the missing selection loop: a held-out val split +
  eval every 50 steps + load_best_model_at_end (was selection-blind, kept the last
  step). Recipe fixes: dropout 0, weight_decay 0.01, cosine, warmup 0.05, 3 epochs
  (~375 steps, not a fixed 600), overfit tripwire. Modal dispatch defaults to
  epochs, not --steps 600; fixes the latent --resume_from arg.
