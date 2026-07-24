---
author: Claude lane (session audit)
created: 2026-07-16
status: Findings + recommended dispositions — removals need Alex's sign-off
---

# Python Scripts Audit — 2026-07-16

Full audit of every tracked `.py` file in the repo (658 files), per the directive:
*every Python script must be wired into the surface, updated, or removed.*

## TL;DR

| Disposition | Count | Meaning |
|---|---|---|
| **WIRED — keep** | 375 | Anchored to a real execution surface (server routes, MCP, CI, git hooks, npm, shell launchers, pytest) directly or via import closure |
| **DOCS-ONLY — keep as evidence / register** | 133 | Referenced only from markdown (research writeups, CHANGELOG, specs) |
| **WEAK-REF — mostly dead** | 25 | Referenced only by other unwired code (mainly intra-`hff-api` imports) |
| **ORPHAN — remove candidates** | 116 | Zero references anywhere: no code, CI, hooks, docs, or configs |
| **Package markers — keep** | 9 | Bare `__init__.py` with no direct references (structural) |

**Headline findings:**

1. **`/api/csf/search` is broken in production code.** `routes/dream.js:133` spawns `src/csf_search.py`, which does not exist anywhere in the repo. Every call to the endpoint errors. Fix: back it with the canonical `csf` package (`src/csf/`) or remove the endpoint.
2. **The Colab training path is stale.** `lib/training-dispatcher.js` generates a notebook that runs `scripts/train_ouro.py` — a file that doesn't exist. The Kaggle path (which writes its own `train.py` to a temp dir) is fine. Repoint the Colab cell at `scripts/train-qlora-ouro.py` or delete the Colab branch.
3. **`lib/convergence-lora.js` waits for a script that was never written.** `triggerLocalTraining()` no-ops behind an `existsSync` guard on `scripts/train-convergence-lora.py`. Decide: implement it or delete the dead branch.
4. **`tests/perf_dream_journal.py` is never run.** Its name doesn't match `test_*.py`, so pytest never collects it, and it targets the old Dream Journal service API. Rename+update it or remove it.
5. **`src/hff-api/` (31 files) is a fully dead tree.** Zero external wiring; the only "references" are its own internal imports and generated RAG catalogs under `data/`. Its earlier appearance of being alive came from `data/rag-house/flat-rag-house-latest.json` — a *document index*, not execution wiring.
6. **`scripts/orchestration/` is mostly a graveyard.** 26 of ~35 files have zero references; 6 more are anchored only by co-located `Deploy-FamilyA-24Hour.ps1`-style launchers from the same 2026-06-11 bulk import (family setup, Warren Buffett PDFs, audio narrators, payment/outreach stubs).
7. **[SCRIPTS.md](../SCRIPTS.md) is stale** (updated 2026-06-20): it references `archive/` and `lantern-discord/` directories that no longer exist and predates the one-assistant refactor. It should be regenerated from Appendix D of this audit.

## Method

Static reference graph over all tracked files:

- **Anchor surfaces:** `.github/workflows/`, `Makefile`, `package.json`, `scripts/hooks/` (repo-managed git hooks), `**/*.js` (server + routes + libs), `src/mcp_server/`, tracked `.ps1`/`.sh` launchers, `.mcp.json` and other config. `tests/**/test_*.py` are anchored via `pytest.ini` (`testpaths = tests`) which CI runs.
- **Import closure:** package (`a.b.c`), relative (`from .x import`), and sibling-directory (`from mesh_bridge import …`) imports all resolved; anything imported (or path-spawned) by an anchored file is wired.
- **Deliberately NOT counted as wiring:** mentions in generated catalogs under `data/` (RAG house, claim registries — they index files, they don't execute them), and generic-basename matches (`__init__.py`, `app.py`, …) without a path.
- **Verified by spot-check:** MCP sibling imports, the four `validate-*` hook validators (wired via `scripts/hooks/pre-commit-full-validation`), the `/api/csf/search` breakage, the Colab `train_ouro.py` gap, and `tests/test_sigma0_grounding_corpus.py` (its `from experiments import …` works via namespace packages — passes, not broken).

**Limits (why removals still need eyes):** the graph can't see host-side Task Scheduler jobs, scripts run manually from other checkouts (`C:\dev\lantern-os-stable`), or cloud-side runs (Lightning/Colab) that aren't referenced in-repo. Orphans are *candidates* — delete via normal PR review, in waves.

## Recommended dispositions

### 1. Keep (375 wired)

No action. Appendix D lists every wired `scripts/` file with its exact anchor — this is the payload for regenerating SCRIPTS.md.

### 2. Keep as frozen research evidence (61 docs-only `experiments/`)

Nearly all of `experiments/` that is docs-only backs a `docs/research/*` writeup, a Σ₀ certificate doc, or a CHANGELOG entry — they are the reproduction path for recorded claims (External Reality Rule). **Proposed convention:** an experiment referenced by a research doc or CHANGELOG stays frozen in `experiments/`; it is deleted only together with the doc that cites it. No wiring required.

### 3. Register or migrate (39 docs-only `scripts/`)

Operational harnesses that are real but only documented, not wired. Actions:

- **Benchmark/eval harnesses** (`eval_humaneval_chat.py`, `eval_swebench_chat.py`, `swe_agent_loop.py`, `swe_agentic_run.py`, `eval_paired_diff.py`, `swebench_verifier_harness.py`, …) — already registered in [docs/BENCHMARKS.md](BENCHMARKS.md) / the benchmarks skill. Add to SCRIPTS.md; no further wiring needed.
- **Training/data-prep pipeline** (`distill_from_teacher.py`, `pr_crystallize.py`, `qwen_teacher_crystallize.py`, `prep_code_instruct.py`, `decontaminate_training.py`, `build_honesty_calibration_aug.py`, …) — active model-lane tooling; register in SCRIPTS.md.
- **Creator-V10 shorts pipeline** (`filter_gaming_shorts.py`, `v10_training_loop.py`, `youtube_shorts_collector_v2.py`, `youtube_shorts_ingestion.py`, `rerun_shorts_real.py`, plus root `analyze_shorts.py`) — the V10 shorts effort looks abandoned; **remove or explicitly archive** (mookman lane call).
- **`scripts/serve_minicheck.py`** — referenced from PROVIDERS.md as a groundedness provider; if the provider chain still uses MiniCheck, wire a launcher; otherwise remove and update PROVIDERS.md.

### 4. Remove candidates (116 orphans + ~30 likely-dead)

Grouped, with the strongest evidence (all verified zero-reference; last-commit dates in Appendix A):

| Group | Files | Note |
|---|---|---|
| `scripts/orchestration/` graveyard | 26 orphans + 6 launcher-anchored + 2 weak | Entire 2026-06-11 bulk import: family-setup, founder-wellness, Warren Buffett PDFs, audio narrators, payment/outreach stubs. Recommend deleting the directory except `rag_local_knowledge_base.py` (used by `Ingest-CaadZip.ps1` — verify that launcher is itself still used) |
| `src/hff-api/` | 8 orphans + 15 weak + 7 docs-only + 1 pkg marker | Dead legacy HumanFirst API tree — nothing launches it |
| `src/discord_lounge_bot/` dead modules | 5 | `rp_bot.py`, `music_queue.py`, `mcp_bridge.py`, `mcp_connector.py`, `bot_tools.py` — superseded by `bot_v2.py` + MCP curators |
| One-off generators | ~15 | PDF/audio/image one-shots: `generate_csf_pdf.py`, `generate_world_lore_pdf.py`, `generate-founder-wisdom-packet.py`, `sigma0-stream-image.py`, LoRA/SD trainers (`train-door-images-lora.py`, `retrain-lora-image.py`, `deploy-merged-sd-model.py`, …) |
| Superseded training/eval | ~10 | `lightning_train_*.py`, `lightning_eval_7b_vs_ouro.py` (superseded by `lightning_dispatch.py` + `train-qlora-ouro.py`), `test_ouro_load.py`, `test_sigma0_loop.py`, `measure_drift_845.py`, `eval_fc_indomain.py` + `rebalance_fc_corpus.py` |
| Root strays | 7 | `check_gpu.py`, `generate_segments.py`, `mcp_tunnel_proxy.py`, `tunnel_mcp.py` (superseded by the MCP tunnel canary), `test_oauth_flow.py`, `test_status_cube_phases.py` (never pytest-collected — root isn't in `testpaths`), `analyze_shorts.py` |
| Misc src/apps | ~10 | `src/work_dispatcher.py` + `src/slot_loader.py`, `src/three_doors_classifier.py`, `src/generate_door_lora.py`, `src/lantern-desktop/*.py` (desktop is Node per ADR-0014), `lib/highlight_detector.py`, `docs/generate_blackbox_program_whitepaper.py` |
| `apps/bettersafe/` | 9 docs-only + 2 markers | Design-contract-only app, zero wiring. Per the feature gate this is sprawl — remove or move the design doc to `docs/` and delete the stubs (Alex's call) |

**Do NOT remove yet — July-dated orphans (active working set, pending writeup):**
`experiments/arxiv_category_probe.py`, `bisco_vs_ptqtp.py`, `ouro_depth_vs_cot.py`, `ouro_prior_conflict_dose.py`, `ouro_super_weight_probe.py`, `ouro_sycophancy_caving.py` (all 2026-07-14), `sigma0_probe_crossdomain_run.py`, `t4_hybrid_probe.py`, `build_csf_benchmark_pdf.py`; `scripts/build_epistemic_aug.py`, `check_rollover.py`, `seed_alex_cubes.py`, `compile_convergence_patterns.py`, `build_code_baseline.py`; and `scripts/eval_dashboard.py` + `models/three-doors-imagegen/generate.py` (both *generate* tracked artifacts — register them in SCRIPTS.md instead of removing).

### 5. Fix now (the "update" bucket)

1. `routes/dream.js` `/api/csf/search` → missing `src/csf_search.py` (broken endpoint).
2. `lib/training-dispatcher.js` Colab cell → missing `scripts/train_ouro.py`.
3. `lib/convergence-lora.js` → decide on `scripts/train-convergence-lora.py`.
4. `tests/perf_dream_journal.py` → rename to `test_*` + modernize, move to `scripts/`, or remove.
5. Regenerate [SCRIPTS.md](../SCRIPTS.md) from Appendix D.

## Suggested follow-up sequence

1. **PR 1 (fixes):** repair or remove the `/api/csf/search` endpoint; fix the Colab path; drop the convergence-lora dead branch.
2. **PR 2 (registry):** regenerate SCRIPTS.md from Appendix D + section 3 registrations.
3. **PR 3+ (removal waves, after Alex sign-off):** orchestration graveyard → hff-api → discord dead modules → one-off generators → root strays. Small waves keep review tractable and preserve `git log` recoverability.
4. **Tripwire (optional, Verify-stage):** extend the sprawl pre-push hook to flag any *new* `.py` outside `tests/`/`experiments/` that has no reference from an anchor surface — prevents the next graveyard.

---

## Appendix — full classification

### A. Orphans — zero references anywhere (code, CI, hooks, docs, configs)

**experiments/** (20 files)

| File | Last commit |
|---|---|
| `experiments/_omni_roundtrip_adversarial.py` | 2026-06-22 |
| `experiments/arxiv_category_probe.py` | 2026-07-14 |
| `experiments/autonomy_stress_test_7h.py` | 2026-06-15 |
| `experiments/bisco_vs_ptqtp.py` | 2026-07-14 |
| `experiments/build_csf_benchmark_pdf.py` | 2026-07-10 |
| `experiments/cio_sde_demo.py` | 2026-06-13 |
| `experiments/crypto_tightband_observer.py` | 2026-06-14 |
| `experiments/grounded_qa_probe.py` | 2026-06-25 |
| `experiments/ouro_depth_vs_cot.py` | 2026-07-14 |
| `experiments/ouro_prior_conflict_dose.py` | 2026-07-14 |
| `experiments/ouro_super_weight_probe.py` | 2026-07-14 |
| `experiments/ouro_sycophancy_caving.py` | 2026-07-14 |
| `experiments/sigma0_boundary_qutrit.py` | 2026-06-14 |
| `experiments/sigma0_btc_puzzle_structure.py` | 2026-06-16 |
| `experiments/sigma0_cube_status_model.py` | 2026-06-16 |
| `experiments/sigma0_delta_codec_benchmark.py` | 2026-06-16 |
| `experiments/sigma0_kalshi_grounding_demo.py` | 2026-06-17 |
| `experiments/sigma0_probe_crossdomain_run.py` | 2026-07-05 |
| `experiments/sigma0_saddle_ride.py` | 2026-06-14 |
| `experiments/t4_hybrid_probe.py` | 2026-07-01 |

**root & misc** (9 files)

| File | Last commit |
|---|---|
| `lib/highlight_detector.py` | 2026-06-15 |
| `check_gpu.py` | 2026-06-11 |
| `docs/generate_blackbox_program_whitepaper.py` | 2026-06-16 |
| `generate_segments.py` | 2026-06-14 |
| `mcp_tunnel_proxy.py` | 2026-06-13 |
| `models/three-doors-imagegen/generate.py` | 2026-07-03 |
| `test_oauth_flow.py` | 2026-06-11 |
| `test_status_cube_phases.py` | 2026-06-11 |
| `tunnel_mcp.py` | 2026-06-13 |

**scripts/** (41 files)

| File | Last commit |
|---|---|
| `scripts/_csf_compress_text.py` | 2026-06-11 |
| `scripts/add-version-badges.py` | 2026-06-11 |
| `scripts/build-dream-dataset.py` | 2026-06-11 |
| `scripts/build_capability_dataset.py` | 2026-06-24 |
| `scripts/build_code_baseline.py` | 2026-07-01 |
| `scripts/build_epistemic_aug.py` | 2026-07-10 |
| `scripts/check_rollover.py` | 2026-07-10 |
| `scripts/compile_convergence_patterns.py` | 2026-07-06 |
| `scripts/csf/base3_encoding.py` | 2026-06-11 |
| `scripts/csf_shard_public.py` | 2026-06-25 |
| `scripts/deploy-merged-sd-model.py` | 2026-06-11 |
| `scripts/discord_converge.py` | 2026-06-11 |
| `scripts/discord_setup.py` | 2026-06-11 |
| `scripts/eval_dashboard.py` | 2026-07-01 |
| `scripts/eval_fc_indomain.py` | 2026-06-21 |
| `scripts/execute-three-doors-training.py` | 2026-06-11 |
| `scripts/extract-model-usage.py` | 2026-06-11 |
| `scripts/generate-finetune-dataset.py` | 2026-06-11 |
| `scripts/generate-founder-wisdom-packet.py` | 2026-06-11 |
| `scripts/generate-missing-scene-images.py` | 2026-06-11 |
| `scripts/generate_convergence_csf_pdf.py` | 2026-06-11 |
| `scripts/generate_csf_pdf.py` | 2026-06-19 |
| `scripts/generate_world_lore_pdf.py` | 2026-06-19 |
| `scripts/hermes_release_check.py` | 2026-06-11 |
| `scripts/ingest_caad_zip.py` | 2026-06-11 |
| `scripts/lantern_v6_1_shorts_editor.py` | 2026-06-19 |
| `scripts/lightning_eval_7b_vs_ouro.py` | 2026-06-25 |
| `scripts/lightning_train_both.py` | 2026-06-25 |
| `scripts/lightning_train_sigma0.py` | 2026-06-25 |
| `scripts/measure_drift_845.py` | 2026-06-23 |
| `scripts/port-trading-dashboard.py` | 2026-06-11 |
| `scripts/prep_ouro_candidates.py` | 2026-06-20 |
| `scripts/retrain-lora-image.py` | 2026-06-11 |
| `scripts/seed_alex_cubes.py` | 2026-07-10 |
| `scripts/shorts_research_loop.py` | 2026-06-18 |
| `scripts/sigma0-stream-image.py` | 2026-06-22 |
| `scripts/test_ouro_load.py` | 2026-06-18 |
| `scripts/test_sigma0_loop.py` | 2026-06-18 |
| `scripts/train-csf-image-models.py` | 2026-06-11 |
| `scripts/train-door-images-lora.py` | 2026-06-11 |
| `scripts/train-resnet-classifier.py` | 2026-06-11 |

**scripts/orchestration (graveyard)** (26 files)

| File | Last commit |
|---|---|
| `scripts/orchestration/delta_sync_cloudflare.py` | 2026-06-11 |
| `scripts/orchestration/family-lantern-config.py` | 2026-06-11 |
| `scripts/orchestration/family-setup.py` | 2026-06-11 |
| `scripts/orchestration/founder-wellness-tracker.py` | 2026-06-11 |
| `scripts/orchestration/foundry_crdt_consensus.py` | 2026-06-11 |
| `scripts/orchestration/generate-audio-from-kb.py` | 2026-06-11 |
| `scripts/orchestration/generate-audio-simple.py` | 2026-06-11 |
| `scripts/orchestration/generate-audio-tutorial.py` | 2026-06-11 |
| `scripts/orchestration/generate_warren_buffett_pdf.py` | 2026-06-11 |
| `scripts/orchestration/generate_warren_buffett_pdf_final.py` | 2026-06-11 |
| `scripts/orchestration/inject-frank-narration.py` | 2026-06-11 |
| `scripts/orchestration/internet-archive-curator.py` | 2026-06-11 |
| `scripts/orchestration/lantern-audio-narrator.py` | 2026-06-11 |
| `scripts/orchestration/lantern-capability-attestation.py` | 2026-06-11 |
| `scripts/orchestration/lantern-desktop-auth-ui.py` | 2026-06-11 |
| `scripts/orchestration/lantern-provider-auth.py` | 2026-06-11 |
| `scripts/orchestration/lantern_orchestrator_main.py` | 2026-06-11 |
| `scripts/orchestration/lantern_payment_integration.py` | 2026-06-11 |
| `scripts/orchestration/llm-knowledge-base-reader.py` | 2026-06-11 |
| `scripts/orchestration/markdown-to-pdf.py` | 2026-06-11 |
| `scripts/orchestration/outreach-service.py` | 2026-06-11 |
| `scripts/orchestration/patent_steamboat_convergence.py` | 2026-06-11 |
| `scripts/orchestration/rag_semantic_search.py` | 2026-06-11 |
| `scripts/orchestration/rag_semantic_search_optimized.py` | 2026-06-11 |
| `scripts/orchestration/rag_server_local.py` | 2026-06-11 |
| `scripts/orchestration/validation_stress_test.py` | 2026-06-11 |

**src/ other** (7 files)

| File | Last commit |
|---|---|
| `src/csf/v07/hierarchical_delta.py` | 2026-06-11 |
| `src/generate_door_lora.py` | 2026-06-11 |
| `src/lantern-desktop/lantern_operator_chat.py` | 2026-06-11 |
| `src/sigma0_framework_test.py` | 2026-06-14 |
| `src/three_doors_classifier.py` | 2026-06-11 |
| `src/training/generate_training_dataset.py` | 2026-06-11 |
| `src/work_dispatcher.py` | 2026-06-14 |

**src/discord_lounge_bot** (5 files)

| File | Last commit |
|---|---|
| `src/discord_lounge_bot/bot_tools.py` | 2026-06-11 |
| `src/discord_lounge_bot/mcp_bridge.py` | 2026-06-11 |
| `src/discord_lounge_bot/mcp_connector.py` | 2026-06-11 |
| `src/discord_lounge_bot/music_queue.py` | 2026-06-11 |
| `src/discord_lounge_bot/rp_bot.py` | 2026-06-11 |

**src/hff-api** (8 files)

| File | Last commit |
|---|---|
| `src/hff-api/claim_safety.py` | 2026-06-11 |
| `src/hff-api/generate_report.py` | 2026-06-11 |
| `src/hff-api/health_probe.py` | 2026-06-11 |
| `src/hff-api/operator_device_api.py` | 2026-06-11 |
| `src/hff-api/phone_telemetry.py` | 2026-06-11 |
| `src/hff-api/polymorphic_seed_registry.py` | 2026-06-11 |
| `src/hff-api/sensor_profile.py` | 2026-06-11 |
| `src/hff-api/task_queue.py` | 2026-06-11 |

### B. Docs-only — referenced only from markdown (research writeups, CHANGELOG, specs)

**apps/bettersafe** (8 files)

| File | Primary doc reference |
|---|---|
| `apps/bettersafe/bettersafe.py` | `apps/bettersafe/bettersafe-local-first-architecture.md` |
| `apps/bettersafe/bettersafe_db.py` | `apps/bettersafe/bettersafe-local-first-architecture.md` |
| `apps/bettersafe/modules/appliance_scheduler.py` | `apps/bettersafe/bettersafe-local-first-architecture.md` |
| `apps/bettersafe/modules/fridge_manager.py` | `apps/bettersafe/bettersafe-local-first-architecture.md` |
| `apps/bettersafe/modules/household_tasks.py` | `apps/bettersafe/bettersafe-local-first-architecture.md` |
| `apps/bettersafe/modules/meal_coordinator.py` | `apps/bettersafe/bettersafe-local-first-architecture.md` |
| `apps/bettersafe/modules/safety_monitor.py` | `apps/bettersafe/bettersafe-local-first-architecture.md` |
| `apps/bettersafe/modules/social_services.py` | `apps/bettersafe/bettersafe-local-first-architecture.md` |

**config** (1 file)

| File | Primary doc reference |
|---|---|
| `config/dream_journal_api.py` | `docs/PR-DREAM-JOURNAL.md` |

**data** (3 files — archived raw dumps, not runnable scripts; keep with the archive)

| File | Primary doc reference |
|---|---|
| `data/csf_memory/raw/hff-500y-merge-2026-07-01/bio_threat_source_registry.py` | `docs/research/2026-07-01-hff-500y-merge-convergence.md` |
| `data/csf_memory/raw/hff-500y-merge-2026-07-01/byzantine_consensus.py` | `docs/FRONTIER-DIRECTIONS-2026-H2.md` |
| `data/csf_memory/raw/hff-500y-merge-2026-07-01/cryptographic_proof.py` | `docs/FRONTIER-DIRECTIONS-2026-H2.md` |

**experiments** (61 files — keep as frozen research evidence, see §2)

| File | Primary doc reference |
|---|---|
| `experiments/csf_hybrid_residual_probe.py` | `docs/research/2026-06-29-csf-beating-zstd.md` |
| `experiments/csf_three_standards_benchmark.py` | `CHANGELOG.MD` |
| `experiments/epistemic_eval.py` | `CHANGELOG.MD` |
| `experiments/eval_honesty_trackB.py` | `docs/research/2026-07-09-honesty-calibration-adapter-trackB.md` |
| `experiments/explore_nonnormal_contraction.py` | `docs/SIGMA0-T1-NONNORMAL-DICHOTOMY.md` |
| `experiments/halueval_ab.py` | `docs/BENCHMARKS.md` |
| `experiments/halueval_gated.py` | `.claude/skills/benchmarks/SKILL.md` |
| `experiments/halueval_gates_compare.py` | `docs/research/2026-07-05-halueval-surprise-gated.md` |
| `experiments/halueval_local.py` | `CHANGELOG.MD` |
| `experiments/hneurons_gate_operating_point.py` | `docs/research/2026-07-10-hneurons-probe.md` |
| `experiments/hneurons_under_ptqtp.py` | `docs/research/2026-07-10-honesty-under-quantization.md` |
| `experiments/humaneval_runner.py` | `docs/BENCHMARKS.md` |
| `experiments/kalshi_live_strategy.py` | `CHANGELOG.MD` |
| `experiments/kalshi_maker_backtest.py` | `docs/TRADER-ANALYSIS-2026-07.md` |
| `experiments/lapse_e1_contraction_diag.py` | `docs/research/2026-06-28-csf-tesseract-novelty-and-e1-kill.md` |
| `experiments/lapse_e1_ouro_coder.py` | `docs/research/2026-06-28-csf-tesseract-novelty-and-e1-kill.md` |
| `experiments/lapse_field_demo.py` | `docs/research/2026-06-20-lapse-tesseract.md` |
| `experiments/longmemeval_harness.py` | `.claude/skills/benchmarks/SKILL.md` |
| `experiments/memory_bench_incumbents.py` | `docs/memory-recall-benchmark.md` |
| `experiments/ouro_adaptive_compute_probe.py` | `docs/research/2026-06-28-csf-tesseract-novelty-and-e1-kill.md` |
| `experiments/ouro_canary_vs_logprob.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/pr_outcome_signal.py` | `docs/research/2026-07-04-pr-outcome-signal.md` |
| `experiments/prove_c3_noncollapse_nonnormal.py` | `docs/SIGMA0-C3-NONCOLLAPSE-NORMAL.md` |
| `experiments/prove_t1_nonnormal_dichotomy.py` | `docs/SIGMA0-T1-NONNORMAL-DICHOTOMY.md` |
| `experiments/ptqtp_coding_eval.py` | `docs/research/2026-07-10-ptqtp-ternary.md` |
| `experiments/ptqtp_lora_recovery.py` | `docs/research/2026-07-10-ptqtp-lora-recovery.md` |
| `experiments/ptqtp_quantize.py` | `docs/research/2026-07-10-ptqtp-ternary.md` |
| `experiments/question_machine_demo.py` | `docs/research/question-machine.md` |
| `experiments/rerank_lift_eval.py` | `CHANGELOG.MD` |
| `experiments/rho_controls.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/router_reservoir_G.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/sigma0_compressibility.py` | `docs/research/2026-06-29-csf-beating-zstd.md` |
| `experiments/sigma0_depth_accuracy.py` | `docs/research/2026-07-04-depth-accuracy-and-readout.md` |
| `experiments/sigma0_golden_benchmark.py` | `docs/SIGMA0-HONESTY-BENCHMARK.md` |
| `experiments/sigma0_grounding_deadline.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/sigma0_hardness_depth.py` | `docs/research/2026-07-09-hardness-depth.md` |
| `experiments/sigma0_hidden_probe.py` | `docs/research/2026-07-04-hidden-state-truth-probe.md` |
| `experiments/sigma0_hneurons_causal.py` | `docs/research/2026-07-10-hneurons-probe.md` |
| `experiments/sigma0_hneurons_causal_sweep.py` | `docs/research/2026-07-10-hneurons-probe.md` |
| `experiments/sigma0_hneurons_probe.py` | `docs/research/2026-07-10-hneurons-probe.md` |
| `experiments/sigma0_horse_blinders.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/sigma0_loop_jacobian.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/sigma0_ouro_honesty_eval.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/sigma0_pi_kolmogorov.py` | `docs/research/2026-06-29-csf-beating-zstd.md` |
| `experiments/sigma0_probe_transfer.py` | `docs/research/2026-07-09-truth-probe-transfer.md` |
| `experiments/sigma0_qexit_adaptive.py` | `docs/research/2026-07-04-qexit-adaptivity.md` |
| `experiments/sigma0_regime_sweep.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/sigma0_roa_certify.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/sigma0_spectral_honesty.py` | `docs/research/2026-07-10-spectral-honesty.md` |
| `experiments/sigma0_trigger_calibration.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/sigma0_true_jacobian.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/sigma_incremental_validity.py` | `CHANGELOG.MD` |
| `experiments/sigma_incremental_validity_ouro.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/sigma_theta_abc/harness.py` | `docs/SIGMA-THETA-ABC-HARNESS-SPEC.md` |
| `experiments/sigma_update_internal_signal_value.py` | `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` |
| `experiments/surprise_leak_ab.py` | `docs/FRONTIER-DIRECTIONS-2026-H2.md` |
| `experiments/surprise_leak_judge_regrade.py` | `docs/research/2026-07-01-surprise-leak-judge-regrade.md` |
| `experiments/train_cio_kalshi.py` | `docs/TRADER-ANALYSIS-2026-07.md` |
| `experiments/tsar_cpu_ternary.py` | `docs/research/2026-07-10-tsar-cpu-ternary.md` |
| `experiments/x3_dust_vs_bitnet_sparsity.py` | `docs/TESSERACT-CSF-SINGULARITY.md` |
| `experiments/x4_converge_step_instrument.py` | `docs/TESSERACT-CSF-SINGULARITY.md` |

**models/keystone-sigma0-plt** (1 file)

| File | Primary doc reference |
|---|---|
| `models/keystone-sigma0-plt/train_lora.py` | `docs/SIGMA0-PLT-HANDOFF.md` |

**root & misc** (1 file)

| File | Primary doc reference |
|---|---|
| `analyze_shorts.py` | `docs/creator-v10/learning-pipeline-research.md` |

**scripts** (39 files — see §3 for actions)

| File | Primary doc reference |
|---|---|
| `scripts/_write_index.py` | `CHANGELOG.MD` |
| `scripts/annotate_csf_archive.py` | `docs/CSF-FORMAT-SPECIFICATION.md` |
| `scripts/bench_ouro_loop.py` | `docs/adr/0012-nested-adaptive-reason.md` |
| `scripts/blind_study.py` | `docs/KEYSTONE-PRODUCT.md` |
| `scripts/build_honesty_calibration_aug.py` | `docs/research/2026-07-09-honesty-calibration-adapter-trackB.md` |
| `scripts/build_humaneval_corpus.py` | `docs/adr/0010-verify-gated-continual-learning-last-resort.md` |
| `scripts/build_sigma0_grounding_corpus.py` | `docs/research/2026-07-10-grounding-v2-verdict.md` |
| `scripts/consolidate_md_to_csf.py` | `CHANGELOG.MD` |
| `scripts/csf_pack_benchmark.py` | `docs/CSF-FORMAT-SPECIFICATION.md` |
| `scripts/decontaminate_training.py` | `docs/SIGMA-THETA-ABC-HARNESS-SPEC.md` |
| `scripts/distill_from_teacher.py` | `docs/research/2026-07-13-ouro-mbpp-distillation.md` |
| `scripts/eval_chat_drift.py` | `CHANGELOG.MD` |
| `scripts/eval_coding_ouro.py` | `CHANGELOG.MD` |
| `scripts/eval_humaneval_chat.py` | `.claude/skills/benchmarks/SKILL.md` |
| `scripts/eval_humaneval_plt_direct.py` | `docs/SIGMA0-PLT-HANDOFF.md` |
| `scripts/eval_paired_diff.py` | `docs/BENCHMARKS.md` |
| `scripts/eval_swebench_chat.py` | `.claude/skills/benchmarks/SKILL.md` |
| `scripts/filter_gaming_shorts.py` | `docs/V10-IMPLEMENTATION-COMPLETE.md` |
| `scripts/generate_lantern_soundscape.py` | `skills/dream_journal/symbolic/concepts/quantum-dust.md` |
| `scripts/harvest_tool_traces.py` | `docs/SIGMA0-CODER-DEVBOX-SETUP.md` |
| `scripts/lightning_incremental_validity.py` | `CHANGELOG.MD` |
| `scripts/orchestration/lantern-integrated.py` | `apps/bettersafe/bettersafe-local-first-architecture.md` |
| `scripts/pr_crystallize.py` | `docs/adr/0015-qwen-teacher-verified-distillation.md` |
| `scripts/prep_code_instruct.py` | `docs/research/2026-06-27-ouro-70pct-findings.md` |
| `scripts/prep_opencode_training.py` | `docs/research/2026-06-26-ouro-humaneval-training.md` |
| `scripts/qwen_teacher_crystallize.py` | `docs/adr/0015-qwen-teacher-verified-distillation.md` |
| `scripts/rebuild_index.py` | `CHANGELOG.MD` |
| `scripts/rerun_shorts_real.py` | `docs/creator-v10/learning-pipeline-research.md` |
| `scripts/research-and-update-issues.py` | `docs/WEEKLY-TRAINING-SETUP.md` |
| `scripts/serve_minicheck.py` | `PROVIDERS.md` |
| `scripts/sigma0_coder_agent.py` | `docs/SIGMA0-CODER-CLAUDE-CODE-STATUS.md` |
| `scripts/swe_agent_loop.py` | `.claude/skills/benchmarks/SKILL.md` |
| `scripts/swe_agentic_run.py` | `docs/BENCHMARKS.md` |
| `scripts/swebench_verifier_harness.py` | `docs/research/2026-07-10-swebench-verifier.md` |
| `scripts/update_convergence_records.py` | `docs/FRONTIER-DIRECTIONS-2026-H2.md` |
| `scripts/v10_training_loop.py` | `docs/V10-IMPLEMENTATION-COMPLETE.md` |
| `scripts/warm_sigma0_council.py` | `docs/SIGMA0-EV-GATE.md` |
| `scripts/youtube_shorts_collector_v2.py` | `docs/V10-IMPLEMENTATION-COMPLETE.md` |
| `scripts/youtube_shorts_ingestion.py` | `docs/SIGMA0-V10-SYSTEM.md` |

**skills** (2 files)

| File | Primary doc reference |
|---|---|
| `skills/dream_journal/cognitive_layer.py` | `skills/dream_journal/SKILL.md` |
| `skills/dream_journal/dream_agent.py` | `skills/dream_journal/docs/SYMBOLIC-INDEX.md` |

**src/ other** (9 files)

| File | Primary doc reference |
|---|---|
| `src/csf/coder_grounding.py` | `CHANGELOG.MD` |
| `src/csf/legacy.py` | `CLAUDE.md` (read-only legacy reader — keep per CSF v2 consolidation) |
| `src/csf/omni.py` | `docs/CSF-FORMAT-SPECIFICATION.md` |
| `src/csf/profile_pack.py` | `docs/CSF-FORMAT-SPECIFICATION.md` |
| `src/csf/v07/symbolic_dictionary.py` | `docs/ALEX-ASI-ARCHITECTURE.md` |
| `src/discord_lounge_bot/health_check.py` | `SCRIPTS.md` |
| `src/discord_lounge_bot/memory_layer.py` | `docs/RUST-MIGRATION-PLAN.md` |
| `src/dream_journal/orchestrator.py` | `manifests/open-issues.md` |
| `src/lantern-desktop/lantern_desktop.py` | `lore/LANTERN-CHARACTERS-AND-REALMS.md` |

**src/hff-api** (7 files — remove with the tree)

| File | Primary doc reference |
|---|---|
| `src/hff-api/bio_threat_source_registry.py` | `docs/research/2026-07-01-hff-500y-merge-convergence.md` |
| `src/hff-api/byzantine_consensus.py` | `docs/FRONTIER-DIRECTIONS-2026-H2.md` |
| `src/hff-api/cryptographic_proof.py` | `docs/FRONTIER-DIRECTIONS-2026-H2.md` |
| `src/hff-api/dashboard_app.py` | `CHANGELOG.MD` |
| `src/hff-api/safe_app.py` | `skills/dream_journal/symbolic/characters/keystone-public-copy-incident-memory.md` |
| `src/hff-api/seed_data.py` | `CHANGELOG.MD` |
| `src/hff-api/wsgi.py` | `CHANGELOG.MD` |

**tests** (1 file)

| File | Primary doc reference |
|---|---|
| `tests/perf_dream_journal.py` | `docs/PR-DREAM-JOURNAL.md` (never collected by pytest — see Fix #4) |

### C. Weakly referenced — mentioned only by other unwired code or comments

| File | Referenced by |
|---|---|
| `apps/superfleet_memory/narrative_identity.py` | `apps/superfleet_memory/__init__.py` |
| `experiments/sigma0_reconstruction.py` | `experiments/sigma0_smoke_on_real_log.py` |
| `experiments/sigma0_smoke_on_real_log.py` | `experiments/sigma0_compressibility.py` |
| `scripts/orchestration/master_plan_narrator.py` | `scripts/orchestration/lantern-integrated.py` |
| `scripts/orchestration/rag_compression.py` | `scripts/orchestration/validation_stress_test.py` |
| `scripts/prepare-three-doors-dataset.py` | `scripts/train-three-doors-models.py` |
| `scripts/rebalance_fc_corpus.py` | `scripts/eval_fc_indomain.py` |
| `scripts/train-lora-diffusion.py` | `scripts/train-csf-image-models.py` |
| `scripts/train-three-doors-models.py` | `scripts/prepare-three-doors-dataset.py` |
| `src/csf/v07/base3_positions.py` | `src/csf/v07/hierarchical_delta.py` |
| `src/hff-api/adoption_tracker.py` | `src/hff-api/app.py` |
| `src/hff-api/agent_system.py` | `src/hff-api/app.py` |
| `src/hff-api/app.py` | `src/hff-api/safe_app.py` |
| `src/hff-api/background_mode.py` | `src/hff-api/safe_app.py` |
| `src/hff-api/chat_memory_integration.py` | `src/hff-api/app.py` |
| `src/hff-api/data_sources.py` | `src/hff-api/app.py` |
| `src/hff-api/deploy_identity.py` | `src/hff-api/safe_app.py` |
| `src/hff-api/device_telemetry.py` | `src/hff-api/operator_device_api.py` |
| `src/hff-api/live_observation_telemetry.py` | `src/hff-api/live_sensors.py` |
| `src/hff-api/live_sensors.py` | `src/hff-api/app.py` |
| `src/hff-api/mesh_network.py` | `src/hff-api/app.py` |
| `src/hff-api/perfect_adjacent_review.py` | `src/hff-api/sensor_profile.py` |
| `src/hff-api/sensors.py` | `src/hff-api/app.py` |
| `src/hff-api/world_model.py` | `src/hff-api/app.py` |
| `src/slot_loader.py` | `src/work_dispatcher.py` (itself an orphan) |

### D. Wired — anchored to a real execution surface

| Group | Count | Anchor types seen |
|---|---|---|
| `(root)` | 1 (`conftest.py`) | pytest |
| `apps` | 3 | via imports |
| `data` | 1 | via imports |
| `experiments` | 29 | config, node-server, shell, via |
| `models` | 6 | node-server, via |
| `scripts` | 65 | ci, config, hooks, mcp, node-server, shell, via |
| `skills` | 4 | mcp, via |
| `src/*` (libraries + services) | 113 | ci, config, hooks, mcp, node-server, npm, shell, via |
| `tests` | 153 | pytest (CI), makefile, node-server |

**Wired `scripts/` detail** (surface anchor for each — SCRIPTS.md regeneration payload):

| Script | Anchored by |
|---|---|
| `scripts/Test-ConvergenceAgentFleet.py` | `scripts/Invoke-LanternConvergenceLoop.ps1`, `scripts/Invoke-LanternSmartConvergenceLoop.ps1` |
| `scripts/agent_inspector.py` | `scripts/Start-TesseractListener.ps1` |
| `scripts/arxiv_build_index.py` | `lib/arxiv-index.js`, `lib/csf-memory.js` |
| `scripts/arxiv_harvest.py` | `lib/arxiv-fulltext.js`, `lib/csf-memory.js` |
| `scripts/build_claude_session_dataset.py` | `tests/test_agent_session_dataset.py` |
| `scripts/build_knowledge_index.py` | `lib/knowledge-router.js` |
| `scripts/build_library_thumbs.py` | `routes/library.js` |
| `scripts/build_ouro_coding_dataset.py` | `scripts/continual_ouro_pipeline.py` |
| `scripts/continual_ouro_pipeline.py` | `lib/keystone-escalation.js`, `lib/stream-chat.js` |
| `scripts/convergence_close_loop.py` | `lib/convergence-status.js`, `lib/kalshi-convergence-outcomes.js` |
| `scripts/convert-pairs-to-alpaca.py` | `scripts/continual-train.ps1` |
| `scripts/convert_fc_dataset.py` | `scripts/retrain-combined.ps1` |
| `scripts/csf_condense_corpus.py` | `routes/pdfs.js` |
| `scripts/csf_read_member.py` | `routes/pdfs.js` |
| `scripts/csf_research_tesseract.py` | `routes/csf.js`, `server.js` |
| `scripts/csf_split_archive.py` | `routes/pdfs.js` |
| `scripts/eval_coding.py` | `scripts/eval_coding_backend_ab.py` |
| `scripts/eval_coding_backend_ab.py` | `lib/coding-backend/index.js` |
| `scripts/eval_humaneval_ouro.py` | `scripts/continual_ouro_pipeline.py` |
| `scripts/eval_keystone.py` | `.github/workflows/eval-leaderboard-gate.yml` |
| `scripts/eval_ledger.py` | `tests/test_eval_ledger.py` |
| `scripts/eval_sigma0_adapter.py` | `tests/test_sigma0_eval.py` |
| `scripts/extract-session-pairs.py` | `scripts/continual-train.ps1` |
| `scripts/facecam_face_detect.py` | `lib/facecam-v3.js` |
| `scripts/fetch_radio_audio.py` | `scripts/normalize_radio_levels.py` |
| `scripts/fine-tune-ollama-model.py` | `scripts/convert-pairs-to-alpaca.py` |
| `scripts/gen_sigma0_traces.py` | `lib/local-model-registry.js` |
| `scripts/generate-door-images.py` | `lib/stream-chat.js` |
| `scripts/generate-with-trained-lora.py` | `lib/image-generation.js` |
| `scripts/harvest_coding_corpus.py` | `lib/harvest-emitter.js` |
| `scripts/honesty_ledger.py` | `tests/test_honesty_ledger.py` |
| `scripts/humaneval_rerank.py` | `scripts/eval_humaneval_ouro.py` |
| `scripts/image_generator.py` | `routes/image.js` |
| `scripts/kalshi_odds.py` | `src/mcp_server/server.py` |
| `scripts/lightning_dispatch.py` | `lib/training-dispatcher.js` |
| `scripts/mcp_stdio_bridge.py` | `.mcp.json`, `.mcp/claude-desktop.json` |
| `scripts/measure_drift_equivalence.py` | `tests/test_drift_equivalence.py` |
| `scripts/merge-lora-weights.py` | `src/sd_image_server.py` |
| `scripts/merge-lora.py` | `scripts/continual-train.ps1` |
| `scripts/normalize_radio_levels.py` | `public/radio/stations-pending-restore.json` |
| `scripts/orchestration/lantern-billing.py` | `scripts/orchestration/Deploy-FamilyA-24Hour.ps1` ⚠ launcher itself likely dead |
| `scripts/orchestration/lantern-chat-ui.py` | same ⚠ |
| `scripts/orchestration/lantern-kids-ui.py` | same ⚠ |
| `scripts/orchestration/lantern-telemetry.py` | same ⚠ |
| `scripts/orchestration/rag_local_knowledge_base.py` | `scripts/Ingest-CaadZip.ps1` |
| `scripts/ouro_anthropic_bridge.py` | `lib/tool-runner.js`, `scripts/Start-OuroClaudeCode.ps1` |
| `scripts/ouro_compat.py` | `tests/test_ouro_compat.py` |
| `scripts/ouro_serve.py` | `.claude/agent-slots.json`, `.github/workflows/eval-leaderboard-gate.yml` |
| `scripts/ouro_serve_smoketest.py` | `scripts/rebuild-train-venv.ps1` |
| `scripts/prepare_coding_train_data.py` | `lib/model-registry.js` |
| `scripts/resume_docx.py` | `routes/docmode.js`, `routes/documents.js` |
| `scripts/rlvr_grpo_ouro.py` | `tests/test_sigma_theta_gate.py` |
| `scripts/rollover_gate.py` | `scripts/eval_keystone.py` |
| `scripts/train-qlora-ouro.py` | `lib/model-registry.js` |
| `scripts/train-qlora-peft.py` | `scripts/continual-train.ps1` |
| `scripts/train-three-doors-lora.py` | `routes/training.js` |
| `scripts/upload-anthropic-finetune.py` | `scripts/extract-session-pairs.py` |
| `scripts/validate-agents-md.py` | `scripts/hooks/pre-commit-full-validation` |
| `scripts/validate-autoupdate-safety.py` | `scripts/hooks/pre-commit-full-validation` |
| `scripts/validate-deployment-readiness.py` | `scripts/hooks/pre-commit-full-validation` |
| `scripts/validate-prepush-stale-clobber.py` | `scripts/hooks/pre-push` |
| `scripts/validate-prepush-version-changelog.py` | `scripts/hooks/pre-push` |
| `scripts/validate-version-changelog.py` | `scripts/hooks/pre-commit-version-changelog` |
| `scripts/validate_ouro_coding.py` | `scripts/prepare_coding_train_data.py` |
| `scripts/weekly-training-orchestrator.py` | `scripts/Schedule-WeeklyTraining.ps1` |

### E. Package markers — bare `__init__.py`, structural (keep with their package)

- `apps/__init__.py`
- `apps/bettersafe/modules/__init__.py`
- `apps/superfleet_memory/__init__.py`
- `data/csf_memory/raw/hff-500y-merge-2026-07-01/three-doors-game-skill/__init__.py`
- `skills/dream_journal/__init__.py`
- `skills/job_application/__init__.py`
- `skills/three-doors-game/__init__.py`
- `src/hff-api/routes/__init__.py`
- `src/sinatra_lounge/__init__.py`
