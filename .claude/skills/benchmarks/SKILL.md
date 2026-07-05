---
name: benchmarks
description: Review past benchmark runs and plan the next ones for the local model (Ouro / Σ₀ coder) — per-benchmark leaderboard tables placing the local stack against web-validated public SOTA on HumanEval, MBPP, SWE-bench, LongMemEval and honesty/HaluEval evals, plus a prioritized "run next" plan. Use whenever the user types `/benchmarks` or `!benchmarks`, or asks to "check the benchmarks", "how's the local model doing on evals", "plan the next benchmark runs", "where do we stand on HumanEval/SWE-bench/HaluEval", "compare Ouro to the council", "what should we benchmark next", or "benchmark the local model". Trigger even when the user names only one benchmark (e.g. "check our SWE-bench number") — reviewing one mark in the context of the whole ledger is this skill. Do NOT use it to grade the whole app (that's report-card), to review a PR diff (that's code-review), or to actually train/serve a model.
---

# Benchmarks

The user wants to know **where the local model actually stands on hard, externally-owned marks — and what to measure next.** Not a vibe, not a roadmap for the whole app: a grounded reading of the eval ledger, a scorecard against the Σ₀ council and the current public state of the art, and a prioritized plan for the next runs.

This is a Σ₀ artifact. The North Star is blunt about it: *external reality beats internal consistency*, and **`docs/BENCHMARKS.md` only counts marks owned by outside parties with fixed public datasets.** So the whole job is: read the real numbers from the ledgers, never launder a hope into a figure, and let the gaps show. A benchmark review that grades from memory is worse than none — it prints confidence the evidence doesn't support.

By default this skill **reports and plans — it does not launch heavy runs.** The eval harnesses are slow (a full 164-problem HumanEval on native Ouro was ~3.7 wall-hours) and some need a GPU venv, Docker, or an OpenAI key. Read the ledgers, produce the scorecard and plan, and only run a harness when the user explicitly asks (see *Running a benchmark* below).

## The two questions this answers

1. **Where do we stand?** — the measured pass-rate / accuracy / recall of the local model on each mark, read from the append-only ledgers, next to (a) the Σ₀ council's verify-face where it applies and (b) the *current public* SOTA for the same benchmark.
2. **What next?** — a short, ranked list of the runs worth doing, each with the exact command, why it's worth the wall-clock, and what a good result would look like.

## Read the suite as one loop — not N isolated contests

Both questions above are per-benchmark, but the benchmarks are **not** a scoreboard of independent games. Each one probes a single stage of the North Star loop, so the suite is really *per-stage instrumentation of one system*. Always read it that way first, then drill into the individual tables — because the most important findings only exist *across* benchmarks, never inside one:

| Loop stage | Benchmark(s) | Differentiating? |
|---|---|---|
| Remember | LongMemEval | yes (end-to-end QA) |
| Reason | ARC-AGI, HLE (planned) | yes |
| Act | HumanEval, MBPP | **no — saturated** |
| Act + Verify | **SWE-bench** | **yes — the real agentic mark** |
| Verify | HaluEval, SimpleQA-Verified, epistemic, council | mixed |

Three things this holistic read buys you that a stack of individual numbers cannot — treat all three as *required* parts of every output, not extras:

- **Comparability — group rows by model snapshot.** A number is only meaningful attached to *which checkpoint produced it*. Before comparing anything, group the ledger rows by their `{base_model, adapter/label, ts}` and **flag when marks come from different snapshots** (e.g. HumanEval from `ck600` on one date, honesty from `he20` on another are *different models* — any cross-benchmark statement about "the local model" is then unsound). Say so explicitly rather than implying one coherent model.
- **The tradeoff surface — name cross-benchmark interactions.** The single highest-value observation is usually a *trade*, not a level: e.g. the honesty adapter (`he20`) lifting epistemic labeling while **regressing** HumanEval to 0.25 vs the `ck600` 0.427 peak. That's one finding spanning two marks — invisible if you report coding and honesty on separate days as two green checks. Hunt for these and state them plainly: "checkpoint X buys stage A at the cost of stage B."
- **A whole-loop verdict, not an average.** Close with one honest line on whether the loop is getting *stronger as a whole* or just shuffling capability between stages. Weight the **unsaturated, differentiating** marks (SWE-bench, LongMemEval end-to-end, honesty F1) heavily; treat the **saturated** ones (HumanEval, MBPP) as regression tripwires, not differentiators. A checkpoint is only "better" if it improves something and regresses **no** stage below its floor — a matrix gate, which is exactly the Σ₀ anti-collapse discipline (don't optimize one axis while silently degrading another).

## Read the ledgers first (source of truth)

Every number must come from a file you actually open this session. The ledgers are append-only JSONL / JSON under `data/eval/` and `data/longmemeval/`. Read the tail of each — the newest rows are the current state.

| Mark | Ledger (read this) | Key fields |
|---|---|---|
| **HumanEval** (raw Ouro + full chat) | `data/eval/leaderboard.jsonl` (rows where `benchmark == "humaneval"`) | `pass@1`, `n`, `subset`, `label`, `engine`, `base_model`, `wall_s`, `failure_breakdown` |
| **MBPP / coding-golden** | `data/eval/leaderboard.jsonl` (rows with `accuracy`, `model`) + `data/eval/runs/<label>-<ts>.jsonl` | `accuracy`, `n`, `model`, `avg_latency_s`, `tok_per_s` |
| **SWE-bench Lite** | `data/eval/swebench/<label>-<ts>.jsonl` (predictions) + `.detail.jsonl`; graded rows land in `leaderboard.jsonl` | `resolved`, patch size, `source`/`model` histogram |
| **LongMemEval** | `data/longmemeval/runs.jsonl` | `modes.{keyword,multi}.recall_at_k`, `mrr`, `multi_minus_keyword_recall`, `source` |
| **HaluEval / honesty (gated grounding)** | `data/eval/halueval_gated_results.json`, `halueval_ab_results.json` | gate AUROC, budget frontier, % gain captured |
| **Epistemic (PROVEN/MEASURED/HEURISTIC labeling)** | `data/eval/epistemic/*.jsonl`, `data/eval/halueval-local/*.jsonl` | gold vs predicted label, accuracy |
| **Σ₀ council** | `data/convergence/council-reviews.jsonl`, `canary-events.jsonl` | Δ, answerability verdict, canary scores |

Two things to watch, because they're the usual way a benchmark read goes wrong here:

- **Distinguish `subset` from full.** A `pass@1` on `--limit 20` is not the headline number. A row with `subset: true` or small `n` is a smoke test — label it as such in the scorecard and don't compare it to a frontier full-164 figure as if they're peers.
- **Distinguish the raw model from the chat product.** HumanEval is measured at two layers (`scripts/eval_humaneval_ouro.py` = raw Ouro; `scripts/eval_humaneval_chat.py` = the full chat with routing). They answer different questions ("is the model capable" vs "does the product deliver it"). Keep them as separate rows — collapsing them hides where a gap actually lives.

If a mark has **no recent row**, that's a finding, not a blank. Say "no HumanEval run since <ts of newest row>" — a stale or absent number is exactly the thing the plan should fix.

## Ground each mark against the current public SOTA

A local `pass@1: 0.427` in isolation answers "is this good in the abstract." It doesn't answer the question the user has: *are we ahead or behind, right now, against what else exists.* Close that with a live `WebSearch` per headline mark before finalizing — same *external reality* rule, pointed outward.

- **HumanEval / MBPP** → pull the current public leaderboard figure so the local pass@1 sits next to what frontier and top open-weight models score *today*, not a training-cutoff memory.
- **SWE-bench** → search the current SWE-bench Lite / Verified leaderboard; the gap here is large and expected for a 1.4B local model — state it plainly.
- **Honesty / HaluEval** → search for comparable hallucination-detection / grounding numbers; the internal note is that token-logprob AUROC (~0.77) is a mediocre signal vs internal-state probes (~0.99) — confirm whether that still holds.

Rules, non-negotiable (they mirror the report-card contract):
- **Never state a competitor's current benchmark score from memory.** These leaderboards move monthly; a stale figure stated as current is worse than none. If a search is thin, say "couldn't confirm a current number — treating as unverified."
- **Losing the comparison is fine and usually true.** A solo local 1.4B stack being far behind frontier SWE-bench is expected, not damning. The dishonest move is hiding the gap.

## The council is a different axis — don't force it into a pass-rate

The Σ₀ council (`lib/council-review.js`, `lib/exec-verify.js`) is not a benchmark with a public dataset; it's the verify-face — Δ (disagreement), the answerability gate (grounded / refuted / seam_open / pin), and the canaries. Compare it to the marks the *right* way: the council's job is to catch the model when it's wrong, so the useful reading is **"on the problems Ouro failed, did exec-verify / the council flag them?"** — verification recall, not another pass@1. Where the council audit trail (`council-reviews.jsonl`) has the labels to support that, report it; where it doesn't (the escalation backtest is currently blocked on sparse outcome labels), say so rather than inventing a council score.

## Output format — one leaderboard table PER benchmark

The deliverable the user wants is a set of **head-to-head leaderboard tables, one per benchmark**, each ranked with real models and providers so the local model's number sits *in the field*, not in isolation. This is how the public leaderboards (llm-stats, codesota, swebench.com) present results, and it's what makes the comparison legible at a glance. Do **not** collapse everything into one giant matrix — separate tables keep each benchmark's units, saturation state, and caveats distinct.

Produce this shape:

1. **One or two framing sentences** — that this is a grounded read of our ledgers as of this session (cite the newest row age), with competitor rows web-validated live (cite the "as of" recency), plus a plan. Not a full audit. **Name the snapshot(s):** if the marks come from different checkpoints/dates, say so here so nothing downstream implies one coherent model.

2. **A per-stage capability line (the holistic read, first).** Before the individual tables, give a one-glance summary of the loop as a whole: for each loop stage, the local mark's standing expressed as *fraction of / distance from* the live public SOTA (so a saturated 42.7% HumanEval and an unsaturated 0/1 SWE-bench are on the same "share of frontier" scale), and a `▲/▼/→` vs the previous snapshot where the ledger has one. This is the capability vector — it's what makes "is the loop stronger as a whole" answerable at a glance. Follow it immediately with any **cross-benchmark tradeoff** you found (e.g. "he20 buys epistemic labeling, regresses HumanEval 0.427→0.25").

3. **A ranked table for each benchmark** you have a local number (or a MISSING gap) for. Columns:

   `Rank | Model | Provider | <Score metric> | As of | Source`

   - **Rank** orders by score; mark the local row with `▸` (and bold) so the eye finds it instantly. Rank it honestly — a 1.4B model lands low on saturated coding marks, and that's the true picture.
   - **Model / Provider** name the system and who ships it (`Claude Sonnet 4.5 / Anthropic`, `DeepSeek R1 / DeepSeek (OSS)`, `Ouro-1.4B + adapter / local (Σ₀)`). The user asked specifically for "models and providers" — providers are a required column, not optional.
   - **Score** in the benchmark's own units with `n`/subset where relevant (`42.7% pass@1 (full 164, ck600)`). Never round a recollection; local scores trace to a ledger file, competitor scores to a live search.
   - **As of** stamps recency — a leaderboard figure without a date is a stale claim waiting to happen; frontier numbers move monthly.
   - **Source** links the live leaderboard URL for competitors and the `data/eval/...` file for local rows.

   Add a field-average or "top-5 cluster" row where the public leaderboard reports one — it calibrates "good" without cherry-picking a single rival.

4. **A one-line caveat under each table** where the benchmark demands it — not decoration, it's the honesty that stops the table from lying:
   - **Saturation** — HumanEval / MBPP are saturated (frontier all >90%, in training mixes). Say so; note the local number is an absolute-capability read, not a live gap. Point to SWE-bench / LiveCodeBench as the differentiating marks.
   - **Not apples-to-apples** — closed-book local vs retrieval-grounded council; recall@k on a slice vs end-to-end QA accuracy on the full set. Name the mismatch rather than ranking across it silently.
   - **No official leaderboard / weak metric** — HaluEval has no live leaderboard and a length-only classifier scores ~93% on it; flag it and cross-check TruthfulQA.
   - **MISSING / STALE** — an empty cell is a finding. "No graded row, never run" is often the most action-guiding line on the card.

5. **The plan — a ranked "Run next" list.** 3–6 items, most valuable first. Each: the mark, the **exact command**, why it's worth the wall-clock, rough cost (wall-time / needs-GPU / needs-Docker / needs-key), and what a good result looks like. Rank by *information gained per hour* — a cheap run that fills a MISSING cell beats re-running a fresh one. A `▸` local row reading "no measured number" should map to a run-next item. When a snapshot mismatch or a cross-benchmark tradeoff surfaced in step 2, the run that *resolves the ambiguity* (e.g. "confirm which checkpoint is actually served") usually outranks any new mark — a number you can't trust the provenance of is worth less than knowing which model you're even measuring.

6. **A one-line whole-loop verdict** — is the loop stronger *as a system* since the last snapshot, or is capability just moving between stages? This is the sentence the owner remembers; make it the honest synthesis of the capability line, not a re-list of scores.

7. **Update `docs/BENCHMARKS.md`** — reflect newly-read state and validated competitor context into the registry, per the CLAUDE.md rule that the registry moves in the same change as the result. Keep its structure; add/update rows, don't rewrite. If nothing measured changed, stamp a review date rather than churning the file. (If the user asked for chat-only output, skip this and say so.)

### Web-validate every competitor row (non-negotiable)

The competitor and SOTA rows are worthless — worse, misleading — if guessed from memory, because these leaderboards move every month. Before finalizing, run a live `WebSearch` per benchmark against the current public leaderboards (llm-stats.com, codesota.com, swebench.com, evalplus, mem0/byterover for memory, hallucination-leaderboards for honesty) and cite what you actually opened, with its date. If a search is thin, write "unverified — thin search" rather than filling the cell with a remembered number. This is the same *external reality beats internal consistency* rule the North Star imposes on us, applied to the rivals just as strictly.

### Example (abbreviated — one benchmark's table)

```
Grounded read of our ledgers, with competitor rows web-validated live (llm-stats,
as of Jul 2026). ⚠️ Snapshot mismatch: HumanEval is from ck600 (Jun 26); honesty is
from he20 (Jul 5) — different models, so "the local model" below is not one thing.

### Capability across the loop (share of live SOTA; ▲▼ vs last snapshot)
| Stage | Mark | Local | SOTA | Share | Trend |
|---|---|---|---|---|---|
| Remember | LongMemEval | 0.709 r@5 | ~0.93 QA | ~0.76* | → |
| Act | HumanEval | 42.7% | 97.6% | 0.44 | ▼ (he20 0.25) |
| Act+Verify | SWE-bench | none | 95.5% | 0.00 | — MISSING |
| Verify | HaluEval | 0.60 hall | 0.20 | behind | → |
*not apples-to-apples (recall vs QA acc). **Tradeoff:** he20 buys epistemic
labeling but regresses HumanEval 0.427→0.25 — capability moved, didn't grow.

## HumanEval — pass@1 (code synthesis, 164 problems)

| Rank | Model | Provider | pass@1 | As of | Source |
|---|---|---|---|---|---|
| 1 | Claude Sonnet 4.5 | Anthropic | 97.6% | Jul 2026 | llm-stats.com/benchmarks/humaneval |
| 2 | DeepSeek R1 | DeepSeek (OSS) | 97.4% | Jul 2026 | llm-stats.com/benchmarks/humaneval |
| — | field average (54 models) | — | 89.2% | Jul 2026 | llm-stats.com/benchmarks/humaneval |
| ▸ | Ouro-1.4B + adapter | local (Σ₀) | 42.7% (full 164, ck600) | Jun 2026 | data/eval/leaderboard.jsonl |

⚠️ Saturated benchmark — frontier all >90%, in training mixes; treat local 42.7%
as absolute capability, not a live gap. SWE-bench is the differentiating coding mark.

## SWE-bench Verified — % resolved

| Rank | Model | Provider | Resolved | As of | Source |
|---|---|---|---|---|---|
| 1 | Claude Mythos 5 | Anthropic | 95.5% | Jul 2026 | llm-stats.com/benchmarks/swe-bench-verified |
| 3 | Claude Opus 4.8 | Anthropic | 88.6% | Jul 2026 | leaderboard.steel.dev |
| ▸ | Ouro / local coder | local (Σ₀) | no measured number (0/3 probe) | — | empty data/eval/swebench/ |

⚠️ MISSING — harness built, never graded. Highest-value gap on the board.

**Run next**
1. SWE-bench Lite graded (`LOCAL_CAPABILITY_FIRST=1 python scripts/eval_swebench_chat.py
   --limit 20 --grade`) — first real resolved-rate; needs Docker/WSL2 + 32k-ctx model.
   Good result: any nonzero resolved.
2. HumanEval chat layer (`python scripts/eval_humaneval_chat.py --provider ollama --full`)
   — fills the MISSING chat-product cell; does routing deliver the raw 42.7%? Hours, local.
```

## Running a benchmark (only when asked)

If the user says "run it" / "kick off HumanEval" / "get me a fresh number," then execute the harness — but honor the Σ₀ contract: **say "done" only after the run finishes and a row lands in the ledger, and cite that row.** Do not report a projected or partial number as the result.

Invocation reference (all paths from repo root):

| Mark | Command | Notes |
|---|---|---|
| HumanEval raw (Ouro) | `.venv-train/Scripts/python scripts/eval_humaneval_ouro.py --limit 20` (or `--full`) | Needs GPU venv + Ouro weights; slow |
| HumanEval chat | `python scripts/eval_humaneval_chat.py --provider ollama --limit 10` (`--full`, `--selftest`) | `--selftest` runs offline; `--provider anthropic` for cloud parity; needs `ouro_serve.py` for `ollama` |
| MBPP / coding | `python scripts/eval_coding.py --label ouro-fast --model lantern-sigma0-coder` | `--engine http\|loop`, `--base http://127.0.0.1:11434` |
| SWE-bench chat | `python scripts/eval_swebench_chat.py --provider ollama --limit 10 --grade` | `--grade` needs the official swebench Docker/Modal harness; BM25 13K dataset exceeds Ouro's 8k ctx — use a 32k-ctx model (`LOCAL_CAPABILITY_FIRST=1`) for a fair run |
| SWE agent loop (offline) | `python scripts/swe_agent_loop.py --selftest` | Smoke test, no Docker |
| LongMemEval | `LONGMEMEVAL_PATH=/path/to/longmemeval_s.json python experiments/longmemeval_harness.py --k 5` | Runs offline-synthetic with no path set |
| HaluEval gated | `python experiments/halueval_gated.py` | Needs `OPENAI_API_KEY` (GPT-4o-mini oracle) |

To serve the local model first: `.venv-train/Scripts/python scripts/ouro_serve.py` (speaks the Ollama API on `:11434`; env `OURO_MODEL`, `OURO_NATIVE`, `OURO_KV_INT8`, etc. — see the script). Before touching a serving-path file, remember the CI gate (`eval-leaderboard-gate.yml`) fails any change to `scripts/ouro_serve.py` / `src/serving/**` that doesn't add a leaderboard row.

## Tone

Write like a research engineer giving a straight status read to someone who owns the project. Precise about the numbers, honest about the staleness and the gaps, calm about being behind the frontier where that's the expected truth. The value is a reading the user can trust and act on — cite the row, name the gap, point at the next run.
