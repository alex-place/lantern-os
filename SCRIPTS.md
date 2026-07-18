---
author: Alex Place
created: 2026-06-06
updated: 2026-07-16
---

# unisona.ai — Script Inventory

One-stop reference for every runnable script in the repo. Skip the archaeology next time.

**Regenerated 2026-07-16** from the Python scripts audit
([docs/PYTHON-SCRIPTS-AUDIT-2026-07-16.md](docs/PYTHON-SCRIPTS-AUDIT-2026-07-16.md), Appendix D + §3) — #2537.
The previous inventory referenced `archive/` and `lantern-discord/` directories that no longer exist.

**This file is load-bearing:** the sprawl tripwire (#2542) blocks any *new* `.py` outside
`tests/` + `experiments/` that no anchor references — and a SCRIPTS.md row **is** an anchor.
Registering a docs-only operational script here is what keeps it alive; when a script is
retired, delete its row (a stale row resurfaces in the next audit).

**Rule of thumb:** `scripts/` is operational tooling. `experiments/` is measure-first scratch
(exempt from the tripwire, disposable by default). `src/` + `apps/` are the product — their
Python is imported/spawned by the server or MCP, not usually run by hand.

---

## Core startup (single command)

| Script | Purpose | How to run |
|--------|---------|-----------|
| `npm start` (in `apps/lantern-garage/`) | Starts the web server (port 4177) and spawns the Discord bot automatically if `DISCORD_BOT_TOKEN` + `LANTERN_DISCORD_GUILD_ID` are set in `.env.local` | `cd apps/lantern-garage && npm start` |
| `apps/lantern-garage/server.js` | Node HTTP server with modular routes. Loads `.env.local` / `.env` from repo root. | `node apps/lantern-garage/server.js` |
| `make quickstart` | Dual-boot dev: stable (4177, master) + dev (4178, current branch, hot-reload) | `make quickstart` |

---

## Discord bot

| Script | Purpose | How to run |
|--------|---------|-----------|
| `src/discord_lounge_bot/bot_v2.py` | **Main bot** — slash commands, role gating, notebook integration. Reads `.env.local`. | `python src/discord_lounge_bot/bot_v2.py` |
| `src/discord_lounge_bot/bot.py` | Backward-compatible alias for `bot_v2.py`. | `python src/discord_lounge_bot/bot.py` |
| `scripts/Start-DiscordBotV2.ps1` | PowerShell launcher — loads `.env.local`, checks deps/env. | `.\scripts\Start-DiscordBotV2.ps1` |
| `scripts/Start-DiscordBotWatchdog.ps1` | 24/7 watchdog — restarts the bot on crash. | `.\scripts\Start-DiscordBotWatchdog.ps1` |
| `scripts/Test-DiscordBotHealth.ps1` | Deep health check — token, guild access, voice visibility. | `.\scripts\Test-DiscordBotHealth.ps1` |
| `src/discord_lounge_bot/health_check.py` | Standalone health checker (env, process, API latency). | `python src/discord_lounge_bot/health_check.py --json` |

---

## Orchestrator & convergence

| Script | Purpose | How to run |
|--------|---------|-----------|
| `src/convergence_io_engine.py` | **Main orchestrator** — 12-phase convergence loop, health, inspect. | `python src/convergence_io_engine.py health` · `… loop` · `… converge --message "…"` |
| `src/mcp_server/server.py` | MCP server (port 8771) — tools with real implementations only. | `python src/mcp_server/server.py` |
| `scripts/convergence_close_loop.py` | Closes convergence records. Anchors: `lib/convergence-status.js`, `lib/kalshi-convergence-outcomes.js`. | server-driven; manual: `python scripts/convergence_close_loop.py` |

---

## Trader reports (monthly)

| Script | Purpose | How to run |
|--------|---------|-----------|
| `scripts/reports/sigma_trader_report_2026_07.py` | Builds the July 2026 Sigma Trader Report PDF (`apps/lantern-garage/public/reports/sigma-trader-report-2026-07.pdf`) — the champion's monthly balance, current events, suggestions, receipts. All numbers pinned in-file; reproducible offline. Next month: copy to a new dated file, update the DATA + prose. | `python scripts/reports/sigma_trader_report_2026_07.py` |

---

## Hooks & validators (repo-managed via `core.hooksPath`)

Anchored by `scripts/hooks/pre-push` and `scripts/hooks/pre-commit-full-validation`.
The retired version-bump validator (`validate-version-changelog.py`) was **removed** with #2527 —
the change-record gate is the changelog-fragment validator below.

| Script | Anchored by | How to run manually |
|--------|-------------|---------------------|
| `scripts/validate-prepush-version-changelog.py` | `scripts/hooks/pre-push` (changelog-fragment gate) | `python scripts/validate-prepush-version-changelog.py` |
| `scripts/validate-prepush-stale-clobber.py` | `scripts/hooks/pre-push` | `python scripts/validate-prepush-stale-clobber.py` |
| `scripts/validate-agents-md.py` | `scripts/hooks/pre-commit-full-validation` | `python scripts/validate-agents-md.py` |
| `scripts/validate-autoupdate-safety.py` | `scripts/hooks/pre-commit-full-validation` | `python scripts/validate-autoupdate-safety.py` |
| `scripts/validate-deployment-readiness.py` | `scripts/hooks/pre-commit-full-validation` | `python scripts/validate-deployment-readiness.py` |
| `scripts/sprawl-tripwire.mjs` | `scripts/hooks/pre-push` + pr-gates CI — loop-stage gate for new surfaces, wiring gate for new `.py` (#2542) | `node scripts/sprawl-tripwire.mjs --base origin/master` |
| `scripts/check-md-links.mjs` | pr-gates CI (`md-link-check` job, #2532) | `node scripts/check-md-links.mjs` (`--strict` gates docs/) |

---

## Eval, benchmarks & serving gates

The registry of external marks lives in [docs/BENCHMARKS.md](docs/BENCHMARKS.md); these are the runners.

| Script | Anchored by | How to run |
|--------|-------------|-----------|
| `scripts/eval_keystone.py` | `.github/workflows/eval-leaderboard-gate.yml` | `python scripts/eval_keystone.py` |
| `scripts/rollover_gate.py` | `scripts/eval_keystone.py` | via `eval_keystone.py` |
| `scripts/eval_ledger.py` | `tests/test_eval_ledger.py` | `python scripts/eval_ledger.py` |
| `scripts/honesty_ledger.py` | `tests/test_honesty_ledger.py` | `python scripts/honesty_ledger.py` |
| `scripts/eval_sigma0_adapter.py` | `tests/test_sigma0_eval.py` | `python scripts/eval_sigma0_adapter.py` |
| `scripts/eval_coding.py` | `scripts/eval_coding_backend_ab.py` | via the A/B harness |
| `scripts/eval_coding_backend_ab.py` | `apps/lantern-garage/lib/coding-backend/index.js` | `python scripts/eval_coding_backend_ab.py` |
| `scripts/eval_humaneval_ouro.py` | `scripts/continual_ouro_pipeline.py` | `python scripts/eval_humaneval_ouro.py` |
| `scripts/humaneval_rerank.py` | `scripts/eval_humaneval_ouro.py` | via `eval_humaneval_ouro.py` |
| `scripts/eval_humaneval_chat.py` | registered here (docs: BENCHMARKS.md) | `python scripts/eval_humaneval_chat.py` |
| `scripts/eval_swebench_chat.py` | registered here (docs: BENCHMARKS.md) | `python scripts/eval_swebench_chat.py` |
| `scripts/swe_agent_loop.py` | registered here (docs: BENCHMARKS.md) | `python scripts/swe_agent_loop.py` |
| `scripts/swe_agentic_run.py` | registered here (docs: BENCHMARKS.md) | `python scripts/swe_agentic_run.py` |
| `scripts/swebench_verifier_harness.py` | registered here (docs: BENCHMARKS.md) | `python scripts/swebench_verifier_harness.py` |
| `scripts/eval_paired_diff.py` | registered here (docs: BENCHMARKS.md) | `python scripts/eval_paired_diff.py` |
| `scripts/eval_dashboard.py` | registered here — generates the tracked eval-dashboard artifact | `python scripts/eval_dashboard.py` |
| `scripts/measure_drift_equivalence.py` | `tests/test_drift_equivalence.py` | `python scripts/measure_drift_equivalence.py` |
| `scripts/serve_minicheck.py` | registered here — MiniCheck groundedness provider (PROVIDERS.md; wire a launcher or retire, audit §3) | `python scripts/serve_minicheck.py` |

---

## Training & model lane (Σ₀ / Ouro)

| Script | Anchored by | How to run |
|--------|-------------|-----------|
| `scripts/ouro_serve.py` | `.claude/agent-slots.json`, eval-leaderboard CI | `python scripts/ouro_serve.py` (serves :11434) |
| `scripts/ouro_serve_smoketest.py` | `scripts/rebuild-train-venv.ps1` | `python scripts/ouro_serve_smoketest.py` |
| `scripts/ouro_compat.py` | `tests/test_ouro_compat.py` | imported |
| `scripts/ouro_anthropic_bridge.py` | `lib/tool-runner.js`, `scripts/Start-OuroClaudeCode.ps1` | via launcher |
| `scripts/continual_ouro_pipeline.py` | `lib/keystone-escalation.js`, `lib/stream-chat.js` | `python scripts/continual_ouro_pipeline.py` |
| `scripts/build_ouro_coding_dataset.py` | `scripts/continual_ouro_pipeline.py` | via pipeline |
| `scripts/prepare_coding_train_data.py` | `apps/lantern-garage/lib/model-registry.js` | `python scripts/prepare_coding_train_data.py` |
| `scripts/validate_ouro_coding.py` | `scripts/prepare_coding_train_data.py` | via prep script |
| `scripts/train-qlora-ouro.py` | `apps/lantern-garage/lib/model-registry.js` | `python scripts/train-qlora-ouro.py` |
| `scripts/train-qlora-peft.py` | `scripts/continual-train.ps1` | via launcher |
| `scripts/merge-lora.py` | `scripts/continual-train.ps1` | via launcher |
| `scripts/convert-pairs-to-alpaca.py` | `scripts/continual-train.ps1` | via launcher |
| `scripts/convert_fc_dataset.py` | `scripts/retrain-combined.ps1` | via launcher |
| `scripts/extract-session-pairs.py` | `scripts/continual-train.ps1` | via launcher |
| `scripts/upload-anthropic-finetune.py` | `scripts/extract-session-pairs.py` | via pairs script |
| `scripts/fine-tune-ollama-model.py` | `scripts/convert-pairs-to-alpaca.py` | via converter |
| `scripts/rlvr_grpo_ouro.py` | `tests/test_sigma_theta_gate.py` | `python scripts/rlvr_grpo_ouro.py` |
| `scripts/gen_sigma0_traces.py` | `apps/lantern-garage/lib/local-model-registry.js` | `python scripts/gen_sigma0_traces.py` |
| `scripts/lightning_dispatch.py` | `apps/lantern-garage/lib/training-dispatcher.js` | via dispatcher UI |
| `scripts/modal_dispatch.py` | `apps/lantern-garage/lib/training-dispatcher.js` | via dispatcher UI (Modal twin of lightning_dispatch) |
| `scripts/reconcile_dual_provider.py` | `docs/SIGMA0-EB-L4-RUNBOOK.md` §10 | `python scripts/reconcile_dual_provider.py --decision A B` |
| `scripts/eb_prep_corpus.py` | `docs/SIGMA0-EB-L4-RUNBOOK.md` §3; `scripts/{lightning,modal}_dispatch.py` prep-if-missing | `python scripts/eb_prep_corpus.py --allow-download` (egress host); `--dry-run` validates offline |
| `scripts/weekly-training-orchestrator.py` | `scripts/Schedule-WeeklyTraining.ps1` | via scheduler |
| `scripts/build_claude_session_dataset.py` | `tests/test_agent_session_dataset.py` | `python scripts/build_claude_session_dataset.py` |
| `scripts/harvest_coding_corpus.py` | `apps/lantern-garage/lib/harvest-emitter.js` | server-driven |
| `scripts/distill_from_teacher.py` | registered here — Qwen→Ouro teacher distillation | `python scripts/distill_from_teacher.py` |
| `scripts/pr_crystallize.py` | registered here — PR-diff crystallization data prep | `python scripts/pr_crystallize.py` |
| `scripts/qwen_teacher_crystallize.py` | registered here — teacher-pair crystallization | `python scripts/qwen_teacher_crystallize.py` |
| `scripts/prep_code_instruct.py` | registered here — code-instruct data prep | `python scripts/prep_code_instruct.py` |
| `scripts/decontaminate_training.py` | registered here — training-set decontamination | `python scripts/decontaminate_training.py` |
| `scripts/build_honesty_calibration_aug.py` | registered here — honesty-calibration augmentation | `python scripts/build_honesty_calibration_aug.py` |

---

## CSF, knowledge & documents

| Script | Anchored by | How to run |
|--------|-------------|-----------|
| `scripts/csf_research_tesseract.py` | `routes/csf.js`, `server.js` | server-driven |
| `scripts/csf_condense_corpus.py` | `routes/pdfs.js` | server-driven |
| `scripts/csf_read_member.py` | `routes/pdfs.js` | server-driven |
| `scripts/csf_split_archive.py` | `routes/pdfs.js` | server-driven |
| `scripts/build_knowledge_index.py` | `apps/lantern-garage/lib/knowledge-router.js` | `python scripts/build_knowledge_index.py` |
| `scripts/arxiv_build_index.py` | `lib/arxiv-index.js`, `lib/csf-memory.js` | server-driven |
| `scripts/arxiv_harvest.py` | `lib/arxiv-fulltext.js`, `lib/csf-memory.js` | server-driven |
| `scripts/arxiv_add_papers.py` | `scripts/arxiv_harvest.py` (ShardWriter/dedup) | `python scripts/arxiv_add_papers.py --ids … --pdfs --reindex` (curated tranches; docs/ARXIV-CORPUS.md) |
| `scripts/resume_docx.py` | `routes/docmode.js`, `routes/documents.js` | server-driven |
| `scripts/orchestration/rag_local_knowledge_base.py` | `scripts/Ingest-CaadZip.ps1` | via launcher |

---

## Media, images & creator

| Script | Anchored by | How to run |
|--------|-------------|-----------|
| `scripts/image_generator.py` | `routes/image.js` | server-driven |
| `scripts/generate-with-trained-lora.py` | `lib/image-generation.js` | server-driven |
| `scripts/generate-door-images.py` | `lib/stream-chat.js` | server-driven |
| `scripts/train-three-doors-lora.py` | `routes/training.js` | server-driven |
| `scripts/merge-lora-weights.py` | `src/sd_image_server.py` | via SD server |
| `models/three-doors-imagegen/generate.py` | registered here — generates the tracked Three-Doors scene art | `python models/three-doors-imagegen/generate.py` |
| `scripts/facecam_face_detect.py` | `lib/facecam-v3.js` | server-driven |
| `scripts/fetch_radio_audio.py` | `scripts/normalize_radio_levels.py` | via normalizer |
| `scripts/normalize_radio_levels.py` | `public/radio/stations-pending-restore.json` | `python scripts/normalize_radio_levels.py` |
| `scripts/build_library_thumbs.py` | `routes/library.js` | server-driven |

---

## Trading & MCP

| Script | Anchored by | How to run |
|--------|-------------|-----------|
| `scripts/kalshi_odds.py` | `src/mcp_server/server.py` | via MCP |
| `scripts/mcp_stdio_bridge.py` | `.mcp.json`, `.mcp/claude-desktop.json` | via MCP client config |
| `scripts/agent_inspector.py` | `scripts/Start-TesseractListener.ps1` | via launcher |
| `scripts/Test-ConvergenceAgentFleet.py` | `scripts/Invoke-LanternConvergenceLoop.ps1`, `…SmartConvergenceLoop.ps1` | via launcher |

⚠ `scripts/orchestration/lantern-{billing,chat-ui,kids-ui,telemetry}.py` are anchored only by
`scripts/orchestration/Deploy-FamilyA-24Hour.ps1`, which the audit flags as likely dead —
removal-wave candidates (#2538, founder sign-off pending), not registry members.

---

## Infrastructure

| Script | Purpose | How to run |
|--------|---------|-----------|
| `scripts/start-ngrok-tunnels.sh` | Launches ngrok tunnels for all services. | `bash scripts/start-ngrok-tunnels.sh` |
| `scripts/restart-headless.sh` | Docker Compose restart for headless services (CSF, proxy). | `bash scripts/restart-headless.sh` |
| `scripts/install-rust.sh` | Installs Rust + builds `src/csf_rust`. | `bash scripts/install-rust.sh` |

---

## Testing

| Command | Purpose |
|---------|---------|
| `python -m pytest tests/ -q --tb=short` | Full Python suite (pythonpath = `apps src` via pytest.ini; `conftest.py` is the pytest anchor) |
| `npm run test:api --prefix apps/lantern-garage` | Node API tests (server must be running) |
| `npm run test:chat --prefix apps/lantern-garage` | Chat regression tests |
| `npm run test:ui --prefix apps/lantern-garage` | Playwright UI tests |
| `node apps/lantern-garage/test/<name>.test.js` | Framework-free unit suites (surface-boundary, deployment-profile, active-user-metric, …) |

---

## Quick reference

```bash
# Start everything (dual-boot dev)
make quickstart

# One server
node apps/lantern-garage/server.js

# MCP server
python src/mcp_server/server.py

# Orchestrator health
python src/convergence_io_engine.py health

# Run the repo gates by hand
node scripts/sprawl-tripwire.mjs --base origin/master
node scripts/check-md-links.mjs
```

Full provenance for every `.py` in the repo: [docs/PYTHON-SCRIPTS-AUDIT-2026-07-16.md](docs/PYTHON-SCRIPTS-AUDIT-2026-07-16.md).

