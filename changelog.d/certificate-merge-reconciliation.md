### Σ₀ Collapse Certificate — merge reconciliation + re-verification

Reviewed and completed the certificate now that #1997 merged. Fixed the stale status line that
said the §7.2/§7.3 honesty hardening + #1990/#1991 measurements were "staged on the open PR
#1997, not yet in master" — they are now in `master`; added a 2026-07-04 merge-reconciliation
maintenance log and the missing `[#1997]` reference definition.

Re-verified this pass (not asserted): `pytest tests/test_cio_sde.py` → **46 passed, 0 xfail**;
all 11 referenced artifacts resolve (the `sigma0_*`/`router_*` scripts, the trigger/ROA reports,
`golden_dataset.jsonl` at 159 records, `live_bench_results.json`, `collapse.py`, the `.tex`).

The two open frontiers are left **honestly open**, not fabricated closed: **#1990**
(trigger→theorem) is calibrated-not-proven (precision 1.0, recall ≈0.08), **#1991** (local→global
ROA) is a validated first cut (sublevel-invariance PROVEN via LaSalle; `c*` MEASURED). Upgrading
either to PROVEN needs a machine-checked theorem this pass does not claim.
