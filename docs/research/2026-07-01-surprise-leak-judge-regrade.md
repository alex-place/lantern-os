# LLM-judge re-grade of the surprise-leak dataset — and a real bug the re-grade surfaced

**Date:** 2026-07-01
**Status:** research result (measured), plus a genuine bug fix.
**Loop stages:** Verify (the leak).
**Harness:** [`experiments/surprise_leak_judge_regrade.py`](../../experiments/surprise_leak_judge_regrade.py)

## What was tested

The [Layer-1 result](2026-06-30-surprise-leak-layer1-result.md) used a deterministic string
grader against gold answers, flagged in its own caveats as under-counting correctness (e.g.
"Charizard is a fire-type Pokemon" vs gold `"Fire/Flying"` reads as wrong to a string match, not
necessarily to a human). This re-grades the same 398 already-generated predictions (199 questions
× 2 models: qwen2.5-coder:1.5b, mistral:7b) with a local LLM judge
(`qwen2.5-coder:latest`, 7.6B, via Ollama), using the exact judge prompt from
`experiments/surprise_leak_ab.py`'s `judge()`, and recomputes AUROC with the new labels — no new
model generation, since the Layer-1 result files already carry the reply text and the
`field_uncertainty`/`mean_bits` scores to re-score against.

## A real bug, found by an implausible result

The first full run reported **0.0% hallucination rate on both datasets** — every single judged
answer came back "correct," and AUROC was undefined (one class empty) for every signal. That's
impossible on its face: the string grader (and Layer-1's own numbers) found 50-80% hallucination
on this dataset. The cause: `judge()`'s check —

```python
return "CORRECT" in (r.choices[0].message.content or "").upper()
```

— is a substring match, and `"INCORRECT"` **contains** `"CORRECT"` as a substring. Every time the
judge model correctly said "INCORRECT," the harness silently counted it as "correct." This bug is
in the **upstream** `experiments/surprise_leak_ab.py::judge()` too, not just the copy written for
this re-grade — anyone who has run `--judge-model` against that harness would have hit the same
silent mislabeling. Fixed here by checking for `"INCORRECT"` first:

```python
content = (response_text or "").upper()
if "INCORRECT" in content: return False
if "CORRECT" in content: return True
return None  # unparseable, not silently coerced either way
```

Not fixed in `surprise_leak_ab.py` itself in this pass (out of scope — this note documents the
bug and the working replacement so whoever touches that file next can apply the one-line fix).

**The general lesson:** an implausible, too-clean result (0% error rate here) is itself a signal
to audit the measurement code before trusting the phenomenon it claims to show — not the first
time this session a suspiciously uniform number turned out to be a bug rather than a finding.

## Result (after the fix)

| Dataset | n | judge halluc. rate | string halluc. rate | agreement | AUROC(mean_bits) judge vs string | AUROC(field) judge vs string |
|---|---|---|---|---|---|---|
| qwen2.5-coder:1.5b | 199 | 70.4% | 80.4% | 88.9% | 0.7246 vs 0.7622 | 0.5214 vs 0.5188 |
| mistral:7b | 199 | 39.7% | 50.3% | 86.4% | 0.8086 vs 0.7911 | 0.5000 vs 0.5000 |

Full per-row data: [`experiments/results/judge_regrade_surprise_leak_{qwen15b,mistral7b}.jsonl`](../../experiments/results/); raw summary: [`experiments/results/surprise_leak_judge_regrade_report.json`](../../experiments/results/surprise_leak_judge_regrade_report.json).

**The judge is consistently more lenient than the string grader** (lower hallucination rate on
both datasets, most notably mistral: 39.7% vs 50.3%, a 10.6-point gap) — consistent with the
Layer-1 caveat that the string grader over-counts wrongness. ~87-89% agreement between graders.

**But the AUROC deltas flip direction between datasets** (qwen: perplexity AUROC *drops*
0.762→0.725 under judge grading; mistral: it *rises* 0.791→0.809) — the opposite of a clean
"judge-grading recovers the AUROC the string grader was suppressing" story. A paired bootstrap
(2000 iters, resampling rows, same score vector scored against both label sets) on
Δ = AUROC(judge) − AUROC(string):

| Dataset | mean_bits Δ (95% CI) | field_uncertainty Δ (95% CI) |
|---|---|---|
| qwen2.5-coder:1.5b | −0.0365 [−0.0937, 0.0172] | +0.0027 [0.0008, 0.0055] |
| mistral:7b | +0.0176 [−0.0317, 0.0714] | 0.0000 [0.0000, 0.0000] |

**Both `mean_bits` CIs cross zero.** The re-grade does not produce a statistically significant
change in the perplexity baseline's AUROC in either direction, at n=199. The direction flip
between datasets is consistent with sampling noise, not a real effect. The `field_uncertainty`
(degenerate tailMass) signal is essentially unchanged and still near-chance regardless of grader
— its degeneracy (established at Layer 1) is not a string-grader artifact.

## Decision

**No change to the Layer-1 finding or any live behavior.** The string-grader AUROCs from Layer 1
stand as reported; this re-grade neither confirms nor refutes them with statistical confidence —
it shows the grader choice doesn't move the needle enough to detect at this sample size, using
this judge model. A larger n or a stronger/more consistent judge model would be needed to resolve
the direction with confidence; not attempted here (diminishing returns for this pass — the
practical `SURPRISE_CANARY` decision (#1679) was already answered by a different, unrelated
limitation, and doesn't hinge on this AUROC's exact value).

## Honesty notes (REAL / APPROX / caveat)

- **REAL:** all 398 judge calls, 0 errors, checkpointed per-row so a killed run resumes rather
  than silently dropping data.
- **REAL bug, REAL fix:** the substring-match bug and its correction are both directly verified
  (the buggy run's 0%/undefined-AUROC output vs the fixed run's plausible output).
- **Single judge model, no cross-judge check:** only one local model (`qwen2.5-coder:latest`)
  was used as judge — its own judgment quality/consistency wasn't independently validated against
  a second judge or a human sample. The "judge is more lenient" finding is relative to *this*
  judge, not an absolute ground truth.
- **Bootstrap not stratified:** the paired bootstrap resamples rows uniformly; with n=199 and a
  50-80% class imbalance in places, wide CIs are expected and are reported as such, not narrowed
  by any post-hoc adjustment.
