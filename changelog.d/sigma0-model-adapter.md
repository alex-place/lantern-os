### Σ₀ local-model adapter: best-fitting local model, capability-aware convergence

- New **local-model registry** (`apps/lantern-garage/lib/local-model-registry.js` + `data/models/local-registry.json`) — the single source of truth for *which local model leads a task, whether it fits the box (VRAM-gated), and whether it self-converges*. Models stay interchangeable; the Convergence Core hardcodes none.
- **Ouro-1.4B stays the Σ₀-native default** (Q-exit is the thesis). **Qwen2.5-Coder-7B** is registered as the opt-in capability lever — the strongest local coder that fits 8 GB. `LOCAL_CAPABILITY_FIRST=1` makes it lead coding; `VRAM_BUDGET_GB` gates models that don't fit.
- **Convergence loop is now capability-aware** (`stream-chat.js`): the `LOOP_REASONER` wrap was blind to the model — it would double-loop a self-converging Ouro and skip grounding for a single-pass model. It now wraps only `selfConverges=false` models (Qwen → grounded; Ouro → its native Q-exit, untouched). Unknown models default to wrapped.
- Local model chain is registry-led with the existing static models kept as fallbacks; all wiring is additive and falls back to prior behavior on error.
- New zero-dep unit suite (`test/local-model-registry.test.js`, `node --test`, 9 cases). Design + web-grounded model comparison: `docs/SIGMA0-MODEL-ADAPTER.md`.
