### Σ₀ serving-layer model design v1 (Fable-max deliverable, adjudicated + adopted pending E1)

Adds `docs/SIGMA0-MODEL-DESIGN.md`: the max-effort design run against the serving brief, with the
orchestrator's adjudication header. Headline outcomes: stay Ouro-1.4B (gated 2.6B falsifier);
de-gloss + 4x the golden key with six negative statuses + perturbed-positives + LOSO splits;
SFT->DPO where preference pairs are the ordinal shadow of the strictly-proper honesty reward;
serve-time gating on decision-token free-logprob (rank!=route respected); constrained decoding
makes train==serve format structural; watched-vs-unwatched closed by unconditional claim logging +
post-hoc council audit feeding the corpus flywheel.

The run also produced a genuinely new MEASURED finding, independently verified by the
orchestrator: **the golden key's negatives self-gloss their status in-text (42/42 by the agent's
count; 36/42 by a cruder independent regex) vs ~1-3/117 positives** — a first-order
shortcut-learning hazard that tempers the 10%-confab headline until E1 (de-glossed re-eval of the
existing adapter, ~free) runs. Also caught: corpus drift (brief 137 rows vs 147/51.7% on disk,
verified exact) and the un-merged certificate §3.1 (#2157). E1-E8 experiment ladder included,
cheapest-first, each with what it can falsify.
