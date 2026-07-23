# Grounding ledger + cross-domain patent landscape (full-text verified)

**Date:** 2026-07-22 · **Method:** two background workflows — (1) full-text fetch + strict
verification of every cited paper/patent against the real source (40 agents), (2) cross-domain
patent discovery through 12 domain lenses → 70 candidates → 20 deep-read (32 agents). This closes
the "grounded on search snippets, not the papers" gap flagged earlier.

## Part 1 — Citation verification: **33 / 40 hold, 7 partial, 0 wrong, 0 unreachable**

Every source was reachable and none was fabricated. Seven citations were **overstated** in the
design docs and are corrected below (fixes applied in the same commit).

| Source | Verdict | Correction applied |
|---|---|---|
| **2407.18418** (abstention survey) | partial | **Real error.** The paper does **not** say "DPO drops OOD" — it attributes OOD-generalization failure to abstention-aware *instruction-tuning generally* (Feng et al.). **CPO/ORPO are not in the paper at all.** Both sub-claims removed; kept the two that hold (SFT over-abstains; pretraining refusal-data understudied). |
| **2602.06948** (agentic overconfidence) | partial | **Real error.** The paper does **not** study or claim "RLHF degrades calibration." Its finding is about assessment *framing* (adversarial bug-finding reframing improves calibration). RLHF clause dropped; cite instead its real numbers: **73% predicted vs 35% actual confidence; overconfidence gap up to +0.55 (Gemini); AUROC 0.51–0.64**. |
| **2511.21437** (model-merging survey) | partial | **Real error.** This survey does **not** study DARE. Its six methods: Task Arithmetic, TIES, Model Stock, TSV-Merge, Iso-C, Subspace Boosting. Only **Task Arithmetic** is reliably net-positive (peak **+1.02% at n=12**); subspace methods often *degrade* (down to −5.36%). DARE citation moved to its own paper (2311.03099, which holds). |
| **2601.04170** (agent drift) | partial | Numbers **confirmed** (−42% success = 36.7pp absolute; 3.2× interventions; >81% is the *combined* mitigation only). But the "classical ML monitoring insufficient" clause was **not in the paper** — removed. |
| **2507.06261** (Gemini 2.5) | partial | Thinking-budget range is **128–32768 (Pro) / 0–24576 (Flash)**, not "1024–32768"; "monotonic" softened to "generally improves." |
| **2511.11500** (Reinforced Hesitation) | partial | Ternary reward +1/0/−λ + Pareto-over-λ + post-training RL all **confirmed**. But it trains on **Knights & Knaves** (80k/10k), not GSM8K/MedQA/GPQA (those were frontier-model *probes*). New citable fact: **frontier models essentially never abstain even under heavy penalty** (MedQA: zero abstention across 11 models × 5 λ) — strong motivation; RH cascading hits **88.1% at 2.2 avg queries**. |
| **2606.18206** (Fixed-Point Reasoners) | partial | Convergence is to **a single fixed point of the looped shared block**, not "per-layer fixed points." Beats HRM/TRM at 7M params (Sudoku-Extreme +19.5pt); ARC-2 the lone loss. |

**The two load-bearing citations held exactly:**
- **2606.02628** (white-box probe) — **confirmed**: linear AUROC **0.904–1.000** on 4-bit NF4 7–8B, sampling detectors **≤0.541**, mid-late band, ~linear (one nuance: MLP gap is *exactly* ≤0.010, not strictly <0.01). The spine of v1.10 is solid.
- **2510.09033** (recall-not-truth) — **confirmed**: associated-hallucination detection is **near-random black-box (0.48–0.49)** and only weak white-box (**0.57–0.69**), vs UH **0.81–0.93**. *Scope note:* their "AH" = spurious Wikidata-triple associations on 8B models; our probe-ladder `assoc` set = common misconceptions and scored 0.924 at 7B — **different constructs**, so our result does not overturn theirs; both are cited honestly.

## Part 2 — Fresh source (this week): **SEA — Self-Evolving Agents with Anytime-Valid Certificates**
[arXiv:2607.00871](https://arxiv.org/abs/2607.00871) (submitted **2026-07-01**). Four-layer stack
around a **frozen base LLM** (no weight fine-tuning): L1 steering adapter (logit-level REINFORCE
over a PAC-Bayes posterior, frozen prior), L2 mutable harness (prompts/tools/budgets), L3 loop
controllers applying **anytime-valid statistical gates**. It is an unusually tight independent
match for the convergence-engine thesis: **persistent improvement without weight modification,
gated by verified (anytime-valid) certificates** — exactly CLAUDE.md's "learn via memory+retrieval,
not retraining" + the Verify gate. Adopt its **anytime-valid certificate** as the statistical form
of the M1/M6 stopping test (a certificate that stays valid under indefinite/optional stopping —
precisely what an indefinite-horizon spiral needs).

## Part 3 — Cross-domain patent landscape (20 deep-read; **16 inspiration, 2 adjacent, 0 FTO risk**)

Every match is **cross-domain** (non-AI) and **FTO-clear** — none reads on an LLM proposer/verifier
loop, and the spiral's novelty is precisely the **exec/evidence verifier gate** they all lack. The
value is *inspiration*: decades-fielded control-theory precedent for the Σ₀ math.

### Iterative Learning Control ≡ M4 (contraction / fixed-point halting) — the strongest theme
- **US7345448B2** (Electro Scientific, laser galvo, 2004) · **US8094405B1** (Marvell disk-drive RRO servo, 2007) · **US6686716B1** (Exelis/Purdue motor, 2001) · **CN111510020B** (2020). ILC converges by feeding the **measured error** back through the plant to refine the *input*, not by retuning the plant — the servo analogue of "store experience + refine, don't retrain weights." **Its convergence guarantee requires the error operator be contractive (spectral radius < 1)** — a 40-year-fielded justification for M4's Kreiss/contraction halting: *each escalation must strictly reduce residual or halt, else refinement diverges.* US6686716B1 goes further — it feeds the error back to **re-parameterize the cheap tier itself** (= our VTD flywheel).

### Statistical-stall halting ≡ M4
- **US6518892B2** (Broadcom iterative decoder, 2000): halt when a **cheap hash of the state repeats** (fixed point). **US8301987B2** (Western Digital ECC, 2009): halt on **N consecutive zero-discrepancy** steps. Teaching: don't run a fixed iteration budget — halt on a cheap statistical stall signal (directly implementable as the spiral's turn-cap replacement).

### Escalation contract ≡ Act cascade + M5
- **US6013436A** (Visible Genetics hierarchical medical assay, 1994): run the **cheapest test on all samples; a positive terminates immediately; only a negative escalates** to the costlier assay — a clean, ground-truth escalation contract. **US7254641B2** (Intervoice, 2001): **bidirectional** tier movement — adds a *de-escalation* direction to M5 (drop back to the cheap tier when load/uncertainty falls). **US20120243734A1** (HP, 2009): **decouple the gate decision from the confidence estimate** — aggregate stage responses into one calibrated probability instead of inferring confidence from where it rejected (a concrete M1 refinement).

### Re-grounding / surrogate discipline ≡ M2
- **US8131656B2** (UIUC evolutionary-computation surrogate fitness, 2006): a cheap surrogate evaluator is **trusted only because it is periodically re-fit against real evaluations** — the disciplined form of M2's "when may I substitute the cheap check for the expensive one?" (leash the cheap tier to periodic ground-truth).

### Calibrated abstain & the learned-gate contrast ≡ M1
- **US9715723B2** (Applied Materials, 2012): a fielded **calibrated-abstain boundary** — explicitly refuses to treat uncertain as certain. **US12135927B2** (IBM, 2020) is the instructive *contrast*: it patents a **learned-imitation gate** (train an ML model to copy an expert's accept/reject) — the spiral deliberately does the **opposite** (a deterministic exec/evidence verifier with ground-truth outcomes), which is both its novelty and its FTO safety.

### Verify-then-refine ≡ Verify → Converge
- **US20100094676A1** (Bowe Bell + Howell, 2008): **measure whether a corrective action actually restored the target metric before closing the loop**, and refine the remediation playbook from the outcome — structurally identical to the Fix-Rate ratchet.

**Landscape conclusion.** The spiral's *mechanisms* are deeply precedented in control theory,
reliability engineering, and operations research (which is reassuring — the Σ₀ math is standing on
fielded ground), but **no patent gates an LLM proposer with a ground-truth exec/evidence verifier**,
and none combines the M1–M6 control law. FTO is clean; the owned contribution is the *composition*
applied to a reasoning loop — consistent with "the moat is the system."
