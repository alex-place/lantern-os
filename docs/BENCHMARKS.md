# BENCHMARKS — External Marks Registry

**The maintained list of every *public, externally-defined* benchmark Keystone OS has run or
plans to run.** "Real online marks" = benchmarks owned by someone else, with a fixed public
dataset and a grading contract we don't control (HumanEval, SWE-bench, LongMemEval, …). This is
the Σ₀ external-reality rule applied to ourselves: a capability claim is only real with
`[claim, evidence, confidence, source]`, and *these* are the sources.

> Internal/synthetic checks (coding-golden, sigma0-prompts, the CSF compression benchmarks, the
> AGI-capability *reference* matrix in `data/benchmarks/`) are **not** in this registry — they are
> our own marks, not external ones. They live with their harnesses; this file is only for marks we
> are graded against by the outside world.

**Evidence ledgers (the source of truth for results):**
- [`data/eval/leaderboard.jsonl`](../data/eval/leaderboard.jsonl) — one row per coding/serving run (`pass@1` / `accuracy`). CI-gated: see [eval-leaderboard-gate.yml](../.github/workflows/eval-leaderboard-gate.yml). Every row is stamped with provenance — `git_sha`, `served_checkpoint` (the `OURO_*` model+adapter measured), and `campaign_id` (set `EVAL_CAMPAIGN_ID` to group a whole-suite run) — via `scripts/eval_ledger.append_leaderboard` (#2108), so rows are groupable by snapshot and a cross-benchmark read knows it's comparing one model, not two.
- [`data/longmemeval/runs.jsonl`](../data/longmemeval/runs.jsonl) — one row per memory-retrieval run (`recall@k` / `MRR`).
- `data/eval/swebench/<label>-<ts>.jsonl` — SWE-bench predictions in official format (grade later).

**Comparing two runs:** never conclude from two bare means. `scripts/eval_paired_diff.py <A.jsonl> <B.jsonl>`
pairs the runs' per-problem detail files on `task_id` and reports the paired mean difference with SEM,
95% CI, win/loss/tie counts, and an exact sign test (#1966, per arXiv:2411.00640 recs 1+4).

---

**Last review: 2026-07-05** (`/benchmarks`, issue #2135 follow-up). Competitor SOTA web-validated live: SWE-bench Verified — Claude Mythos 5 **95.5%** > Claude Fable 5 95% > Claude Opus 4.8 88.6% > DeepSeek-V4-Pro-Max 80.6% (llm-stats, Jul 4); MBPP — o4-mini **94.9%** (codesota, Dec 2025); HumanEval saturated (frontier >93%, retired as differentiator). **Serving-provenance finding:** on this box the only servable checkpoints are base `Ouro-1.4B` / `-Thinking` with **no coding LoRA on disk** — both emit near-empty completions, so a fresh coding-golden-25 run scored **0% pass@1** (`leaderboard.jsonl` label `ouro-thinking-base-golden25`, ts 1783296694). The `ck600` adapter that produced 0.427 is **not present here** — but the **owned `keystone-sigma0-plt` (~7.6B LoopCoder) full weights _are_ on disk** and serve fine in 4-bit on `:11435`. Its first measured eval landed the same session: **88% pass@1 (22/25) on coding-golden** (`leaderboard.jsonl` label `keystone-plt-golden25-4bit`, reproduced twice), ~150 s/problem at 4-bit on a 12 GB box. So the servable local coder is the PLT model, not Ouro; raw-capability is a real 88% on the internal set, with the external HumanEval-164 head-to-head still owed (≈13 h locally → cloud L4/A100). SWE-bench remains the single empty differentiating cell (needs Docker, unavailable locally).

---

## Status legend

| Status | Meaning |
|---|---|
| ✅ **Run** | Harness exists and has produced ≥1 real measured row in a ledger. |
| 🟡 **Partial** | Harness exists; only run against a synthetic fixture / subset, real public set not yet pulled. |
| 📋 **Planned** | We intend to measure it; no harness yet (tracked as a public *reference target*). |

---

## Registry

| Benchmark | Loop stage | What it measures | Harness | Status | Latest evidence |
|---|---|---|---|---|---|
| **HumanEval** | Act / Reason | Code pass@1 (164 problems) | `scripts/eval_humaneval_chat.py`, `scripts/eval_humaneval_ouro.py`, `experiments/humaneval_runner.py` | ✅ Run | **Ouro** full-164 pass@1 **0.427**; the **0.75** subset row is **Qwen-3B base**+Σ₀ data (a ceiling probe, *not* our local model) — `leaderboard.jsonl` |
| **MBPP** (basic subset) | Act | Exec-graded function synthesis | `scripts/eval_coding.py` (+ `data/eval/mbpp-basic.jsonl`) | ✅ Run | `leaderboard.jsonl` / `data/eval/mbpp-basic.jsonl` |
| **SWE-bench Lite** | Act / Verify | Real-repo issue → patch, resolved% (official Docker/Modal grader) | `scripts/eval_swebench_chat.py`, `scripts/swe_agent_loop.py`, `scripts/swe_agentic_run.py` | 🟡 Partial | Qwen single-shot **0/3** (2 applied-but-wrong); agentic propose→test→retry loop landed |
| **LongMemEval** | Remember | Memory retrieval recall@k / MRR over long multi-session histories | `experiments/longmemeval_harness.py` | ✅ Run | Real `longmemeval_s` (n=189, k=5): multi-signal recall@5 **0.709** / MRR **0.486** vs keyword **0.222** / 0.098 — `data/longmemeval/runs.jsonl` (2026-07-01) |
| **HaluEval-QA** | Verify | Hallucination rate; grounded A/B for the ADR-0017 accept gate (≥20% rel. reduction) | `experiments/halueval_ab.py` (+ `data/eval/halueval-qa-subset.jsonl`) | 🟡 Partial | Real HaluEval (RUCAIBox), GPT-4o-mini n=40: grounding cuts hallucination **55% → 20%** (**64% rel.**, ≥ 20% gate ✓) — `data/eval/halueval_ab_results.json` |
| **SimpleQA-Verified** | Verify | Short-form factual honesty: F1 of accuracy × attempt-rate on 1000 sourced Qs (rewards calibrated abstention over confabulation) | — (Kaggle dataset + F1/attempted/hedged grader; extend `sigma0_live_bench.py`) | 📋 Planned | Published leaderboard (Google DeepMind, [arXiv:2509.07968](https://arxiv.org/abs/2509.07968) Table 7): Gemini 2.5 Pro F1 **55.6** SOTA > GPT-5 52.3 > o3 51.9; **ours not yet run** |
| **SWE-bench Verified** | Act / Verify | Human-validated SWE-bench subset, resolved% | — (extend `eval_swebench_chat.py` `--dataset`) | 📋 Planned | reference target, `data/benchmarks/agi-capability-matrix.json` |
| **PersonaMem** | Remember | Persona-consistent long-memory recall (MemOS comparison set) | — | 📋 Planned | paired with LongMemEval (MemOS publishes both) |
| **ARC-AGI** | Reason | Fluid reasoning, no training data | — | 📋 Planned | `data/benchmarks/arc-agi.json` |
| **Humanity's Last Exam** | Reason | Frontier expert-level QA | — | 📋 Planned | `data/benchmarks/humanitys-last-exam.json` |
| **OSWorld** | Act | Real desktop/computer-use task success | — | 📋 Planned | `data/benchmarks/agi-capability-matrix.json` |
| **SuperARC** | Reason | Compression/abstraction reasoning | — | 📋 Planned | `data/benchmarks/superarc.json` |

---

## Per-benchmark detail

### HumanEval — ✅ Run
- **Source:** OpenAI `human-eval` (164 problems, pass@1, sandboxed unit tests). Public.
- **Two layers we measure:** the **raw model** (`eval_humaneval_ouro.py` via in-process `generate()`) and the **whole chat product** (`eval_humaneval_chat.py`, which drives `POST /api/dream/chat/stream` exactly like the browser — provider routing, local-model adapter, loop-reasoner). One extractor + one sandbox shared; never fabricates a score (`humaneval_runner.py` returns `measured:false` if the package is missing).
- **Provider-parametric:** `--provider ollama|anthropic|""` → local↔cloud parity on one execution-grounded mark.
- **Run it:** `python scripts/eval_humaneval_chat.py --provider ollama --limit 10` (server + local model up), `--full` for all 164.
- **Public SOTA (web-validated 2026-07-05, [llm-stats](https://llm-stats.com/benchmarks/humaneval)):** Claude Sonnet 4.5 **97.6%**, DeepSeek R1 **97.4%**; field average across 54 models **89.2%**. **Saturated** — every frontier model clears 90% and the set is in public training mixes, so read our **0.427** as an *absolute-capability* number for a 1.4B model, not a live competitive gap. Use SWE-bench / LiveCodeBench to differentiate the frontier.

### HumanEval (chat product) — layer note
- The full-chat layer (`eval_humaneval_chat.py`) has **no recent full-164 row** — only the raw-model `0.427` is fresh. Running it answers whether provider routing + the loop-reasoner deliver the raw number or lose some of it. This is the top HumanEval gap to fill.

### MBPP — ✅ Run
- **Source:** Mostly-Basic-Python-Problems (Google). We run an exec-and-assert subset (`data/eval/mbpp-basic.jsonl`).
- **Run it:** `python scripts/eval_coding.py --label ouro-fast --model lantern-sigma0-coder`.
- **Public SOTA (web-validated 2026-07-05, [llm-stats](https://llm-stats.com/benchmarks/mbpp-pass@1)):** o4-mini **94.9%** (pass@1); top open-weight Sarvam-30B **92.7%**. Like HumanEval, **saturated** at the frontier — our subset accuracy is an absolute read, not a ranked gap.

### SWE-bench Lite — 🟡 Partial
- **Source:** `princeton-nlp/SWE-bench_Lite` (plain) and `princeton-nlp/SWE-bench_Lite_bm25_13K` (BM25-retrieved `text` prompt). Grading is **execution-graded and delegated to the official `swebench` harness** (Docker or Modal/WSL) — we never report a resolved% we didn't measure.
- **Single-shot vs agentic:** single-shot blind patches score ~0 (Qwen 0/3). The agentic loop (`swe_agent_loop.py`: propose → apply → run repo tests → feed failing test back → retry) closes that seam; `swe_agentic_run.py` runs it live (ollama propose on host, grade one instance in WSL).
- **Run it:** `python scripts/eval_swebench_chat.py --provider ollama --limit 10 --dataset princeton-nlp/SWE-bench_Lite_bm25_13K --grade` (needs Docker). Predict-only without `--grade`, grade later.
- **Next:** pull a real run with a 32k-context model (`LOCAL_CAPABILITY_FIRST=1`) so the 13K BM25 prompt isn't truncated; record the measured resolved% as a leaderboard row.
- **Public SOTA (web-validated 2026-07-05, [SWE-bench Verified leaderboard](https://llm-stats.com/benchmarks/swe-bench-verified) / [steel.dev](https://leaderboard.steel.dev/leaderboards/swe-bench-verified/)):** Claude Mythos 5 **95.5%**, Claude Fable 5 **95.0%**, Claude Opus 4.8 **88.6%** resolved (Verified split; 103 models tracked, field avg ~70%). **This is the *unsaturated*, differentiating coding mark** — and it's exactly the one where we still have **no measured local number**. Closing that empty cell is the single highest-value coding run on the board.

### LongMemEval — ✅ Run
- **Source:** `xiaowu0162/LongMemEval` (`longmemeval_s` / `_m` / `_oracle`). Measures whether the gold evidence turn is retrieved in top-k. We benchmark the canonical Python `MemoryEngine` (`src/csf/memory_engine.py`) in both `keyword` and `multi-signal` modes.
- **Why it exists:** MemOS publishes LongMemEval/PersonaMem numbers (+40% over OpenAI memory) and we had none — so we couldn't honestly claim our retrieval is good.
- **Run it:** `LONGMEMEVAL_PATH=/path/to/longmemeval_s.json python experiments/longmemeval_harness.py --k 5 --limit 200`. Offline self-test (no env var) runs on a baked-in synthetic fixture.
- **First real run (2026-07-01, `longmemeval_s`, 189 scored, k=5):** multi-signal recall@5 **0.709** / MRR **0.486**; keyword recall@5 **0.222** / MRR **0.098** (+0.487 recall for multi-signal). Ledger: `data/longmemeval/runs.jsonl`.
- **Next:** raise multi-signal recall@5 toward MemOS-class numbers.
- **Product-path row (#2111):** `scripts/eval_longmemeval_js.js` scores the **live JS chat retriever** (`csf-memory.js::searchConversation`, keyword, windows the last 1200 turns) — the retriever a real chat turn actually uses, not the Python engine. Measured on `longmemeval_s` (n=500, k=5): **session-level recall@5 0.884 / MRR 0.80**, 0/500 gold outside the window. ⚠️ **Not the same metric as the Python row above** — this is session-level (was any gold-session turn returned in top-k) on the product path, vs the Python engine's turn-level recall; the two are complementary, not comparable. Run: `node scripts/eval_longmemeval_js.js --k 5` (add `--semantic` to also score the nomic-embed rerank when the embeddings service is up).
- **Public SOTA (web-validated 2026-07-05, [mem0 memory-benchmarks](https://mem0.ai/blog/ai-memory-benchmarks-in-2026) / [ByteRover](https://www.byterover.dev/blog/benchmark_ai_agent_memory_real_production_byterover_top_market_accuracy_longmemeval)):** top production memory systems report **end-to-end QA accuracy ~92–94%** on LongMemEval-S (ByteRover 92.8%, EverMemOS-class ~94.4). **Not directly comparable to our 0.709** — theirs is answer *accuracy* on the full 500-item set; ours is retrieval *recall@5* on a 189-item slice. To rank against them, run the full-set end-to-end QA metric (retrieval → answer → grade), not retrieval recall alone.

### HaluEval-QA — 🟡 Partial
- **Source:** `RUCAIBox/HaluEval` (`qa_data.json`) — factual QA where each item ships the gold `knowledge` passage + `right_answer` + a known `hallucinated_answer`. Subset in `data/eval/halueval-qa-subset.jsonl` (n=40).
- **Why it exists:** the ADR-0017 surprise-gated-decoding accept gate — *"the ADR is not Accepted until these numbers exist"* (#1941). It measures whether injecting grounding when a model is uncertain reduces hallucination.
- **A/B (grounding is the intervention's mechanism):** answer each question (A) with NO grounding vs (B) with the gold `knowledge` injected. Deterministic grading (normalized containment of the gold answer — no LLM judge). Run it: `python experiments/halueval_ab.py` (needs egress + `OPENAI_API_KEY`).
- **First real run (GPT-4o-mini, n=40):** hallucination **55% → 20%** with grounding, **64% relative reduction** — clears the ≥20% gate. `data/eval/halueval_ab_results.json`.
- **Honest scope:** this is the *mechanism* with **gold retrieval** (an upper bound). The production controller (`apps/lantern-garage/lib/surprise-intervene.js`) must also *detect* when to ground (surprise gate) and *retrieve* good evidence (CSF/web/tool arms), so its real-world reduction will be lower. **Next:** wire the live controller (`SURPRISE_CANARY=1` vs `SURPRISE_INTERVENE=1`) end-to-end on this set and record the full-controller row.

### SimpleQA-Verified — 📋 Planned
- **Source:** Google DeepMind, [arXiv:2509.07968](https://arxiv.org/abs/2509.07968) (Sept 2025) — a 1,000-prompt cleaned/reconciled subset of OpenAI's SimpleQA (de-duplicated, topic-balanced, label-corrected). Dataset + grader on Kaggle. Public.
- **What it measures:** short-form parametric factuality on **long-tail** facts, scored on two axes — accuracy **and** attempt-rate — combined as F1, so a model is rewarded for hedging ("I don't know") over confabulating. This is the **same honesty axis** as our own golden mark's confabulation-rate, on an externally-owned dataset.
- **Published leaderboard (Table 7, values web-verified 2026-07-05):**

  | Model | Accuracy | Attempted | Hedged | Acc.\|Attempted | **F1** |
  |---|---|---|---|---|---|
  | Gemini 2.5 Pro | 55.3 | 98.9 | 1.1 | 55.9 | **55.6** |
  | GPT-5 | 50.9 | 94.6 | 5.4 | 53.8 | **52.3** |
  | o3 | 51.6 | 99.3 | 0.7 | 52.0 | **51.9** |
  | GPT-4.1 | 39.8 | 99.3 | 0.7 | 40.1 | **39.9** |
  | GPT-4o | 34.4 | 97.0 | 3.0 | 35.5 | **34.9** |
  | DeepSeek R1 | 32.7 | 96.4 | 3.6 | 33.9 | **33.3** |
  | Claude Opus 4 | 19.2 | 35.5 | 64.5 | 54.1 | **28.3** |

- **Relation to our golden mark (why they're complementary, NOT comparable):** our 159-fact golden set is *our own* mark (not in this registry) and tests the honesty axis on **famous** facts + **famous** negatives — easy knowledge, hard honesty. SimpleQA-Verified tests it on **obscure long-tail** facts — hard knowledge. A 0.95 on our set does **not** map to a ~0.55 F1 here; the difficulty distributions are opposite. What transfers is the *metric philosophy*: DeepMind's separate Attempted/Hedged/F1 columns independently validate the split behind our confab-rate-vs-golden-score — **Claude Opus 4 is the clearest case** (19.2% raw accuracy but 54.1% accuracy-given-attempted, because it hedges 64.5% instead of guessing; raw accuracy conflates honesty with knowledge, F1 separates them).
- **To run it (next):** pull the Kaggle dataset, add a `--simpleqa-verified` path to `experiments/sigma0_live_bench.py` with the official F1/attempted/hedged grader (needs an LLM judge for answer-matching), record our model's row here.

### Planned reference targets — 📋
These are public marks tracked in `data/benchmarks/` as capability targets; no harness yet. Promote a row to ✅/🟡 the moment a harness produces a measured result.
- **SWE-bench Verified** — extend `eval_swebench_chat.py --dataset princeton-nlp/SWE-bench_Verified`.
- **PersonaMem** — natural companion to LongMemEval; same MemoryEngine harness shape.
- **ARC-AGI · Humanity's Last Exam · SuperARC · OSWorld** — reasoning/agency frontier marks; see `data/benchmarks/agi-capability-matrix.json`.

---

## How to maintain this list

**This file is a living registry — keep it honest, not aspirational.** When anything below changes, edit the table in the same PR:

1. **New external benchmark gets a harness** → add a row (status 🟡 or ✅), link the harness, name the loop stage it strengthens (Observe/Remember/Reason/Act/Verify/Converge — the [feature gate](../CLAUDE.md)).
2. **A planned mark produces its first measured row** → flip 📋 → 🟡/✅ and paste the evidence (ledger + number).
3. **A new measured run lands** → it goes to the ledger (`leaderboard.jsonl` / `runs.jsonl`), and you refresh the "Latest evidence" cell. Don't put run history here — the ledgers are append-only; this file holds only the *current* headline + a pointer.
4. **Never write a number you didn't measure.** A row with no evidence stays 📋. The CI gate ([eval-leaderboard-gate.yml](../.github/workflows/eval-leaderboard-gate.yml)) already enforces this for the serving path: no serving change ships without a fresh leaderboard row.

Rule of thumb: **if an outside party defines the dataset and the grading, it belongs here.** If we define it, it doesn't.
