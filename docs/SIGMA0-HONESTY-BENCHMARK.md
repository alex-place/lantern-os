# Σ₀ Honesty Benchmark — results + competitor comparison

Two complementary benchmarks measure the **same honesty axis** — does a model *decline* on
what it can't verify, or *confabulate* a confident answer? — on two opposite difficulty
distributions. Neither replaces the other, and (this matters) their scores are **not directly
comparable**.

- **Our golden mark** (this repo, `experiments/sigma0_seed_facts.py`) — a *floor* test on
  **famous** facts + **famous** negatives. Easy knowledge, hard honesty. Answer-key web-validated
  2026-07-05 (`data/sigma0/golden_web_validation.json`, zero mislabels).
- **SimpleQA-Verified** (Google DeepMind, external) — a *ceiling* test on **obscure long-tail**
  facts. Hard knowledge. Registered in [`BENCHMARKS.md`](BENCHMARKS.md#simpleqa-verified--📋-planned).

---

## Table 1 — our golden mark (159 questions, 42 negatives)

Every model gets the identical structured prompt + the same `score_candidate()` metric.
**`confabulation_rate`** = fraction of the 42 negatives (open conjectures, refuted claims,
aphorisms) asserted as established fact — **lower is more honest**. This is the honesty axis;
raw `golden` score alone is not (see always-assert below).

| Model | golden | confab-rate | over-abstain | source |
|---|---|---|---|---|
| oracle (perfect key) | 1.00 | 0.0% | 0% | baseline (computed) |
| **GPT-4o-mini (OpenAI)** | **0.95** | **0.0%** | 6% | ✅ live, `gpt-4o-mini`, temp 0, 2026-07-04 |
| always-assert-PROVEN | 0.65 | **100%** | 0% | baseline (computed) |
| random | 0.57 | 52.4% | 31.6% | baseline (computed) |
| always-abstain | 0.41 | 0.0% | 100% | baseline (computed) |
| **Our local model (honest Ouro)** | **UNMEASURED** | (target → 0%) | (target: low) | blocked on serve format-mismatch (#2033) |

**The result that matters:** GPT-4o-mini confabulated on **0 of the 42 negatives** — it declined to
call P≠NP "proven", the aether "real", or Moore's "law" a law. Meanwhile **always-assert scores
higher on raw golden (0.65) than always-abstain (0.41) while confabulating 100%** — proving that
**confabulation-rate, not raw accuracy, is the honesty axis**. The golden set is a *floor*: any
honest frontier model should pass it near-perfectly; its discriminating power is on **weaker /
local** models (our own honest-Ouro, still unmeasured).

### Honest measurement caveat (2026-07-05 session)
Of the five cloud providers wired into `sigma0_live_bench.py`, **only OpenAI had valid credentials
this session** — Grok `403` (team out of credits), Gemini `429` (free-tier quota exhausted),
Mistral/Anthropic `401` (keys invalid/expired). So the golden table has one live frontier row, not
five. This is a **credentials limit, not a benchmark result** — and adding more frontier rows would
be low-information anyway (they'd all cluster near 0.95/0%-confab on a floor set). The genuine
multi-competitor comparison is Table 2.

---

## Table 2 — SimpleQA-Verified competitors (external, published)

Real, sourced, **same honesty axes** (accuracy split from attempt-rate). From Table 7 of
[arXiv:2509.07968](https://arxiv.org/abs/2509.07968) (Google DeepMind, Sept 2025); every value
web-verified against the paper 2026-07-05.

| Model | Accuracy | Attempted | Hedged | Acc.\|Attempted | **F1** |
|---|---|---|---|---|---|
| Gemini 2.5 Pro | 55.3 | 98.9 | 1.1 | 55.9 | **55.6** |
| GPT-5 | 50.9 | 94.6 | 5.4 | 53.8 | **52.3** |
| o3 | 51.6 | 99.3 | 0.7 | 52.0 | **51.9** |
| GPT-4.1 | 39.8 | 99.3 | 0.7 | 40.1 | **39.9** |
| GPT-4o | 34.4 | 97.0 | 3.0 | 35.5 | **34.9** |
| DeepSeek R1 | 32.7 | 96.4 | 3.6 | 33.9 | **33.3** |
| Claude Opus 4 | 19.2 | 35.5 | 64.5 | 54.1 | **28.3** |

---

## Why the two tables are complementary, not comparable

A **0.95 on our set does not map to a ~0.55 F1** on SimpleQA-Verified — the difficulty
distributions are opposite (famous vs. long-tail). Reading across the two tables as one ranking
would be dishonest. What legitimately transfers is the **metric philosophy**:

> DeepMind reports Accuracy, Attempted, Hedged, and F1 as **separate columns** for exactly the
> reason our mark reports `confab-rate` and `over-abstain` separately from `golden` — raw accuracy
> conflates *honesty* with *knowledge*.

**Claude Opus 4 is the clearest proof:** just **19.2% raw accuracy**, but **54.1% accuracy-given-
attempted** — nearly Gemini's 55.9 — because it **hedges 64.5%** of the time instead of guessing.
Under raw accuracy it looks worst; under the honesty-aware F1 it is calibrated, not ignorant. That
is the same distinction always-abstain (0.41, 0% confab) vs always-assert (0.65, 100% confab)
draws in Table 1 — external, independent validation of this benchmark's design.

---

## Reproduce

```bash
python experiments/sigma0_golden_benchmark.py          # baselines (no network, deterministic)
python experiments/sigma0_live_bench.py --models gpt   # live frontier row (needs OPENAI_API_KEY)
python -m pytest tests/test_golden_web_validation.py    # answer-key coverage is web-validated + enforced
```

The honest open item is **Table 1's last row**: measure our own honest-Ouro on the golden set once
the train/serve prompt-format mismatch (#2033) is fixed — that is the whole point of the exercise.
