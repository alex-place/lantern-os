### Ouro's Q-exit is only weakly adaptive — to token-entropy, not task difficulty

`experiments/sigma0_qexit_adaptive.py` measures the per-input adaptivity `bench_ouro_loop.py`
doesn't: does the trained Q-exit gate spend more recurrent depth on harder inputs? Replicating the
gate's exit-PDF math exactly (`modeling_ouro.py:769-782`), the model's expected exit depth `E[d]`
over 24 prompts:

- **E[d] by tier (of max 4): easy 3.39, medium 3.46, hard 3.35** — flat; hard gets no more depth.
- **corr(E[d], next-token entropy) = 0.48** — adapts to local token-uncertainty, NOT task difficulty.
- mean ≈ 3.4/4 — the gate prefers near-full depth for nearly everything.

So the "adaptive recurrent-compute spends more on hard problems" framing overstates it on Ouro-1.4B.
This **refines, not refutes, ADR-0012**: the measured 25–43% savings come from the global depth knob
(forcing fewer steps) + a roughly-uniform ~15% average early-exit, not from difficulty-aware routing;
and at the default `early_exit_threshold=1.0` the model runs full depth regardless. MEASURED pilot
(`data/sigma0/qexit_adaptive_report.json`); caveats: 24 prompts, imperfect hardness proxy, fp16.
See `docs/research/2026-07-04-qexit-adaptivity.md`.
