---
author: Alex Place
created: 2026-06-18
updated: 2026-06-21
---

# Ouro / LoopLM — looped latent reasoning (CONSOLIDATED → SIGMA0-OURO-CODER.md)

> ## 🔁 Consolidated. The loop mechanism now lives in the coder doc.
>
> **→ [SIGMA0-OURO-CODER.md § The loop mechanism](SIGMA0-OURO-CODER.md#the-loop-mechanism)**
> is the single source of truth. It carries the full Q-exit math, both loop implementations,
> and the codebase map that used to live here.
>
> This page is retained as a redirect so existing references (research notes, handoffs)
> still resolve.

## One-paragraph summary

Ouro / LoopLM (*Scaling Latent Reasoning via Looped Language Models*,
[arXiv:2510.25741](https://arxiv.org/abs/2510.25741); PDF:
[`docs/research-papers/ouro-looped-llm-2510.25741.pdf`](research-papers/ouro-looped-llm-2510.25741.pdf))
builds reasoning into **computation depth** by reusing weight-tied layers R times in latent
space, with a learned **Q-exit** gate that exits at the first recurrent step where
`CDF(t) ≥ q`. Lantern is the **recurrent-depth engine** behind the local coder. Two
implementations:

- **Native latent loop** — [`src/sigma0/loop_lm.py`](../src/sigma0/loop_lm.py) (`Sigma0LoopLM`)
  applies Q-exit over Ouro's pretrained weight-tied block + exit gate (inference-time only;
  reports realized `mean_depth`). Served drop-in via
  [`scripts/ouro_serve.py`](../scripts/ouro_serve.py) on `:11434`; deep mode is `OURO_NATIVE=1`.
- **API re-prompt loop** — [`lib/loop-reasoner.js`](../apps/lantern-garage/lib/loop-reasoner.js)
  (`loopedReason()`) approximates the loop for any plain model by re-prompting up to
  `MAX_LOOPS` and exiting via `cdfExit()` (`threshold_met` / `converged` / `max_loops`).

For the full treatment — the paper mechanisms, both loops, the "where it maps in the
codebase" table, the inference modes, and honest scope — see
**[SIGMA0-OURO-CODER.md](SIGMA0-OURO-CODER.md)**.
