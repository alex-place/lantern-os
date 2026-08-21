### Research — the convergence ledger audited against its own writer

The template from the benchmark-label audit pointed at our own core object. Five findings, each
verified in code and data (scripts/audit_convergence_ledger.py, n=1230): confidence is a
retrieval-outcome code rather than a probability, so calibration reads of the ledger are circular
by construction; 89% of grounded claims rest on a two-keyword grep that cites any file listing
the words ("add(5,7) returns 12" is grounded by a skills doc); the web confirmation tier has
never fired once; only 20 of 638 claims were ever refuted, so refuted:false means never
challenged; and 493 records — 40% of the ledger, 63% of everything at confidence ≥0.75 — are
security-test prompts the eval suite wrote through the production agent into the production
store. Quarantine list shipped; five fixes ranked smallest-first in the findings doc.
