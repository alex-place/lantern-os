# Bench list — raise reasoning capability per parameter in a small in-house language model we can serve on 8GB, using open-weight models and verification we can run ourselves

**NOTHING HERE HAS BEEN RUN.** These are ranked proposals, not results. The ranking is a Bradley-Terry-Luce fit over 10 pairwise judgements; it says which ideas an LLM judge preferred given the retrieved literature, and nothing about whether they work.

**SHAM CONTROL FAILED.** An inert proposal placed 3 of 5. The ranking below is measuring plausibility, not merit — read the ideas, ignore the order.

Corpus: 40 papers retrieved, 10 most relevant + 8 most recent shown to the generator. 0 of 3 ideas below retrieved no supporting paper. Generated 2026-08-20.

---

## 1. Epistemic-Controller-Gated Dynamic Parameter Allocation

**Cost:** medium · **BTL strength** 0.5575 (4/4 pairwise wins)

**Prior art: UNVERIFIED**. No prior work or papers explicitly describe epistemic-controller-gated dynamic sparse subnetworks per reasoning step. arXiv, OpenAlex and OpenReview were searched (82 hits) and none matched.

**Mechanism.** Use epistemic controller gates to dynamically activate sparse subnetworks per reasoning step, reducing active parameters while preserving reasoning depth

**Run this.** Measure reasoning accuracy and parameter efficiency by gating subnetworks on 8GB model during multi-step reasoning tasks with recorded refutations

**Kills it.** No accuracy gain or parameter reduction compared to static full-parameter inference

**Needs from you.** 8GB GPU, existing epistemic controller logs, weeks

**Retrieved:** `2604.02051`, `2608.09250`, `2607.10836`, `2602.01599`, `2606.19808`, `2603.23998`, `2603.00729`, `2608.11233`

<details><summary>Sceptical review</summary>

MECHANISM:  
Epistemic-Controller-Gated Dynamic Parameter Allocation aims to activate only relevant sparse subnetworks per reasoning step, guided by an epistemic controller that estimates uncertainty or knowledge gaps. This could reduce active parameters while maintaining or increasing reasoning depth by focusing compute on needed transformations dynamically, avoiding redundant or uniform processing across steps.

EVIDENCE:  
[1] Ouroboros shows input-conditioned controllers modulating recursive transformer weights, supporting dynamic adaptation per step. [3] GRADE uses gating to route queries adaptively, improving multi-agent reasoning efficiency. [4] The Multiple Ticket Hypothesis supports sparse subnetworks sufficing for performance, implying dynamic sparsity could work. [6] Sparse Growing Transformer explores sparse depth allocation, related to dynamic parameter use. None directly validate epistemic gating for reasoning depth in small models on 8GB, but these works collectively suggest feasibility.

WHAT WOULD FALSIFY IT:  
If dynamic gating fails to preserve or improve reasoning accuracy compared to static dense or fixed sparse models at similar parameter budgets, or if gating overhead negates parameter savings, the mechanism would be falsified. Also, if epistemic signals do not correlate with useful gating decisions, the approach would fail.

RISK:  
Dynamic gating might improve headline metrics by selectively activating parameters but could degrade robustness or generalization if gating misfires. Overhead from the controller or gating logic might increase latency or complexity, and sparse subnetworks might miss synergistic parameter interactions, reducing reasoning quality despite fewer active parameters.

</details>

## 2. Prediction-Market-Weighted Ensemble Distillation for Small Models

**Cost:** medium · **BTL strength** 0.2649 (3/4 pairwise wins)

**Prior art: UNVERIFIED**. No prior work or papers explicitly use prediction-market confidence as weights for ensemble distillation into small models. arXiv, OpenAlex and OpenReview were searched (70 hits) and none matched.

**Mechanism.** Use settled prediction market confidence as weights to distill an ensemble of reasoning trajectories into a single small model, biasing learning towards high-confidence correct paths

**Run this.** Distill ensemble outputs weighted by market confidence into 8GB model, evaluate reasoning accuracy and calibration against unweighted distillation

**Kills it.** No improvement or degradation in reasoning accuracy or calibration compared to unweighted distillation

**Needs from you.** 8GB GPU, prediction market data, weeks

**Retrieved:** `2604.10688`, `2508.16861`, `2512.02092`, `2512.19093`, `2605.14876`, `2512.17630`, `2606.23104`, `2606.23897`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Using prediction-market confidence to weight reasoning trajectories during distillation could focus the small model’s learning on the most reliable, high-quality reasoning paths. This selective emphasis might improve token-level credit assignment and reduce noise from weaker or incorrect trajectories, potentially raising reasoning capability per parameter by biasing the student model toward verified, consensus-backed outputs.

**EVIDENCE:**  
None of the retrieved papers directly validate prediction-market-weighted ensemble distillation. Related works [1,7] discuss on-policy distillation and weighting trajectories by informativeness or correctness, showing benefits from selective training signals. Paper [6] supports confidence-weighted ensembles improving performance in emotion detection but not distillation. Paper [2] highlights challenges in capturing diverse reasoning paths, suggesting naive distillation is insufficient. Overall, no direct empirical support for prediction-market weighting in distillation for small LMs.

**WHAT WOULD FALSIFY IT:**  
If distilling with prediction-market-weighted trajectories yields no improvement or degrades reasoning accuracy compared to uniform or heuristic weighting, especially when controlling for ensemble quality and student capacity, this would falsify the claim. Also, if the small model overfits to high-confidence but narrow reasoning paths, losing generalization, that would disprove the mechanism’s benefit.

**RISK:**  
Focusing distillation on high-confidence trajectories might reduce reasoning diversity, causing the small model to miss alternative valid reasoning strategies. This could inflate benchmark scores on familiar tasks (headline number) while reducing robustness and adaptability in real-world or out-of-distribution reasoning, ultimately making the system brittle despite apparent gains.

</details>

## 3. Ledger-Guided Contrastive Fine-Tuning for Error Pattern Disentanglement

**Cost:** medium · **BTL strength** 0.0465 (1/4 pairwise wins)

**Prior art: UNVERIFIED**. No listed papers or prior work measure or fine-tune using ledger-guided contrastive disentanglement of error patterns. arXiv, OpenAlex and OpenReview were searched (107 hits) and none matched.

**Mechanism.** Leverage the longitudinal hypothesis ledger to identify and contrast error clusters, fine-tuning model to disentangle confusable reasoning patterns

**Run this.** Fine-tune on paired positive/negative hypothesis-evidence sets from ledger, measure reduction in specific error clusters on held-out reasoning tasks

**Kills it.** No statistically significant reduction in targeted error clusters or overall reasoning accuracy

**Needs from you.** 8GB GPU, ledger data, 2-3 weeks

**Retrieved:** `2601.16632`, `2507.10182`, `2606.22189`, `2508.04063`, `2507.16530`, `2601.07238`, `2608.18033`, `2511.14435`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Ledger-Guided Contrastive Fine-Tuning aims to improve reasoning by explicitly identifying clusters of similar errors (confusable reasoning patterns) from a longitudinal error ledger, then fine-tuning the model to separate these patterns via contrastive learning. This could help the model disentangle subtle reasoning failures that standard fine-tuning misses, effectively sharpening its internal representations to reduce systematic confusions and improve per-parameter reasoning efficiency.

**EVIDENCE:**  
None of the retrieved papers directly validate this approach. [6] discusses pattern selection in reasoning models but does not address ledger-guided contrastive fine-tuning. [1] relates to disentanglement in time series but not language model reasoning. [3] and [4] focus on small model training and fine-tuning but do not explore error pattern disentanglement. Overall, no direct empirical or theoretical support for ledger-guided contrastive fine-tuning in small LMs is found.

**WHAT WOULD FALSIFY IT:**  
If fine-tuning on error clusters identified from a ledger fails to reduce error correlation within clusters or does not improve reasoning accuracy beyond standard fine-tuning baselines, this would falsify the claim. Additionally, if the model’s representations do not show improved separability of confusable reasoning patterns post-training, the mechanism would be invalidated.

**RISK:**  
Focusing on disentangling error clusters might overfit the model to specific error patterns in the ledger, improving benchmark scores superficially while reducing generalization to unseen reasoning tasks. This could inflate headline reasoning metrics but degrade robustness and real-world performance, especially given limited data and compute in a small 8GB-serving model.

</details>

---

## Verify before starting

3 idea(s) matched nothing — 3 of them after arXiv, OpenAlex and OpenReview were actually searched. That is still not novelty: no index covers work published only as a blog post or a model card, or anything too recent to be indexed at all. Re-run these by hand before committing real time.

**1. Epistemic-Controller-Gated Dynamic Parameter Allocation**
- `epistemic controller gated dynamic parameter allocation`
- `dynamic sparse subnetworks reasoning step epistemic control`

**2. Prediction-Market-Weighted Ensemble Distillation for Small Models**
- `prediction market weighted ensemble distillation`
- `using prediction market confidence for model distillation`

**3. Ledger-Guided Contrastive Fine-Tuning for Error Pattern Disentanglement**
- `ledger-guided contrastive fine-tuning error pattern disentanglement`
- `longitudinal hypothesis ledger contrastive learning fine-tuning`
