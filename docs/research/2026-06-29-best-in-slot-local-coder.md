# Best-in-slot local coder — the grounding gate (2026-06-29)

**Loop stage:** Reason (model selection) + Verify (no unproven lead).
**Status:** decided + implemented. LoopCoder-v2 registered behind an evidence gate.

## Question

Are we using LoopCoder, and is there a more optimal local coder for Keystone's
8GB box than the current Qwen2.5-Coder-7B lever?

## Findings (claim · evidence · confidence · source)

- **We were not using LoopCoder.** The local chain is Ouro-1.4B (Σ₀-native,
  rank-order kernel lead) + Qwen2.5-Coder-7B (capability-first lever, 8GB) +
  Qwen-3.6-27B (≥24GB frontier), cloud-first Claude for real coding.
  *Confidence: high.* Source: `apps/lantern-garage/lib/local-model-registry.js`.

- **LoopCoder-v2 is a real, attractive candidate.** 7B Parallel-Loop-Transformer,
  Apache-2.0, 131K ctx, looped architecture (Σ₀-aligned in spirit). Reported
  SWE-bench Verified **64.4** (two-loop) vs 43.0 one-loop baseline; ">2 loops
  regress." *Confidence: medium — every number is vendor-reported, not reproduced.*
  Sources: [arXiv:2606.18023](https://arxiv.org/abs/2606.18023),
  [HF model card](https://huggingface.co/Multilingual-Multimodal-NLP/LoopCoder-V2).

- **It is NOT yet deployable here.** Custom `IQuestPLTCoderForCausalLM` arch with
  no documented GGUF/Ollama path (model card references a vLLM fork), tool-calling
  undocumented, and `experiments/loopcoder_v2_4bit_probe.py` (already in-repo) has
  **never run** — `data/convergence/loopcoder-probe-log.jsonl` does not exist.
  *Confidence: high.* Source: repo state, model card.

- **GLM-5.2 is not a looped model and not local.** 753B/40B MoE + IndexShare sparse
  attention, MIT — a strong *cloud* coder, irrelevant to the 8GB local slot. Do not
  classify it as recurrent-depth. *Confidence: high.* Source:
  [The AI Rankings](https://theairankings.com/zhipu/glm-5/).

## Decision

Keep Ouro as the Σ₀-native default. Register LoopCoder-v2 as a coding candidate
**gated by a new `verified` flag**: a model whose capability is vendor-claimed but
not reproduced on our hardware (`verified:false`) is sorted behind every reproduced
peer and can never auto-lead a benchmark we haven't run (External Reality Rule). It
enters the registry without displacing the known-good Qwen lead.

Promotion path: run `python experiments/loopcoder_v2_4bit_probe.py` on the 3070 box
(FIT/RUNS/SPEED → `data/convergence/loopcoder-probe-log.jsonl`), then — if it loads
4-bit and produces coherent code — drive `eval_humaneval_chat.py` / the SWE harness
to reproduce the capability number, set `capabilityScore` from the measured result,
and flip `verified:true`. `LOCAL_ALLOW_UNVERIFIED=1` lifts the gate so that probe/eval
run can actually lead the candidate.

## What this does NOT claim

We have not run LoopCoder-v2. The 64.4 figure is unverified vendor data. This change
only makes the candidate *registerable without risk* and encodes the rule that
on-box evidence — not a vendor benchmark — is what promotes a model to lead.
