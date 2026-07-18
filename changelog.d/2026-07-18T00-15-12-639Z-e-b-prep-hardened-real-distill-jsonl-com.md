### Fixed

- E-B prep hardened + real distill.jsonl committed: eb_prep_corpus.py now uses MBPP full (974), auto-scales the partition to the available eval pool, and makes rlvr/partition best-effort so it always produces the SFT data (distill 2000 verified OpenCodeInstruct records, decontaminated). Committing distill.jsonl lets the Lightning/Modal worker skip prep-on-worker (which crashed in the datasets/torch import), so a dispatch completes
