### docs: reusable Σ₀ model design brief (max-reasoning, evidence-classed, verified numbers)

Adds `docs/SIGMA0-MODEL-DESIGN-BRIEF.md` — the ready-to-run brief for having a max-reasoning
model design the next Σ₀ honest-model iteration: front-loaded [MEASURED] ground truth with file
pointers (so reasoning budget goes to design, not re-derivation), hard constraints (local ≤8GB,
one loop, no sprawl, no marker-honesty), 8 forced decisions each demanding tradeoffs +
recommendation + cheapest falsifier, and the Σ₀ discipline applied to the answer itself.

All nine cited artifacts verified present on master and headline numbers checked against
`docs/SIGMA0-HONESTY-BENCHMARK.md` before saving (one correction vs the draft: Gemini-2.5-Flash
confabulation is the measured 21.4%, not "20%"). Embeds the two easy-to-get-wrong findings so a
designer doesn't re-propose refuted paths: data-imbalance-causes-collapse, and free-logprob is
the only signal with a positive routing edge (#2047 — canary/council-Δ rank but don't route).
