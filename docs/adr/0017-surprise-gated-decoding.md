# ADR-0017: Surprise-Gated Decoding — grounded intervention (CSF + web search + tool call)

- Status: Proposed
- Date: 2026-07-02
- Deciders: Alex Place (approval required per ADR-0001 gate)
- Loop stage: Verify → Act coupling (strengthens Verify; spends the canary in Act)

## Context

The Σ₀ surprise signal is measured and wired as a *detector*:

- `lib/token-surprise.js` — model-agnostic per-token surprise primitive
  (`surprise_i = -log2 p(token_i)`), validated in #1673/#1676 with hallucination
  separation AUROC ≈ 0.76–0.81 (mean/p90 aggregates; tailMass degenerate).
- `lib/stream-surprise.js` — Layer-1.5 valve (#1678): captures native logprobs
  from OpenAI/xAI/Gemini/Ollama-compatible streams, flag-gated `SURPRISE_CANARY=1`,
  graceful no-op when logprobs are absent (Anthropic).
- `lib/groundedness-canary.js` — receives `tokenSurprise` → `modelUncertainty`
  as one axis of the confident-but-unanchored canary (#1260).

Published SOTA (semantic entropy, Farquhar et al. 2024; internal-state probes)
stops at **detection**. The frontier claim available to us: **reduction** —
detection wired to a mid-generation grounding intervention, local-first, on
models where we own the logits (`ouro_serve.py` / `loop_lm` decode path).

The canary is currently *unspent*: it scores replies after the fact; nothing
acts on it during decode.

## Decision

Add one intervention controller to the ONE loop (no new subsystem): when rolling
windowed surprise crosses a calibrated threshold mid-generation, the stream
**pauses**, a **grounding round** fires, and generation **resumes** with the
grounding injected as context. Three grounding arms, arbitrated by a router that
classifies the high-surprise span:

1. **CSF memory retrieval (Remember arm).** The high-surprise span (plus local
   context) queries the wired recall path (knowledge-router / CSF memory,
   the +22pp@5 retrieval stack from #1685). Cheapest arm; always tried first.
2. **Web search (Observe arm).** If the span is entity/number/date-shaped and
   memory returns nothing above the relevance floor, fire the existing
   webSearch path (same primitive as `lib/autowork-research.js`), with
   Promise.race deadlines (autowork web-search hang lesson — DNS is not inside
   socket timeout). Results enter as `[claim, evidence, confidence, source]`
   snippets, never as raw prose.
3. **Tool call (Act arm).** If the span is *computable or checkable* — arithmetic,
   dates, code behavior, file contents, live status — route to the existing
   tool-runner (`lib/tool-runner`, CHAT_TOOL_EXEC=1 loop) instead of retrieving
   text about it. Shell-free via `lib/safe-exec.js`. A verified tool result is
   the strongest grounding of the three and is stamped `observable: 1.0`.

Arbitration is deterministic and logged: span classifier → arm order
(memory → tool → web for computable spans; memory → web → tool otherwise);
each round emits a convergence record
`{claim: span, evidence: [arm results], confidence, source}` appended to the
run's receipt. Max N intervention rounds per reply (default 2) and a hard
per-round deadline; on timeout or empty grounding, decoding resumes unmodified
and the event is logged — the intervention must never make a reply worse than
baseline-with-detection.

Resume semantics: on local decode (`ouro_serve` / loop_lm) the KV cache is kept,
grounding is injected as a bracketed system-style segment, and the
high-surprise span is **rewound** (tokens from the window start are dropped)
so the model re-decodes the claim with evidence in context. On provider streams
without decode control (cloud), the fallback is post-hoc: finish the stream,
then run one grounded revise pass gated by the same threshold — weaker, but
keeps the contract provider-agnostic (ADR-0005: models are interchangeable).

## Threshold calibration

Reuse the Layer-1/2 experiment harness (`experiments/surprise_leak_ab.py`,
`surprise_leak_layer2_canary.js`): pick the rolling-window statistic (mean or
p90 over a W-token window, W≈16) and set the trigger at the operating point
that maximizes intervention precision at recall ≥ 0.5 on the labeled
hallucination set. Threshold, window, and arm-order live in config, logged in
every receipt.

## Evidence gate (Σ₀ — the ADR is not Accepted until these numbers exist)

| Metric | Baseline | Target |
|---|---|---|
| Hallucination rate on HaluEval-class prompt set (register in docs/BENCHMARKS.md) | detector-only decode | ≥ 20% relative reduction |
| Answer quality (exec-verified where computable) | unchanged | no regression |
| p50 added latency per intervened reply | — | ≤ 2.5 s local |
| Intervention precision (grounding actually relevant) | — | ≥ 0.6, from receipts |

A/B is flag-gated end-to-end: `SURPRISE_CANARY=1` (detect) vs.
`SURPRISE_INTERVENE=1` (detect + intervene), both default OFF.

## Consequences

- Spends the previously unspent canary; Verify output now feeds Act mid-decode —
  this is the pumped-lossy-resonator leak actually closing the loop.
- No new memory system, no new agent: the three arms are the existing
  Remember/Observe/Act primitives, called from one controller in the stream loop.
- Cloud providers without logprobs (Anthropic) see zero behavior change.
- Risk: injected grounding can derail style/coherence — bounded by max-rounds,
  rewind-window size, and the no-regression gate above.

## Alternatives considered

- **Post-hoc revise only** (no mid-decode pause): simpler, provider-uniform, but
  forfeits the frontier claim (that's just self-refine with a better trigger)
  and wastes the local-logit advantage. Kept only as the cloud fallback.
- **Speculative dual-decode** (ground every reply): 2× cost, no trigger needed —
  rejected; the detector exists precisely to pay grounding cost only when needed.
- **New standalone "grounding agent"**: forbidden (ADR-0002, one Convergence Core).
