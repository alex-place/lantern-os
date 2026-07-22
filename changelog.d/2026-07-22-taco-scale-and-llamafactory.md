### Added

- **spiral: TACO-scale corpus path + LlamaFactory adoption (founder-directed borrows).** License
  triage first (records `cr-mrwclxc3` + amendment `cr-mrwcmob0`): KodCode's *dataset* is
  CC BY-NC 4.0 — usable for research now (unisona is not commercial yet), but NC-trained weights
  get tagged `nc-contaminated`; the Apache KodCode *pipeline* is the clean borrow. **TACO** is the
  primary scale corpus: `scripts/fetch_taco.py` normalizes `likaixin/TACO-verified` (12,898
  problems with verified solutions + executable stdio tests; canonical BAAI/TACO uses a legacy
  loading script modern `datasets` refuses).
- **spiral: stdio verifier mode.** `makeVerifier` now runs TACO/competitive-style
  `{stdin, expected}` tests — a base64-embedded Python wrapper patches stdin, captures stdout,
  and asserts normalized equality in the same bounded sandbox. Correct-passes/wrong-fails proven
  by real exec + a python-guarded unit test.
- **spiral: honest escalation.** A cloud escalate leg now retries with backoff and falls over to
  the OTHER cloud legs only — if no cloud tier answers it FAILS ("") instead of silently degrading
  to the same local model it was called to rescue (the suspected cause of the VTD batch-2 rescue
  collapse, 36 → 9).
- LlamaFactory (Apache-2.0) installing into its own venv (`D:\venvs\llamafactory`) as the Phase-1
  trainer going forward — native dataset **mixing** is the retention-mix fix run 2 called for.
