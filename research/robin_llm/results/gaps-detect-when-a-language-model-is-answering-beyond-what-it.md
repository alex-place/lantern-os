# Bench list — detect when a language model is answering beyond what it knows, from its own activations, cheaply enough to run on every token in production

**NOTHING HERE HAS BEEN RUN.** These are ranked proposals, not results. The ranking is a Bradley-Terry-Luce fit over 6 pairwise judgements; it says which ideas an LLM judge preferred given the retrieved literature, and nothing about whether they work.

**Sham control held.** An inert proposal was ranked in disguise alongside these and placed 3 of 4, so the ranking is not simply rewarding plausible prose.

Corpus: 40 papers retrieved, 10 most relevant + 8 most recent shown to the generator. 0 of 2 ideas below retrieved no supporting paper. Generated 2026-08-20.

---

## 1. Null-World Activation Divergence for Per-Token Hallucination

**Cost:** low · **BTL strength** 0.5876 (3/3 pairwise wins)

**Prior art: INCREMENTAL** — `research\epistemic_controller\run_mvp.py`. Prior work runs epistemic controller with null-world gating but does not directly compare per-token activations for hallucination detection.

**Mechanism.** Compare activations on input vs. null-world variants gated by epistemic controller to detect divergence indicating hallucination

**Run this.** Run per-token activation distance metrics between real and null-world inputs across production tokens

**Kills it.** No significant activation divergence correlates with hallucination events

**Needs from you.** production logs, null-world generator, compute for activation extraction

**Retrieved:** `2608.15940`, `2608.18597`, `2607.06601`, `2509.03531`, `2605.26647`, `2608.04066`, `2606.29441`, `2604.15400`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Null-World Activation Divergence aims to detect hallucination by comparing model activations on the actual input versus a "null-world" variant—an input stripped of meaningful content. The idea is that when the model hallucinates, its internal activations diverge significantly from those on null inputs, signaling overconfident generation beyond knowledge. An epistemic controller gates this divergence signal to flag hallucination per token, enabling cheap, real-time detection without external verification.

**EVIDENCE:**  
None of the retrieved papers directly validate this exact mechanism. [1] discusses null tokens as abstention signals in ASR/NMT but not activation divergence. [7] evaluates activation-based defenses but finds mixed results and structural challenges. [8] shows hallucination as trajectory commitment, suggesting internal dynamics matter but does not test null-world comparisons. Other papers focus on related but distinct mechanisms (e.g., gating, routing, or self-verification [6]). Thus, direct empirical support for null-world activation divergence as a cheap per-token hallucination detector is lacking.

**WHAT WOULD FALSIFY IT:**  
If activation patterns on null-world inputs do not reliably diverge from those on hallucinated tokens, or if divergence occurs equally on truthful tokens, the method fails. Also, if gating by the epistemic controller cannot separate hallucination from normal uncertainty, the approach is invalidated.

**RISK:**  
Optimizing for activation divergence detection might encourage the model to suppress genuine uncertainty signals or produce conservative outputs that reduce divergence but degrade factuality or informativeness, thus improving detection metrics while worsening real-world reliability.

</details>

## 2. Live Prediction Market Disagreement as Internal Activation Signal

**Cost:** medium · **BTL strength** 0.2702 (2/3 pairwise wins)

**Prior art: UNVERIFIED**. No prior work or papers explicitly correlate live prediction market disagreement with internal activations for epistemic uncertainty per token. arXiv, OpenAlex and OpenReview were searched (81 hits) and none matched.

**Mechanism.** Correlate internal activation patterns with real-time disagreement signals from the lab’s live prediction market on model outputs to detect epistemic uncertainty per token.

**Run this.** Analyze token-level activations during high vs low market disagreement periods and test predictive power for hallucination.

**Kills it.** No correlation between activation patterns and market disagreement or hallucination rates.

**Needs from you.** prediction market data, token-aligned activations, hallucination ground truth

**Retrieved:** `2603.04069`, `2605.28740`, `2608.09643`, `2603.25450`, `2605.11328`, `2604.22271`, `2608.18597`, `2511.03628`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Live Prediction Market Disagreement leverages real-time human or model ensemble judgments about the correctness of each token, correlating these with internal activations to detect epistemic uncertainty. If certain activation patterns consistently align with tokens that the market flags as uncertain or disputed, these patterns could serve as cheap, internal proxies for uncertainty during generation, enabling token-level detection without expensive external checks.

**EVIDENCE:**  
None of the retrieved papers directly evaluate live prediction market signals as internal activation correlates. Related work shows internal activations can reveal reward hacking [1], token-level uncertainty [2], and error signals [6], while cross-model disagreement is a known correctness proxy [4]. However, none combine live market disagreement with activation monitoring for per-token epistemic uncertainty.

**WHAT WOULD FALSIFY IT:**  
If internal activations fail to correlate with live market disagreement signals—i.e., activation patterns do not reliably predict tokens flagged as uncertain or wrong by the market—or if the correlation is too weak or inconsistent to be used as a real-time signal, the approach would be invalidated.

**RISK:**  
Optimizing for activation patterns that correlate with market disagreement might encourage the model to produce tokens that superficially trigger uncertainty signals without genuine epistemic uncertainty, inflating detection metrics while degrading actual reliability or increasing false alarms, thus harming trustworthiness despite improved headline scores.

</details>

---

## Verify before starting

1 idea(s) matched nothing — 1 of them after arXiv, OpenAlex and OpenReview were actually searched. That is still not novelty: no index covers work published only as a blog post or a model card, or anything too recent to be indexed at all. Re-run these by hand before committing real time.

**2. Live Prediction Market Disagreement as Internal Activation Signal**
- `live prediction market disagreement internal activations epistemic uncertainty`
- `token-level epistemic uncertainty prediction market activations`
