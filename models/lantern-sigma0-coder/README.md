# `models/lantern-sigma0-coder/` — repurposed directory (read this first)

**This directory's name is historical.** It was the package for the **retired**
Qwen2.5-Coder-3B QLoRA adapter ("lantern-sigma0-coder"), sunset when the Ollama coder
was dropped (#811 / #823). **Those model weights are deleted** — there is no live
Qwen2.5-Coder model here.

**What the directory actually holds now** are two *live* training datasets for the
current **Ouro** coder (kept here for path stability with the scripts that write them):

| File | Rows | Built by | Contents |
|---|---|---|---|
| `humaneval-train.jsonl` | ~15,000 | `scripts/build_humaneval_corpus.py` (its `OUT_DEFAULT`) | Magicoder OSS-Instruct + exec-filtered self-oss-instruct + MBPP train/validation/prompt splits, **13-gram decontaminated vs HumanEval**. Anchored the 2026-07-13 distillation run (`docs/research/2026-07-13-ouro-mbpp-distillation.md`). |
| `coding-seed.jsonl` | 6 | `scripts/build_ouro_coding_dataset.py` (its `SEED_PATH`) | Small hand-seeded coding examples. |

## Why this README exists (#2525)

Auditing `models/` by name reads this as a stale, retired-model package — but the
datasets inside are actively consumed by the Ouro coding pipeline. Rather than move the
files (which would touch several writers/readers and the training scripts), this README
documents the true current contents in place.

Historical note: `training-data.jsonl` (243 rows), once referenced by
`scripts/build_humaneval_corpus.py`, was **deleted in #1850** and no longer exists here.

If/when these datasets are relocated to a neutral home (e.g. `data/training/ouro-coder/`),
update `build_humaneval_corpus.py` (`OUT_DEFAULT`), `build_ouro_coding_dataset.py`
(`SEED_PATH`), and any distillation/continual-pipeline readers, and delete this note.
