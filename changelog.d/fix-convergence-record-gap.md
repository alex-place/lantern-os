### Fixed
- Convergence records now emitted for ollama/local-model replies (#941 smoke test finding). Both ollama paths (unified-agent connector and direct HTTP) were missing `recordConvergenceSignature()` — the same call present for every cloud provider (gemini, anthropic, openai, grok). `convergenceId` is no longer `null` when the chat degrades to the local model.
