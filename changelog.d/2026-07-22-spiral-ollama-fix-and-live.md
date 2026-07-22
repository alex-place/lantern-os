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
- **spiral: Phase-0 runner takes a borrowed open benchmark (`--dataset mbpp`).** Normalizes
  `data/eval/mbpp-basic.jsonl` (`checks` → per-test Python `assert`s) into the spiral task schema.
  Fully-local run (0.5B → 7B) solved **18/18 at 6% escalation** (17/18 cheap-tier sufficiency);
  MBPP-basic is a *basic* curated set, so this is honestly a sufficiency demonstration on easy open
  problems, not a hard-task claim. Also fixed a misleading tier label (a cloud escalate no longer
  prints a qwen model name).
