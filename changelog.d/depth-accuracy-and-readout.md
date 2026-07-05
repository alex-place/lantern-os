### Trilogy hardening: forcing recurrent depth doesn't improve Ouro's output (+ a 3rd confound caught)

`experiments/sigma0_depth_accuracy.py` hardens today's Ouro-internals trilogy — replaces the weak
entropy proxy in `sigma0_qexit_adaptive` with real correctness and asks whether the internal truth
signal (`sigma0_hidden_probe`, 0.79→0.99 with depth) reaches the OUTPUT. Forcing
`total_ut_steps ∈ {1,2,3,4,6,8}`:

- **VALID (clean arith, matched-magnitude options): depth does NOT improve output accuracy** — flat
  1.00 → 0.93 across depths 1→8, dipping slightly *past* the trained depth 4. The recurrent loop's
  win is training-time parameter-efficiency, not test-time accuracy here (reinforces the weak-gate
  finding: depth wasn't buying accuracy anyway).
- **A third confound, caught:** the facts logprob-comparison is base-rate CONFOUNDED — it sits below
  chance (0.34), and the control settles it: with a clearly-*implausible* false fill the model does
  *worse* (0.17), i.e. an absurd distractor beats the truth, so `P(true) vs P(false)` is dominated by
  fill word frequency, not truth. Discarded. This is exactly why the supervised hidden-state PROBE
  (0.99, confound-controlled) beats output logprobs — the mid-2026 research thesis.

Third text-surface/base-rate trap caught today (after ρ=1.064's features and HaluEval's answer
length). MEASURED pilot (`data/sigma0/depth_accuracy_report.json`); caveats: clean signal is
arith-only (15 problems), facts route confounded, fp16, Ouro-1.4B. See
`docs/research/2026-07-04-depth-accuracy-and-readout.md`.
