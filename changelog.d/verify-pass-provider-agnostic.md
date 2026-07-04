fix(sigma0): route the verify pass through the full provider chain, flag when none is reachable

The Σ₀ self-correction pass (`dream-chat.verifyResponse`) — which extracts and
grounds claims after every chat reply — was hard-coupled to Anthropic: it no-op'd
the instant `ANTHROPIC_API_KEY` was absent and only ever called api.anthropic.com
for claim extraction/revision. On the 2026-07-03 eval a credit-depleted Anthropic
key silently took the honesty net offline: every reply returned
`sigma0={claims:0, corrected:false}`, including one that fabricated a summary of a
nonexistent file and one that invented five nonexistent exports while claiming
"verified now". Verification was down exactly when it was needed.

- New `lib/verify-llm.js` `callVerifyModel(prompt)` runs claim extraction/revision
  through the SAME provider set the chat uses (Anthropic → OpenAI → Gemini → xAI,
  with local Ouro as the offline backstop), falling over on any provider that is
  down/depleted. Applies the "models are replaceable — never hardcode a provider"
  principle to the Verify stage. The grounding legs (codebase grep, web search,
  Gemini grounding API) are unchanged.
- When NO provider is reachable, `verifyResponse` now returns
  `skipped:"no_provider"` (surfaced as `sigma0.skipped`) instead of a silent
  zero-claims pass — so the UI/logs can tell "verified: nothing to correct" apart
  from "verification never ran". Kill-switch `VERIFY_USE_OLLAMA=0` drops the local
  backstop.
- Tests (`apps/lantern-garage/test/verify-llm.test.js`): extraction still succeeds
  with the Anthropic path mocked dead and OpenAI mocked alive, and the skipped flag
  fires when every provider is down — both hermetic (HTTP transport swapped, no
  network, no real keys).
