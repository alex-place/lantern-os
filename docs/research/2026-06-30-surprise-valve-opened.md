# Opening the leak, Layer 1.5: the surprise valve is wired into the live serving path (#1678)

**Date:** 2026-06-30
**Status:** implemented + proven live. Follows [#1673](2026-06-30-surprise-leak-layer1-result.md) (signal valid) and [#1676] (map fixed).
**Loop stage:** Verify (the leak).

## What shipped

[#1673](2026-06-30-surprise-leak-layer1-result.md) proved raw per-token surprise separates
hallucination but the *valve was closed* — no production caller plumbed real logprobs into
the groundedness canary. This change opens it.

- **New `lib/stream-surprise.js`** (pure, unit-tested): a flag-gated per-token logprob
  accumulator + per-provider extractors (`pushOpenAIEvent`, `pushGeminiEvent`) + request
  augmenters (`withOpenAILogprobs`, `withGeminiLogprobs`). Reads `SURPRISE_CANARY`
  **dynamically** (runtime-toggleable, trivially testable).
- **Wired into `stream-chat.js`** at the shared `sendDone` finalizer: one accumulator,
  fed during streaming by the OpenAI, xAI/Grok and Gemini paths, read once as
  `tokenSurprise` for `runCanaries`. Anthropic and any no-logprob path leave it empty →
  `value()` is null → `modelUncertainty` 0 → behaviour byte-identical. Default **OFF**.
- **Telemetry:** when a logprob provider feeds the accumulator, the compact surprise field
  is stamped on the done signature (`signature.surprise`) — operator-visible proof the
  valve is open.

## Evidence

| Claim | Evidence | Confidence | Source |
|---|---|---|---|
| Server boots with the wiring on the hot path | 4178 worktree server READY, chat OK, no crash | High | measured (this change) |
| Valve captures REAL provider logprobs | Ollama `/v1` (qwen2.5-coder:1.5b), 23 & 21 tokens captured | High | measured |
| Surprise discriminates guess vs known fact | "Eiffel Tower 1889" = **0.41** bits/token vs fabricated "18,000,000 grains of sand" = **0.97** bits/token (maxBits 3.5 → 8.2) | High | measured (live) |
| Flag OFF is a clean no-op | same stream, 0 tokens captured, modelUncertainty 0, requests unchanged | High | measured + unit test |
| Map ranking valid (small absolute bits) | `modelUncertainty` ~0 both replies — this 1.5B model's bits are <1; logistic centers at 5 | High | measured |

## Honest scope / caveats

- **Magnitude is uncalibrated (Layer 2 → #1681).** The surprise *field* discriminates
  strongly, but the [0,1] `modelUncertainty` scalar stays ~0 for a small local model whose
  absolute bits run <1 (the logistic centers at 5 bits). Ranking/AUROC is valid (#1673);
  per-model threshold calibration is the next step before the canary should act on it.
- **Gemini/Vertex returned no parseable per-chunk logprobs** for `gemini-2.5-flash` via
  `responseLogprobs` in this path. The wiring is correct and is a graceful no-op there; if
  the provider surfaces `logprobsResult`, it will be captured. Not chased here.
- **Tool-loop paths deferred.** The `CHAT_TOOL_EXEC=1` per-provider tool turns
  (geminiToolTurn / anthropicToolTurn / openaiCompatibleToolTurn) route through helper
  modules that don't yet surface logprobs to their `onToken`; they inherit the no-op. The
  default single-shot chat path — the one that matters — is wired.
- **Layers 2–3 unrun (#1679/#1680):** whether feeding this in raises hallucination recall
  / verified-pass-rate is still the open question. This change only opens the valve.
