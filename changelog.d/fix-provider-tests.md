### Fixed
- `train-qlora-ouro.py` + Kaggle script: monkey-patch `ROPE_INIT_FUNCTIONS['default']` — removed in transformers>=4.53, breaks OuroRotaryEmbedding on Kaggle Python 3.12
- Kaggle script: pin `transformers>=4.40,<4.53` to avoid the breaking change on pre-install
- `training-dispatcher.js`: fix Paperspace API base URL `api.paperspace.io` → `api.paperspace.com`
- `lightning_dispatch.py`: fix full remote path in `studio.run()` (was using bare filename, CWD mismatch); fix `start()` when already-Running studio raises error; fix TRAIN_SCRIPT to clone lantern-os repo + use correct `train-qlora-ouro.py` name
- `training-dispatcher.js`: skip `--checkpoint-uri` flag when empty (argparse `expected one argument` crash)
