---
title: lantern-sigma0-coder — retired model, repurposed directory
updated: 2026-07-21
---

# `models/lantern-sigma0-coder/` — retired model, repurposed directory

**The model is retired.** `lantern-sigma0-coder` was a Qwen2.5-Coder-3B QLoRA adapter,
sunset when the Ollama coder was dropped (#811 / #823). **Its weights are deleted** —
there is no live Qwen2.5-Coder model under this name.

**The directory, however, is not dead.** It now holds two *live* training datasets for
the current **Ouro** coder (kept there for path stability with the scripts that write
them):

| File | Rows | Written by | Contents |
|---|---|---|---|
| `humaneval-train.jsonl` | ~15,000 | `scripts/build_humaneval_corpus.py` (`OUT_DEFAULT`) | Magicoder OSS-Instruct + exec-filtered self-oss-instruct + MBPP train/validation/prompt splits, **13-gram decontaminated vs HumanEval**. Anchored the 2026-07-13 distillation run (`docs/research/2026-07-13-ouro-mbpp-distillation.md`). |
| `coding-seed.jsonl` | 6 | `scripts/build_ouro_coding_dataset.py` (`SEED_PATH`) | Small hand-seeded coding examples. |

## Why this note exists (#2525)

Auditing `models/` by name reads `lantern-sigma0-coder/` as a stale, retired-model
package — but the datasets inside are actively consumed by the Ouro coding pipeline.
Rather than move the files (which would touch several writers/readers and the training
scripts), this note documents the true current contents in place. (It also cannot live
as a `README.md` inside `models/` — the anti-sprawl gate blocks new tracked files under
that non-allowlisted top-level directory — so it lives here, where the original
`lantern-sigma0-coder` tombstone doc did.)

**Historical:** `training-data.jsonl` (243 rows), once referenced by
`scripts/build_humaneval_corpus.py`, was **deleted in #1850** and no longer exists.

**Optional follow-up:** relocate the two datasets to a neutral home (e.g.
`data/training/ouro-coder/`, an allowlisted top-level dir) and update
`build_humaneval_corpus.py` (`OUT_DEFAULT`), `build_ouro_coding_dataset.py`
(`SEED_PATH`), and any distillation / continual-pipeline readers, then delete this note.
