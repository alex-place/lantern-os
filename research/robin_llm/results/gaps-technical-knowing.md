# Bench list — detect when a language model is answering beyond what it knows, from its own activations, cheaply enough to run on every token in production

**NOTHING HERE HAS BEEN RUN.** These are ranked proposals, not results. The ranking is a Bradley-Terry-Luce fit over 10 pairwise judgements; it says which ideas an LLM judge preferred given the retrieved literature, and nothing about whether they work.

**Sham control held.** An inert proposal was ranked in disguise alongside these and placed 4 of 5, so the ranking is not simply rewarding plausible prose.

Corpus: 40 papers retrieved, 10 most relevant + 8 most recent shown to the generator. 0 of 3 ideas below retrieved no supporting paper. Generated 2026-08-20.

---

## 1. Ledger-Conditioned Sparse Activation Sampling for On-Token Hallucination Flags

**Cost:** low · **BTL strength** 0.5575 (4/4 pairwise wins)

**Prior art: INCREMENTAL** — `experiments/sigma0_hneurons_probe.py`. Prior work probes sparse FFN neurons predicting hallucination, but not ledger-conditioned sparse activation sampling per token.

**Mechanism.** Use the lab’s longitudinal convergence ledger to condition a sparse sampling mask over internal activations, focusing compute on historically predictive neuron subsets per token

**Run this.** Train a sparse gating function conditioned on ledger-derived neuron importance; evaluate hallucination detection accuracy and compute cost per token against dense baselines

**Kills it.** Sparse sampling yields no improvement or degrades detection accuracy compared to dense activation probes

**Needs from you.** ledger data, retraining time, moderate hardware

**Retrieved:** `2607.00158`, `2607.11990`, `2608.18597`, `2608.14003`, `2603.04069`, `2512.20605`, `2605.27813`, `2602.05805`

<details><summary>Sceptical review</summary>

MECHANISM:  
Conditioning sparse activation sampling on a longitudinal convergence ledger could focus compute on neuron subsets historically predictive of hallucination, enabling efficient on-token flags. By leveraging past neuron behavior correlations with hallucination, the model might cheaply detect internal signals of uncertainty or error without full dense evaluation, fitting production constraints.

EVIDENCE:  
[1] shows neuron-level signals correlate with hallucination but questions controllability, suggesting detection is plausible but not straightforwardly actionable. [2] supports sparse neuron dependencies, implying selective sampling could capture meaningful signals. [5] demonstrates activation-based monitoring can detect misalignment during generation, aligning with the idea of internal flags. Other papers focus on pruning or interpretability but do not directly support ledger-conditioned sparse sampling for hallucination detection. Overall, partial support exists but no direct demonstration of ledger-conditioned sparse masks for on-token hallucination flags.

WHAT WOULD FALSIFY IT:  
If sparse sampling conditioned on historical neuron subsets fails to reliably flag hallucinations on a per-token basis, or if the flagged neurons do not generalize across contexts, this would falsify the claim. Also, if the overhead of maintaining and applying the ledger outweighs the computational savings or detection accuracy, the approach would be invalidated.

RISK:  
Focusing on historically predictive neurons might miss novel hallucination modes, causing false negatives. The system could overfit to known hallucination patterns, improving headline detection metrics but failing silently on new errors. Additionally, sparse sampling might degrade overall model performance or introduce latency, undermining production viability despite apparent gains.

</details>

## 2. Ledger-Guided Online Calibration of Internal Confidence Signals via Trading Outcome Feedback

**Cost:** medium · **BTL strength** 0.2649 (3/4 pairwise wins)

**Prior art: UNVERIFIED**. No listed papers or prior work directly describe live recalibration of internal confidence signals via settled trading outcomes. arXiv, OpenAlex and OpenReview were searched (155 hits) and none matched.

**Mechanism.** Use live settled trading outcomes from the lab’s prediction market to continuously recalibrate internal confidence signals in real time, improving per-token epistemic accuracy

**Run this.** Implement online calibration loop feeding settled trade results back into confidence signal scaling, measure reduction in hallucination false positives over 1 month

**Kills it.** No measurable reduction in false positive hallucination flags or confidence miscalibration after 1 month of continuous calibration

**Needs from you.** hardware, live trading data, time

**Retrieved:** `2607.00164`, `2511.13240`, `2604.03888`, `2604.22271`, `2511.15921`, `2604.20421`, `2604.07355`, `2604.16742`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Using live settled trading outcomes from a prediction market to recalibrate internal confidence signals could work by providing continuous, objective feedback on the model’s epistemic accuracy. This feedback loop would allow the model to adjust its confidence estimates in real time, aligning them better with actual event outcomes. Since prediction markets aggregate diverse information and reflect collective probabilities, their settled results serve as a reliable ground truth for calibration, potentially improving per-token confidence without expensive external annotation.

**EVIDENCE:**  
The literature supports the idea that verifiable outcomes can improve calibration in principle [1], and that prediction markets provide real-world, objective signals for forecasting [6,7]. However, [1] notes practical challenges where reinforcement learning with verifiable rewards can degrade calibration. Also, [4] shows internal confidence signals exist but their recalibration mechanisms are unclear. None directly demonstrate that live trading outcomes can be used online per token to improve epistemic accuracy cheaply.

**WHAT WOULD FALSIFY IT:**  
If continuous recalibration using live market outcomes fails to improve or even degrades per-token confidence accuracy—e.g., confidence remains poorly aligned with actual correctness despite feedback—or if the latency and noise in market outcomes prevent timely, meaningful updates, the mechanism would be falsified.

**RISK:**  
This approach might improve headline calibration metrics by overfitting to market outcomes, causing the model to become overly conservative or biased toward market consensus. It could suppress genuine uncertainty signals or token-level nuance, reducing the model’s ability to detect novel or out-of-distribution errors, thus worsening real-world reliability despite better aggregate scores.

</details>

## 3. Real-Time Epistemic Divergence via Cross-Modal Activation Alignment

**Cost:** medium · **BTL strength** 0.1167 (2/4 pairwise wins)

**Prior art: UNVERIFIED**. No prior work or papers explicitly align internal activations cross-modally at each token to detect hallucination. arXiv, OpenAlex and OpenReview were searched (134 hits) and none matched.

**Mechanism.** Align internal activations from language and auxiliary modalities (e.g. vision or symbolic metadata) at each token to detect epistemic divergence indicating hallucination

**Run this.** Measure token-level divergence between language-only and multimodal activations in a model with lightweight auxiliary input; correlate divergence spikes with hallucination labels

**Kills it.** No statistically significant correlation (AUROC ≤ 0.5) between cross-modal divergence and hallucination events

**Needs from you.** multimodal data, moderate compute, weeks

**Retrieved:** `2510.20193`, `2608.18597`, `2601.00269`, `2605.10815`, `2605.07407`, `2512.23447`, `2510.21323`, `2512.22508`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Aligning internal activations from language and auxiliary modalities (e.g., vision or symbolic metadata) at each token could reveal discrepancies when the language model "hallucinates" or answers beyond its knowledge. If the language activations diverge from those in a trusted auxiliary modality, this epistemic divergence might signal uncertainty or error, enabling real-time detection without expensive external checks.

**EVIDENCE:**  
The retrieved literature provides partial support but no direct validation. Papers on cross-modal alignment and reasoning [1,4,7] show that multi-modal models can align representations effectively, suggesting feasibility. Work on hallucination detection in vision-language models [3] indicates that internal signals can flag ungrounded answers. However, none explicitly demonstrate real-time token-level epistemic divergence detection purely from activation alignment, nor its cheap deployability.

**WHAT WOULD FALSIFY IT:**  
If token-level alignment scores between language and auxiliary modalities fail to correlate with hallucination or epistemic uncertainty—e.g., high alignment during hallucinations or low alignment during correct answers—or if the computational overhead is prohibitive for per-token use, the mechanism would be invalidated.

**RISK:**  
Optimizing for alignment-based divergence detection might encourage the model to produce superficially consistent but semantically shallow outputs, masking hallucinations. This could improve detection metrics while degrading actual factuality or robustness, creating a false sense of reliability.

</details>

---

## Verify before starting

2 idea(s) matched nothing — 2 of them after arXiv, OpenAlex and OpenReview were actually searched. That is still not novelty: no index covers work published only as a blog post or a model card, or anything too recent to be indexed at all. Re-run these by hand before committing real time.

**2. Ledger-Guided Online Calibration of Internal Confidence Signals via Trading Outcome Feedback**
- `online calibration internal confidence signals prediction markets`
- `real-time confidence recalibration using trading outcome feedback`

**3. Real-Time Epistemic Divergence via Cross-Modal Activation Alignment**
- `cross-modal activation alignment hallucination detection`
- `real-time epistemic divergence language vision model`
