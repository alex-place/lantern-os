### Changed
- **Chat is pure LLM + native tools — all deterministic keyword pathing removed.** The chat
  surface no longer catches keywords/regex before the model runs (the bug that turned
  "show me all of todays world news headlines" into "Now playing — Super Mario World"). Removed
  the 12 pre-LLM client intercepts in `dream-chat-ui.js` (image/video/doc/radio/embed/`!prs`/
  `!issues`/`!work`/`!convergence`/`!help` + the command palette) and the server keyword
  classifiers (`classifyIntent`/`intent-router.js`, `converganceRoute`/`model-router.js` intent
  patterns, keyword `detectTaskType`/`task-detector.js`, and the dead `CONVERGENCE_CHAT` divert).
  Every message now flows to the LLM, which decides capabilities via native tool calls.

### Added
- **`generate_image` tool** — the model now draws/illustrates on its own initiative via a real
  tool call (OSS-first image-model-registry), replacing the old "draw me X" keyword intercept.
- **`scripts/no-keyword-intent-routing.mjs` guard** + `pre-push` hook block + `pr-gates.yml` CI job
  + `test/no-keyword-routing.test.js` contract test — bans reintroducing keyword intent-routing.
  The guard allowlists the legitimate **model-based** (`ouro-router.js`) and **measured**
  (`provider-router.js` PCSF, `local-model-registry.js`) routers — that is frontier-style model
  separation, not keyword catching.

### Notes
- Model separation is preserved: the model-based Ouro router (Auto mode) + measured PCSF ordering
  pick the provider. When Ouro is unavailable, task-type defaults to `"default"` (never keyword).
  Set `OURO_ROUTER=1` where Ollama runs so "Auto (pick best)" is genuinely model-routed.
