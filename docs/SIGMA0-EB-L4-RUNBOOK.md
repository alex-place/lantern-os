---
author: Alex Place
created: 2026-07-17
updated: 2026-07-17
---

# E-B on L4 — the gated-training run, as a handoff

*Self-contained runbook for executing the Σ_θ A/B/C gated-training experiment with the
four-arm promotion-evidence protocol ([#2691](https://github.com/alex-place/lantern-os/issues/2691)).
Written so an operator or agent session on the L4 host can run it with zero context from the
authoring session. Read cover to cover before spending GPU money.*

## 0. Mission, in one paragraph

Run real RLVR/distill training on cloud L4 and push the resulting checkpoints through the
**four promotion-evidence arms** (Fixed / Fixed+dither / Fresh-flow / Thresholdout+pool,
`experiments/sigma_theta_abc/holdout_protocol.py`) with the **real seven-condition Σ_θ gate**
(`experiments/sigma_theta_abc/harness.py`), then score every arm's final champion on a
never-touched hidden task block. This closes the last empirical gap in cert §8.6 teeth 1–4
and answers the **Roelofs question**: does fixed-holdout staleness actually materialize at
real scale, or was the simulation a worst-case story? **A refutation is a valid completion**
— either answer upgrades the cert's §8.4 blocks from MEASURED-by-simulation to MEASURED.

## 1. Venue, gates, and cost approval

- **Host:** Lightning cloud **L4** — the venue where arm-C GRPO was verified end-to-end
  (PR #2231). Everything trains behind `KEYSTONE_L4=1`; the harness *refuses* to train
  without it, by design — do not bypass on any other machine.
- **Repo state:** master **after PR #2693 merges** (it carries the protocol + tests this
  runbook depends on). Verify: `python -m pytest tests/test_sigma_theta_gate.py
  tests/test_sigma_theta_holdout_protocol.py -q` → 17 passed, no GPU needed.
- **Cost approval:** estimate ≈ **12–20 L4-hours** (arm A ~2–3 h, arm B ~3–4 h, arm C GRPO
  ~4–6 h, evals ~3–5 h, slack). **Get Alex's explicit cost sign-off with the estimate
  before launching.** Nothing here touches production systems; rollback is trivial
  (adapters on disk, base frozen).

## 2. Inventory — verified 2026-07-17

**Exists and is tested (do not rebuild):**

| Piece | Where | Status |
|---|---|---|
| 7-condition Σ_θ gate + A/B/C decision tree | `experiments/sigma_theta_abc/harness.py` | self-tested, CI-safe (`--self-test`) |
| Four-arm promotion protocol + provenance ledgers + Thresholdout budgeting | `experiments/sigma_theta_abc/holdout_protocol.py` | 7/7 checks at task-level stuck fidelity; model-agnostic via `eval_fn` |
| GRPO/RLVR trainer (arm C) | `scripts/rlvr_grpo_ouro.py` | math CI-tested; **run verified on L4** (PR #2231) |
| QLoRA distill trainer (arms A/B) | `scripts/train-qlora-ouro.py` | in production use |
| Exec evaluators | `scripts/eval_humaneval_ouro.py`, `scripts/eval_sigma0_adapter.py`, `scripts/continual_ouro_pipeline.py` | exist; used by prior runs |
| Σ₀ stability probe (gate cond 5) | `cio_sde.collapse.jsrr_certificate` via `loop_lm.generate()` (cert §1.2.3) | machine-checked |

**Does NOT exist — the executor builds these (steps 3–5):**

1. The three training files `plan_commands()` references: `data/eval/distill.jsonl`,
   `data/eval/distill-replay.jsonl`, `data/eval/rlvr-train.jsonl`.
2. The **task partition** (`data/eval/eb-partition.json`) — local suites are thin
   (mbpp-basic 18, coding-golden 25, sigma0-prompts 65); the full corpus is assembled on
   the host.
3. The **eval → 7-metric glue** (per-candidate metrics JSON) — the gap `harness.py` names
   in its `run()` docstring.
4. The real `eval_fn` binding for the protocol arms (subprocess → exec evaluator).

## 3. Step 0 (CPU, before touching the GPU) — corpus + partition + training data

> **✅ AUTOMATED — `scripts/eb_prep_corpus.py`.** One command on any egress machine builds
> everything below: `python scripts/eb_prep_corpus.py --allow-download`. It pulls
> best-practice, license-verified open datasets (2026-07-17) — **OpenCodeInstruct** (CC BY 4.0,
> Qwen-generated so no GPT-distillation-ToS entanglement) → `distill.jsonl`/`distill-replay.jsonl`;
> **Eurus-2-RL-Data** coding split (MIT, executable tests) → `rlvr-train.jsonl`; **LiveCodeBench**
> (contamination-free, date-annotated) + MBPP + HumanEval → the partition — decontaminates every
> train prompt sharing a 13-gram with any eval prompt, and fills the **hidden block from
> post-cutoff LiveCodeBench** (the freshness-law selector, #2692). `--dry-run` validates all logic
> offline. The three dispatch scripts run it automatically if `data/eval/distill.jsonl` is missing.
> The manual recipe below documents what it produces.

Assemble ≥ 900 exec-verified Python tasks: **MBPP full** (~974, via HF `datasets`:
`mbpp`, sanitized split) + **HumanEval** (164, `scripts/build_humaneval_corpus.py`) +
the repo suites above. Every task gets a stable integer id and a `{prompt, tests}` record.

Partition **once**, with a recorded seed, into disjoint blocks — write
`data/eval/eb-partition.json` mapping block → task ids, and commit it:

```
retention   100   historic suite; every arm's gate cond 2 reads it
sealed       60   Fixed/Fd arm reading set AND Thresholdout sealed holdout
pool        240   Thresholdout burned pool (plays "retired promotion sets")
fresh     8×60    Fresh-flow arm: one block per gate, used once, retired
world      8×30   per-gate independent block for gate cond 3 world_eval
hidden      100   FINAL truth scoring ONLY — no arm, gate, or human reads it
                  until step 7; treat contact as run-invalidating
```

Training files (the A/B/C data mixes, ADR-0025): `distill.jsonl` = verified distillation
records (existing `models/lantern-sigma0-coder` training data path in
`train-qlora-ouro.py`'s default is the template); `distill-replay.jsonl` = same + verified
generative replay + generic anchor mix (see `continual_ouro_pipeline.py`); `rlvr-train.jsonl`
= `{prompt, tests}` exec-graded tasks **drawn only from the training side** — assert zero id
overlap with every evaluation block above (the provenance ledger will check, but fail fast
here). Record the manifest (counts + id ranges + seed) in the partition file.

## 4. Step 1 (L4) — train the arms, snapshot the candidate stream

```bash
KEYSTONE_L4=1 python experiments/sigma_theta_abc/harness.py --run --out runs/abc
```

This dispatches, per `plan_commands()`: arm A (QLoRA on `distill.jsonl`), arm B (QLoRA on
`distill-replay.jsonl`), arm C (`rlvr_grpo_ouro.py --warm-start runs/abc/B`, group 8,
300 steps). **Modify the two trainers' invocation to snapshot adapters** every ~⅛ of
training (A: per epoch; C: every ~40 GRPO steps) → target **≥ 12 candidate checkpoints**
across the three arms plus the frozen-base retrieval baseline. The snapshot order (by
wall-clock) is the **candidate stream**; every protocol arm sees the same stream in the
same order.

## 5. Step 2 — the eval → 7-metric glue (the named remaining wiring)

For each candidate checkpoint, produce the metric dict `harness.sigma_theta_gate` consumes
(keys exactly as in `harness.py`): `fresh_pass1` (pass@1 on the *arm's current reading
set* — this is where the four arms differ), `retention_pass1` (retention block),
`proxy_reward` (pass rate on its **own training tasks** — the hackable proxy),
`world_eval` (this gate's `world` block — never reused), `kl_from_prior` (arm C: logged by
the GRPO trainer; arms A/B: token-level KL vs base on a fixed probe batch),
`adapter_norm` (L2 of adapter deltas), `stability_ok` (JSRR `ρ<1` verdict from a probe
generation), `no_contamination` (partition ledger ∩ training manifest = ∅),
`provenance_present` (manifest exists), `rollback_available` (prior adapter retained —
true by construction). Bind the protocol arms with:

```python
def eval_fn(checkpoint, task_ids):          # replaces the synthetic eval_candidate
    return exec_pass_rate(checkpoint, partition.tasks(task_ids))   # greedy, temp=0
```

Greedy decoding matters: it is what makes re-evaluation stuck — the mechanism under test.

## 6. Steps 3–4 — run the gates, then the teeth

Run the sequential gates over the candidate stream per arm (reuse the loop shape of
`holdout_protocol.run_seed`, real `eval_fn` substituted); log per-gate reported scores,
Thresholdout budget spends, and ledgers to `runs/abc/protocol_log.jsonl`. Then the teeth:

- **Contaminated hack:** QLoRA a LoRA **on the sealed block itself** (deliberate). Must be
  rejected in every arm — Fixed via cond 6 (ledger), Fresh via cond 1 (merit).
- **Forgetter:** over-train on one narrow fresh block until retention drops ≥ 0.05.
  Cond 2 must fire in every arm.

## 7. Step 5 — final truth + pre-registered verdicts

Score every arm's final champion (and the retrieval baseline) on the **hidden** block —
its first and only use. Pre-registered expectations (from the 16-seed task-level sim,
`data/sigma0/holdout_protocol_report.json` — the run is confirmatory, not exploratory):

1. **Validity:** Fixed's reported−hidden gap is the largest of the four arms.
2. **Extraction:** Fresh ≥ every other arm on hidden truth; **Fd > Fixed** at zero extra
   task cost (the #2692 dither knob); Thresholdout best per fresh task consumed.
3. **Teeth:** both planted candidates rejected in all arms, with the arm-appropriate
   reasons above.
4. **Roelofs verdict rule (pre-registered):** the ratchet "materializes at real scale" iff
   Fixed's validity gap ≥ 2× Fresh's AND Fixed's hidden-truth extraction < Fresh's. If it
   does **not** materialize, that is the Roelofs counterpoint confirmed at our scale —
   record it, re-scope cert §8.4 to adversarial promotion processes, and say so plainly.

## 8. Reporting back (the part that makes it real)

- Append the results table + verdicts to [#2691](https://github.com/alex-place/lantern-os/issues/2691).
- Cert updates, per its own discipline: §8.4 third-road block and §8.6 teeth 2–4 move
  MEASURED-by-simulation → **MEASURED (real run)** with run pointers — *in whichever
  direction the data lands*; Appendix M entry; audit-table rows point at the committed
  `runs/abc` artifacts. Update `SIGMA0-GROUNDING-LEDGER.md` §3 to match.
- No claim without a run pointer; no label upgrades beyond what ran; a refutation is a
  completed acceptance criterion, not a failure.

## 9. Acceptance checklist

- [ ] Alex's cost sign-off recorded (estimate + actual)
- [ ] `eb-partition.json` committed; zero train/eval id overlap asserted
- [ ] ≥ 12 candidates trained + snapshotted on L4 (`KEYSTONE_L4=1`)
- [ ] Per-candidate 7-metric JSONs + `harness.py --results` decision recorded
- [ ] Four-arm gate sequence logged; Thresholdout budget accounting in the log
- [ ] Both teeth rejected, reasons recorded per arm
- [ ] Hidden block touched exactly once, at the end
- [ ] #2691 comment + cert + ledger updated with evidence-class-honest results

## 10. Dual-provider redundant execution (concurrent) — the wired path

A ~12–20 h single-GPU run is exactly what dies at hour 12 to a spot reclaim, an OOM, or
a CUDA/driver mismatch with Ouro's custom `transformers==4.57` loop — and you don't find
out until the time is burned. So run the identical job on **two independent clouds at
once**: if either breaks, the other lands the result; because the job is seeded, two runs
that agree is a stronger result (a reproducibility cross-check), and two that disagree is
itself a finding (the gate margin is hardware-sensitive).

**This is wired into the orchestration page, not a bespoke script.** The GPU-training
orchestration already fans out to every `automatable` provider concurrently, and **Modal
is now a registered provider alongside Lightning** (`lib/training-dispatcher.js` +
`scripts/modal_dispatch.py`, mirroring the Lightning dispatch contract). So:

1. **Credentials** (once): on the orchestration page's *Keys* panel, save `MODAL_TOKEN_ID`
   + `MODAL_TOKEN_SECRET` (modal.com → Settings → API Tokens) and `HF_TOKEN`. Lightning is
   already connected (existing job history). Both providers default to a **bf16 L4** — the
   Ouro QLoRA recipe NaNs in fp16 on pre-Ampere silicon, so T4 is refused on both.
2. **Launch concurrently**: the page's **"Start — dispatch-all"** button
   (`POST /api/gpu-training/dispatch-all`) fires Lightning **and** Modal in parallel on the
   same seeded job. Each logs a `training_dispatch` record; poll both from the same panel.
3. **No artifact clobber**: Lightning uploads `output.csf`, Modal uploads
   `output.modal.csf` (namespaced on purpose) to the same HF repo — both twins' adapters
   survive for the cross-check.
4. **First-green-wins**: whichever finishes first is the result you ship; the second is the
   cross-check.
5. **Reconcile** (no GPU): `python scripts/reconcile_dual_provider.py --decision
   A/decision.json B/decision.json` (E-B verdicts) or `--sha <a> <b>` (adapter
   footer_sha256). Exit 0 = agree → post the confirmed result to #2691; exit 1 = divergent
   → post both and flag the hardware-sensitive margin.

**Provider pairing & cost** (rates verified 2026-07-17; ~$8–16/run, ~$20 both, mostly
covered by Modal's $30/mo credit): **Lightning** (primary — the proven #2231 venue) +
**Modal** (redundant twin — independent serverless infra, per-second billing). RunPod
Secure Cloud on-demand is the documented manual fallback if either hits capacity. Use
on-demand tiers, never spot, for a long single job.

> **For the E-B run specifically**, each provider runs the harness (`sigma_theta_abc/
> harness.py`) instead of the continuation `train-qlora-ouro.py` body — same Modal/Lightning
> dispatch primitive, different entry command. The partition (esp. the **hidden block**)
> must be generated once and shipped to both providers identically (§3), or the two runs
> aren't the same job.
