Σ₀-RC1 spec: adopted the free wins from the 2026 sampling literature — min-p 0.1 at temp 1.0
replaces top-p for the N-sample ladder (training-free diversity+quality, validated 1B-123B),
sequential sampling with early-stop-on-verified pinned as harness behavior (N is a cap, not a
batch), and the queued adopt-and-measure list (prompt-lookup on repair steps, 0.5B-draft
speculative decoding for CPU rows, EAGER entropy-gated branching, INT4 KV).
