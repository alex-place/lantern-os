# Does forcing recurrent depth improve Ouro's output? (Trilogy hardening)

**Date:** 2026-07-04 · **Evidence class:** MEASURED · **Loop stage:** Reason
**Artifacts:** `experiments/sigma0_depth_accuracy.py`, `data/sigma0/depth_accuracy_report.json`

## Why

Hardening the three Ouro-internals measurements from today:
- **#1** the recurrent loop is stable (`sigma0_loop_jacobian`) — so forcing more depth is *safe*.
- **#2** the internal state encodes truth, and that signal *strengthens* with depth 0.79→0.99
  (`sigma0_hidden_probe`) — does the **output** track it?
- **#3** the Q-exit gate is only weakly adaptive (`sigma0_qexit_adaptive`) — but that used a weak
  entropy proxy. Replace it with **real correctness**.

So: force `total_ut_steps ∈ {1,2,3,4,6,8}` and measure whether the model prefers the *true*
completion (higher mean fill log-prob) on two sets — length-matched **facts** and 2-digit
**arithmetic** (true product vs off-by-10).

## Results

```
depth:    1     2     3     4     6     8
facts: 0.33  0.35  0.35  0.35  0.35  0.35
arith: 1.00  1.00  0.93  0.93  0.93  0.93
```

**Valid finding (arith — the clean test):** forcing more recurrent depth does **not** improve output
accuracy. Arithmetic is flat 1.00 → 0.93 across depths 1→8, even dipping slightly *past* the trained
depth 4. The recurrent loop's value at inference is not test-time accuracy on these tasks (its win is
training-time parameter-efficiency, per the Ouro paper). This reinforces **#3**: a weakly-adaptive
gate isn't leaving accuracy on the table, because the depth wasn't buying accuracy anyway.

**A third confound, caught:** the *facts* logprob-comparison is invalid. It sits **below chance**
(0.34), and the control settles it — with a clearly-**implausible** false fill the model does *worse*
(**0.17**), not better. If plausibility were the problem, absurd distractors would be easy. Instead
an absurd word **beats the true answer**, which proves the comparison is dominated by the fill words'
**base rate** (token frequency/length), not truth. So `P(true fill) vs P(false fill)` is not a truth
measure here and is discarded. (Arith is clean because 391 vs 401 have matched base rates, so context
dominates.)

## Reading

1. **Depth doesn't help the output at inference** (clean arith), consistent with the stable-but-not-
   test-time-useful loop (#1) and the weak gate (#3).
2. **The caught base-rate confound reinforces #2's method.** Output logprobs are confounded; a
   *supervised* probe on the hidden state (0.99, confound-controlled) is the reliable readout — which
   is exactly the mid-2026 research thesis (hidden-state probes ≫ logit/output signals). So the
   internal truth signal (#2) is real, but a naive output comparison can't see it — you have to probe
   the state.

This is the third text-surface/base-rate trap caught today (after ρ=1.064's features and HaluEval's
answer length). The pattern holds: the honest signal lives in controlled measurement, and every
"too good / too strange" number was an artifact until proven otherwise.

## Caveats

The clean depth signal is arith-only (15 problems); the facts route is confounded (reported, not
used). fp16, Ouro-1.4B-Thinking, self-authored minimal pairs, depths > 4 exceed the trained operating
point. MEASURED pilot, not PROVEN.
