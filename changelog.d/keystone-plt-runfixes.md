### Fixed
- **Keystone-Σ₀ PLT package — run-fixes from first on-box execution** (`models/keystone-sigma0-plt/`).
  Verified end-to-end on an 8 GB RTX 3070: the blind PyTorch port loads the Apache-2.0 weights with
  **0 missing / 0 unexpected keys** (the module tree matches the checkpoint exactly), fits in **5.71 GB**
  at 4-bit, and generates correct Python (`return s == s[::-1]`, `if n == 0:`). Fixes surfaced by that run:
  `download_and_patch.py` now adds a UTF-8 stdout guard (Windows cp1252 consoles crashed on the status
  glyphs) and patches `tokenizer_config.json` to the self-contained fast tokenizer (drops the missing
  vendor `tokenization_*.py` auto_map); `check_parity.py` drops `token_type_ids` before `generate()` and
  adds a fast single-forward next-token sanity check + peak-VRAM report. NOTE: this is structural/
  functional validation, **not** definitive faithful parity — that still needs the vLLM `--ref` logit
  check on a ≥24 GB box (ADR-0011 Stage 0).
