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
- [`data/eval/leaderboard.jsonl`](../data/eval/leaderboard.jsonl) — one row per coding/serving run (`pass@1` / `accuracy`). CI-gated: see [eval-leaderboard-gate.yml](../.github/workflows/eval-leaderboard-gate.yml).
- [`data/longmemeval/runs.jsonl`](../data/longmemeval/runs.jsonl) — one row per memory-retrieval run (`recall@k` / `MRR`).
- `data/eval/swebench/<label>-<ts>.jsonl` — SWE-bench predictions in official format (grade later).

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
| **HumanEval** | Act / Reason | Code pass@1 (164 problems) | `scripts/eval_humaneval_chat.py`, `scripts/eval_humaneval_ouro.py`, `experiments/humaneval_runner.py` | ✅ Run | Ouro full-164 pass@1 **0.427**; Qwen-base+Σ₀ subset **0.75** — `leaderboard.jsonl` |
| **MBPP** (basic subset) | Act | Exec-graded function synthesis | `scripts/eval_coding.py` (+ `data/eval/mbpp-basic.jsonl`) | ✅ Run | `leaderboard.jsonl` / `data/eval/mbpp-basic.jsonl` |
| **SWE-bench Lite** | Act / Verify | Real-repo issue → patch, resolved% (official Docker/Modal grader) | `scripts/eval_swebench_chat.py`, `scripts/swe_agent_loop.py`, `scripts/swe_agentic_run.py` | 🟡 Partial | Qwen single-shot **0/3** (2 applied-but-wrong); agentic propose→test→retry loop landed |
| **LongMemEval** | Remember | Memory retrieval recall@k / MRR over long multi-session histories | `experiments/longmemeval_harness.py` | 🟡 Partial | Synthetic fixture only (recall@5 1.0); real `longmemeval_s.json` not yet pulled — `data/longmemeval/runs.jsonl` |
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

### MBPP — ✅ Run
- **Source:** Mostly-Basic-Python-Problems (Google). We run an exec-and-assert subset (`data/eval/mbpp-basic.jsonl`).
- **Run it:** `python scripts/eval_coding.py --label ouro-fast --model lantern-sigma0-coder`.

### SWE-bench Lite — 🟡 Partial
- **Source:** `princeton-nlp/SWE-bench_Lite` (plain) and `princeton-nlp/SWE-bench_Lite_bm25_13K` (BM25-retrieved `text` prompt). Grading is **execution-graded and delegated to the official `swebench` harness** (Docker or Modal/WSL) — we never report a resolved% we didn't measure.
- **Single-shot vs agentic:** single-shot blind patches score ~0 (Qwen 0/3). The agentic loop (`swe_agent_loop.py`: propose → apply → run repo tests → feed failing test back → retry) closes that seam; `swe_agentic_run.py` runs it live (ollama propose on host, grade one instance in WSL).
- **Run it:** `python scripts/eval_swebench_chat.py --provider ollama --limit 10 --dataset princeton-nlp/SWE-bench_Lite_bm25_13K --grade` (needs Docker). Predict-only without `--grade`, grade later.
- **Next:** pull a real run with a 32k-context model (`LOCAL_CAPABILITY_FIRST=1`) so the 13K BM25 prompt isn't truncated; record the measured resolved% as a leaderboard row.

### LongMemEval — 🟡 Partial
- **Source:** `xiaowu0162/LongMemEval` (`longmemeval_s` / `_m` / `_oracle`). Measures whether the gold evidence turn is retrieved in top-k. We benchmark the canonical Python `MemoryEngine` (`src/csf/memory_engine.py`) in both `keyword` and `multi-signal` modes.
- **Why it exists:** MemOS publishes LongMemEval/PersonaMem numbers (+40% over OpenAI memory) and we had none — so we couldn't honestly claim our retrieval is good.
- **Run it:** `LONGMEMEVAL_PATH=/path/to/longmemeval_s.json python experiments/longmemeval_harness.py --k 5 --limit 200`. Offline self-test runs on a baked-in synthetic fixture (current state).
- **Next:** download the real `longmemeval_s.json`, run it, and record the first real recall@k row. The live JS chat path (nomic-embed rerank) is a *separate* measurement still to be wired.

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
