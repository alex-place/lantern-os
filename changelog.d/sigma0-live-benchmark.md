### Added
- **Σ₀ live benchmark runner (`experiments/sigma0_live_bench.py`).** Scores real frontier LLMs on the 159-record golden dataset with the same prompt/parser/scorer (OpenAI-compatible + Gemini REST + Anthropic). Live result: **GPT-4o-mini golden 0.95, confabulation 0.0%** (declined on all 42 negatives — never asserted an open conjecture/refuted claim as fact), over-abstention ~5%. Grok/Mistral/Anthropic-key/DeepSeek unavailable (account-side: xAI credits, invalid keys, zero balance); Gemini free-tier rate-limited beyond a timebox. Strengthens **Verify**.

