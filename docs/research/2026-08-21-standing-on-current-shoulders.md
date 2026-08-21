# Standing on current shoulders — the survey that should have come first

**Date:** 2026-08-21. **Provenance:** live web search, links verified this day. **Trigger:** the
operator's judgment that the robin_llm arc was ungrounded — building first and searching after,
repeatedly. The critique is accepted; this document is the correction, and the build order it
implies is the standing rule: **survey before build, adopt before reimplement.**

## Where the frontier actually is (August 2026)

**1. Robin was already superseded when we rebuilt it.**
[Kosmos](https://edisonscientific.com/news/announcing-kosmos) (Edison Scientific, the FutureHouse
spinout, [arXiv:2511.02824](https://www.alphaxiv.org/abs/2511.02824)) is Robin's successor: a
structured **world model** maintained over hundreds of agent trajectories, ~1,500 papers read and
~42,000 lines of analysis code per run, seven findings in its first phase (three reproduced
unpublished human work), **~79% of results replicating** — described as comparable to early-stage
human research. We rebuilt the May-2025 system while its November-2025 successor was public. That
is the concrete cost of build-first.

**2. The current paradigm for machine-generated improvements is not prose ideas — it is code
evolved against automated evaluators.**
[AlphaEvolve](https://arxiv.org/abs/2506.13131) (DeepMind) and its open lineage —
[OpenEvolve](https://deepwiki.com/codelion/openevolve) (pip-installable; MAP-Elites islands, LLM
ensembles, **cascade evaluation**, artifact feedback), ShinkaEvolve, and
[CodeEvolve](https://arxiv.org/abs/2510.14150) (matches/beats AlphaEvolve on 5/9 of its own
benchmark; beats OpenEvolve/ShinkaEvolve on 6/9) — improve systems by **mutating code and scoring
it with an evaluator function**, not by generating idea prose and judging novelty. The unit of
proposal is a diff; the unit of merit is a measured fitness with controls.

**3. The field measured what our milling measured, first and better.**
[The Ideation-Execution Gap](https://arxiv.org/abs/2506.20803) (Si, Yang, Hashimoto): 43 expert
researchers, 100+ hours each, executing LLM vs expert ideas — the LLM ideas' pre-execution
novelty advantage **disappears and partially flips after execution** (p < 0.05 on all metrics).
Our "30+ milled, zero novel" is a small local replication of a published result. It did not need
rediscovering.

**4. Paper-shaped automation is a solved-enough commodity.**
[AI Scientist-v2](https://arxiv.org/abs/2504.08066) (first fully AI-generated workshop-accepted
paper; agentic tree search, no human templates) and
[freephdlabor](https://github.com/ltjed/freephdlabor) (smolagents-based, wraps AI-Scientist-v2 as
a tool) are maintained open frameworks. A bespoke idea-pipeline is a liability, not an asset.

**5. Ideation, if ever needed again, has an evidence-grounded current form:**
[ResearchStudio-Idea](https://arxiv.org/pdf/2607.04439) trains ideation against ML conference
*outcomes* — grounded in what actually got accepted/executed, which is exactly the grounding
prose-milling lacked.

## Decisions

| Piece | Decision | Why |
|---|---|---|
| bench.js / gapmill prose-idea milling | **RETIRE as a novelty path.** Keep as the recorded negative result | The field already published the same finding (Ideation-Execution Gap); continuing is re-measuring it |
| novelty.js audit | **Reposition: prior-art attacher, never judge** | RINoBench field-best is 0.172 macro-F1 — nobody can judge novelty; attaching citations to proposals remains useful coverage |
| assays.js + noise floors + null controls | **KEEP — this is the valuable part** | Evaluator functions with pre-registered controls are precisely what the Evolve paradigm consumes |
| priorwork.js notebook index | **KEEP** | Nothing external can read our lab; this stays unique and cheap |
| Bespoke robin pipeline (pipeline.js) | **FREEZE** | Superseded by maintained frameworks (AI-Scientist-v2 et al.) |
| Next build | **Pilot OpenEvolve on our own controller** | The current-frontier form of the "self-improvement experiment": evolve `controller.py` policy code with fitness = discovery-benchmark per-experiment rate, hard constraint = null-world zero + world-H control. Our assays already expose EC_* knobs and JSON verdicts — they are drop-in evaluators |
| Prospective market logging | **UNCHANGED** | Grounded, cheap, proprietary; unaffected by this survey |

## The standing rule this encodes

Before any new harness: one hour of live search for the current system-of-record, written into
this directory with links, and an explicit adopt-vs-build call. `priorwork.js` indexes this file;
the next session inherits the rule and the map.
