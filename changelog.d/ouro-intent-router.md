### Chat: Ouro as the Auto-mode intent router (Σ₀ Step 2, OURO_ROUTER=1)

- In **Auto mode** (no explicit model picked), the local **Ouro** model now classifies the message into a task type (`coding`/`reasoning`/`trading`/`creative`/`default`), which drives `isCodingIntent` (→ cloud-first) and `taskType` (→ provider selection). Ouro **never writes the answer** — it only triages; cloud coders still write the code. This is the on-thesis use of Ouro (cheap local router, can't code — 0/5 HumanEval) and routes on the compute/cost axis, not guessed-intent→behavior.
- **Explicit model picks skip Ouro entirely** (no added latency) and go direct.
- **Graceful degradation:** any failure (Ouro/Ollama down, timeout, unparseable reply) returns null → the caller falls back to the keyword `detectTaskType`. Cold model-load simply takes the keyword path until Ouro is warm.
- Gated by `OURO_ROUTER=1` (off by default → no behavior change). Tunable: `OURO_ROUTER_MODEL`, `OURO_ROUTER_TIMEOUT_MS`.
- Verified: a 1.5B router model classified 7/7 sample intents correctly at ~315ms warm; end-to-end, an Auto coding ask was classified `coding` and answered by a cloud coder (Gemini) with real code; an explicit `provider:"ollama"` request skipped the router.
