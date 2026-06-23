### Fixed
- `train-qlora-ouro.py`: load `AutoConfig` first and patch missing `pad_token_id` on `OuroConfig` before model init — fixes `AttributeError: 'OuroConfig' object has no attribute 'pad_token_id'` on Kaggle Python 3.12 / newer transformers
