### Added
- **Σ₀ golden benchmark runner (`experiments/sigma0_golden_benchmark.py`).** Scores any model's answers on the 159-record golden dataset with the DeepEval-style scorer + real baselines. The honesty axis is confabulation_rate (fraction of the 42 negatives asserted as fact). Measured: oracle 1.00 (0% confab), always-assert-PROVEN 0.65 (100% confab), always-abstain 0.41 (0% confab), random 0.57 (52% confab) — empirically, raw score rewards the confident-liar over the honest-abstainer, so confabulation is the honesty signal. Strengthens **Verify**.

