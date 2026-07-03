### Fixed
- **Chat AI-Provider dropdown is now dynamic + honest, not a static list.**
  `dream-chat.html`'s provider selector was a hardcoded `<option>` list: it advertised
  every provider regardless of whether its key was live, and always offered
  "Local Σ₀ Loop (Ouro)" even when no local model was running — so a chat pinned to
  local would fail while the UI still showed the option (and reported a *false*
  "cloud providers are unreachable"). It is now built at load from
  `/api/providers/status` (mirroring the home page's `buildProviderPin`): only
  providers the running server can actually dispatch to appear, Auto is always present,
  and the local Σ₀ option shows **only when a model is genuinely being served on
  :11434**, labeled with the real model (e.g. `Local Σ₀ (ouro:latest)`). The status
  fetch retries to survive the page's boot-burst connection starvation; on total
  failure it shows cloud optimistically but never advertises an unconfirmed local model.
- **`/api/providers/status` now tells the truth about the local model.** The `ollama`
  entry was hardcoded `available: true`; it now reflects a real (cached, non-blocking)
  `:11434/api/tags` probe and reports `serving` / `served_models` / `pinned_served`, so
  every consumer (chat **and** the home page) stops advertising a local model that isn't
  running. Improves the **Verify** stage — the UI reflects observed provider reality
  instead of a static claim.
