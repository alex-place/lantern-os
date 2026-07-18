### Added

- E-B Step-0 corpus prep (scripts/eb_prep_corpus.py) + data-path bug fix: pulls license-verified open datasets (OpenCodeInstruct CC-BY, Eurus-2-RL MIT, LiveCodeBench held-out) into distill/replay/rlvr + a seeded decontaminated partition with a post-cutoff-LiveCodeBench hidden block; fixes the dispatch scripts hardcoding a training-data path that was never in the repo (now OURO_TRAIN_DATA -> data/eval/distill.jsonl, prep-if-missing on the worker)
