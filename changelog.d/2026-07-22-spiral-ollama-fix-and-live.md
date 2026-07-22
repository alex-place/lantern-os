### Fixed

- **spiral: the local cheap tier resolves a real pulled coder, not the `ouro:latest` pin.** The
  spiral's `ollama` tier (`lib/spiral-tiers.js`) routed through the raw `OLLAMA_MODEL` env, which on
  the fleet host pins `ouro:latest` — a model served only by the separate `ouro_serve.py` shim, so a
  plain-daemon call returns *"model not found"* and the local cheap tier 404'd. It now resolves via
  the constraint-aware registry (`selectCheapStandin` → `qwen2.5-coder`) with a `SPIRAL_LOCAL_MODEL`
  override, so `spiral_solve` and the Phase-0 runner work against whatever coder is actually pulled
  in Ollama, independent of the Ouro serving state.

### Added

- **spiral: Phase 0 run LIVE on-box, fully local, zero spend.** `experiments/spiral_phase0.js --live`
  now runs a real cascade (`cheap=qwen2.5-coder:0.5b → escalate=qwen2.5-coder:7b`) on the local
  Ollama daemon. Observed: **5/6 solved at 33% escalation** (4/6 cheap-tier sufficiency); the 6th
  (`rle`) honestly reported **unsolved** after both tiers plateaued, and the escalated rescue
  (`two_sum`) captured as a `distillTarget` corpus row. `SPIRAL_FRONTIER_PROVIDER=openai|gemini`
  escalates to a cloud tier instead. The Phase-0 ConvergenceRecord is now `verified:true` in both
  modes (the "harness runs end-to-end + emits a corpus" claim is confirmed by the run; the
  capability number is carried as a measurement, not an eval-leaderboard benchmark).
