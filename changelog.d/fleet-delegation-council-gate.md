### Fleet delegation now routes through the Σ₀ council

The Work page's 🛰️ "Delegate to fleet" run (`/api/convergence/autonomous-work/stream`)
now scores every proposed plan+patch through the consolidated council
(`councilReview`) after tests, feeding the test result as the execution verdict and
research/web evidence as grounding context. The verdict is load-bearing: `grounded`
proceeds, `seam_open` still opens the draft PR but flags it for review in the body,
and `pin` holds before commit. Surfaced as a live `council` step, in the PR body, in
the convergence record, and in the delegation banner. Passing tests still ground the
change, so verified auto-work is not regressed.
