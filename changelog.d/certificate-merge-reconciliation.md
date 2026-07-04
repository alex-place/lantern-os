### Σ₀ Collapse Certificate — merge reconciliation + re-verification

Reviewed and completed the certificate now that #1997 merged. Fixed the stale status line that
said the §7.2/§7.3 honesty hardening + #1990/#1991 measurements were "staged on the open PR
#1997, not yet in master" — they are now in `master`; added a 2026-07-04 merge-reconciliation
maintenance log and the missing `[#1997]` reference definition.

Re-verified this pass (not asserted): `pytest tests/test_cio_sde.py` → **46 passed, 0 xfail**;
all 11 referenced artifacts resolve (the `sigma0_*`/`router_*` scripts, the trigger/ROA reports,
`golden_dataset.jsonl` at 159 records, `live_bench_results.json`, `collapse.py`, the `.tex`).

**#1991 ROA — MEASURED → PROVEN (machine-checked).** Then closed the certification half of #1991:
the grid-measured basin `c*≈2.307` is now a **rigorous** inner region-of-attraction bound.
`experiments/sigma0_roa_certify.py` proves `V̇<0` on `{V≤2.25}` via an exact origin-ball lemma
(`|N|≤3‖x‖⁴`) + **interval branch-and-bound** with directed-rounding arithmetic (`mpmath.iv`, 2323
boxes, 0 undecided) — 97.5% of the grid optimum. A control at `c_L=2.5` (above `c*`) correctly
**fails** to certify (the test has teeth). New `tests/test_sigma0_roa_certified.py` (4 tests) ⇒ **50
cert tests passing**; §5 + source-of-record updated.

**#1990 left honestly open**, not fabricated closed: the trigger→theorem gap is calibrated-not-proven
(precision 1.0, recall ≈0.08) — a heuristic min-gate does not obviously imply the spectral condition
and may not be provable in general.
