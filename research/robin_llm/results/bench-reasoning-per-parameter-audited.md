# Bench list — raise reasoning capability per parameter in a small in-house language model we can serve on 8GB, using open-weight models and verification we can run ourselves

**NOTHING HERE HAS BEEN RUN.** These are ranked proposals, not results. The ranking is a Bradley-Terry-Luce fit over 36 pairwise judgements; it says which ideas an LLM judge preferred given the retrieved literature, and nothing about whether they work.

**Sham control held.** An inert proposal was ranked in disguise alongside these and placed 9 of 9, so the ranking is not simply rewarding plausible prose.

**Novelty audit ran** and both of its own controls passed (a planted restatement was caught, a planted already-answered idea was caught): 1 ANSWERED-HERE, 3 INCREMENTAL, 1 PORT, 2 UNVERIFIED, 1 RESTATES.

No verdict below says "novel", because nothing here can establish that. `UNVERIFIED` means the local corpus and our own notebook did not match it — the same silence that, read as novelty on 2026-08-20, produced two recommendations a single web search killed.

Corpus: 40 papers retrieved, 10 most relevant + 8 most recent shown to the generator. 0 of 8 ideas below retrieved no supporting paper. Generated 2026-08-20.

---

## 1. Verification-Driven Self-Correction in 8GB Models

**Cost:** medium · **BTL strength** 0.5071 (8/8 pairwise wins)

**Prior art: ANSWERED-HERE** — `docs\adr\0030-spiral-verified-cascade-harness.md`. Our ADR-0030 Spiral verified-cascade loop implements iterative verification and refinement in a small model core, matching the idea's mechanism.

**Mechanism.** Use a small open-weight model to generate chain-of-thought, then verify and refine outputs iteratively with a lightweight verifier module to boost reasoning per parameter

**Run this.** Run iterative generate-verify-refine loops on math reasoning tasks, measuring accuracy gains per iteration

**Kills it.** No accuracy improvement or degradation after 3 refinement cycles

**Needs from you.** 8GB GPU, curated reasoning dataset, coding time for verifier integration

**Retrieved:** `2606.21724`, `2510.09211`, `2602.02416`, `2510.17498`, `2510.16374`, `2602.12279`, `2602.08948`, `2509.00325`

<details><summary>Sceptical review</summary>

MECHANISM:  
Verification-driven self-correction leverages a small model’s ability to generate chain-of-thought (CoT) reasoning, then applies a lightweight verifier module to identify and iteratively refine errors. This structured feedback loop can reduce reasoning errors by explicitly localizing and correcting flawed intermediate steps, effectively amplifying reasoning quality per parameter without increasing model size. The verifier acts as a focused critic, enabling targeted improvements rather than blind regeneration, which is critical in constrained 8GB models where brute-force scaling is impossible.

EVIDENCE:  
The literature supports iterative self-correction and verification improving reasoning in LLMs, including smaller models. DISC [1] shows test-time denoising loops reduce errors; DICE [2] and [3] demonstrate structured error localization and correction; CoRefine [7] uses a lightweight controller for confidence-guided refinement; and GIER [8] iteratively improves outputs via gap-driven self-reflection. However, [4] cautions that verification-refinement frameworks remain fragile in smaller open-weight models, indicating partial but not definitive support.

WHAT WOULD FALSIFY IT:  
If iterative verification and refinement fail to improve or even degrade reasoning accuracy on benchmark tasks—especially when controlling for compute and token budget—it would falsify the claim. Additionally, if the verifier cannot reliably detect errors or introduces new errors, the mechanism would be ineffective.

RISK:  
This approach might improve headline accuracy by overfitting to verification heuristics or producing superficially consistent but semantically incorrect outputs. Iterative loops could amplify subtle verifier biases or hallucinations, leading to brittle reasoning that appears better on benchmarks but performs worse in real-world or adversarial scenarios.

</details>

## 2. Instruction-Tuned Context Distillation

**Cost:** medium · **BTL strength** 0.2515 (7/8 pairwise wins)

**Prior art: INCREMENTAL** — `experiments\sigma0_ouro_honesty_eval.py`. Prior work measures QLoRA-tuned Ouro honesty adapter on reasoning prompts, related but not identical to instruction-tuned context distillation.

**Mechanism.** Use a frontier API to generate detailed chain-of-thought explanations for reasoning tasks, then fine-tune a small open-weight model on these distilled contexts to improve reasoning per parameter.

**Run this.** Fine-tune a 7-10B model on 100k API-generated CoT examples, then benchmark reasoning on held-out tasks against baseline.

**Kills it.** No statistically significant reasoning accuracy gain over baseline after fine-tuning.

**Needs from you.** Cloud API calls for data generation, GPU hours for fine-tuning, evaluation time.

**Retrieved:** `2607.10666`, `2512.20908`, `2603.13765`, `2511.05184`, `2510.18817`, `2607.14552`, `2603.20510`, `2605.20201`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Instruction-tuned context distillation leverages a large, capable teacher model (via API) to generate detailed chain-of-thought (CoT) explanations for reasoning tasks. Fine-tuning a smaller open-weight model on these rich, stepwise reasoning traces could teach it to internalize reasoning patterns, improving reasoning per parameter. This approach effectively transfers latent reasoning strategies rather than just final answers, potentially boosting sample efficiency and interpretability in a constrained 8GB model.

**EVIDENCE:**  
Several papers support aspects of this idea. [4] shows CoT can help distill reasoning from large to smaller LLMs, improving student performance. [3] demonstrates knowledge distillation combined with guided CoT reinforcement learning can compress models while retaining reasoning. However, [6] warns that conditioning on correct answers to generate CoT can degrade data quality, harming distillation. [2] highlights uncertainty about the provenance of distilled reasoning capabilities, suggesting incomplete understanding of what is transferred. Overall, evidence is cautiously positive but nuanced.

**WHAT WOULD FALSIFY IT:**  
If fine-tuning on teacher-generated CoT explanations fails to improve or even degrades the small model’s reasoning accuracy on held-out benchmarks—especially when controlling for data quantity and quality—this would falsify the claim. Also, if improvements come solely from memorizing patterns rather than genuine reasoning, it would undermine the mechanism.

**RISK:**  
The method might improve benchmark scores by overfitting to teacher-generated CoT styles or superficial heuristics, inflating headline reasoning metrics while reducing robustness, generalization, or verifiability. This could produce brittle models that appear better but fail in real-world or adversarial reasoning tasks.

</details>

## 3. Context Window Extension with Retrieval-Augmented Reasoning

**Cost:** medium · **BTL strength** 0.1243 (6/8 pairwise wins)

**Prior art: INCREMENTAL** — `experiments/csf_converge_rkd_probe.py`. Prior work tests retrieval-anchored compression, related but not identical to augmenting small model input with retrieved reasoning snippets.

**Mechanism.** Augment small model input with retrieved verified reasoning snippets from a local database to extend effective context and improve reasoning without increasing model size.

**Run this.** Build retrieval index of verified reasoning chains, integrate retrieval into prompt, measure reasoning accuracy gains on complex tasks.

**Kills it.** No measurable improvement in reasoning accuracy despite retrieval augmentation.

**Needs from you.** Storage for retrieval index, GPU for retrieval integration and evaluation, time for dataset curation.

**Retrieved:** `2507.05633`, `2603.06593`, `2607.20448`, `2604.02259`, `2607.07740`, `2606.01899`, `2604.23801`, `2605.30365`

<details><summary>Sceptical review</summary>

MECHANISM:  
Retrieval-Augmented Reasoning extends a small model’s effective context by prepending verified reasoning snippets from a local database, allowing the model to leverage external knowledge without increasing parameter count or native context window. This can improve reasoning by providing relevant facts or intermediate steps that the model alone might not recall or infer, effectively offloading memory and reasoning complexity to retrieval and verification components.

EVIDENCE:  
The literature supports retrieval augmentation as a promising approach to extend context and improve factual accuracy ([1], [4], [7]). SARA [1] highlights balancing precision and compression in retrieval, while [7] compares domain fine-tuning versus retrieval for small models, showing retrieval can be competitive. Domyn-Small [3] demonstrates context extension via continued pretraining but does not isolate retrieval. None directly confirm that retrieval-augmented reasoning reliably raises reasoning capability per parameter in small models on 8GB hardware.

WHAT WOULD FALSIFY IT:  
If retrieval-augmented inputs fail to improve or degrade reasoning accuracy compared to baseline prompts of equal length, or if the overhead of retrieval and verification introduces latency or noise that confuses the model, then the mechanism does not work as intended. Also, if the model cannot effectively integrate retrieved snippets due to limited capacity or context window constraints, the approach fails.

RISK:  
This design could inflate headline reasoning scores by cherry-picking or overfitting retrieved snippets, masking the model’s intrinsic reasoning limits. It may also increase inference complexity and latency, reduce robustness to retrieval errors, or cause over-reliance on external data, degrading generalization and interpretability despite improved benchmark numbers.

</details>

## 4. Parameter-Efficient Spectral Rewiring for Reasoning

**Cost:** medium · **BTL strength** 0.0618 (5/8 pairwise wins)

**Prior art: INCREMENTAL** — `[2607.03065] Spectral Rewiring for Exploration, Purification, and Model Merging`. Paper applies spectral rewiring broadly; our idea focuses on parameter-efficient post-training weight updates for reasoning, a related but distinct mechanism.

**Mechanism.** Apply spectral rewiring to selectively update model weights post-training to reduce interference and enhance reasoning without full retraining

**Run this.** Fine-tune a 7-10B open-weight model with spectral rewiring on reasoning benchmarks, compare reasoning metrics before/after

**Kills it.** No statistically significant reasoning improvement or loss in baseline tasks

**Needs from you.** 8GB GPUs for fine-tuning, reasoning benchmark data, 1-2 weeks of compute

**Retrieved:** `2607.03065`, `2606.31092`, `2602.12429`, `2512.04457`, `2607.09800`, `2607.20438`, `2605.18822`, `2605.20296`

<details><summary>Sceptical review</summary>

MECHANISM:  
Spectral rewiring aims to selectively update model weights along dominant spectral directions post-training, reducing interference between learned features and preserving useful capabilities. By focusing updates on key eigenmodes, it can enhance reasoning-related subspaces without full retraining, potentially improving reasoning per parameter efficiently in a small model.

EVIDENCE:  
[1] demonstrates spectral rewiring reduces interference and improves reasoning saturation in RL fine-tuning. [6] shows spectral decomposition clarifies preference tuning updates, supporting spectral methods for targeted post-training adaptation. [8] proposes spectral unforgetting to recover capabilities post-fine-tuning, indicating spectral methods can preserve or enhance capabilities without full retraining. Other papers focus on related but distinct methods or training regimes.

WHAT WOULD FALSIFY IT:  
If applying spectral rewiring post-training fails to improve reasoning benchmarks or causes degradation in reasoning performance compared to baseline fine-tuning or LoRA, especially when controlling for parameter count and compute, it would falsify the claim. Also, if spectral rewiring cannot be reliably applied on small 8GB models or leads to unstable or inconsistent results, that would disprove its practical utility.

RISK:  
Spectral rewiring might improve headline reasoning scores by overfitting to benchmark artifacts or by selectively boosting certain spectral modes that do not generalize, masking degradation in broader capabilities or robustness. It could also reduce model diversity or flexibility, harming performance on out-of-distribution inputs despite improved in-distribution metrics.

</details>

## 5. Test-Time Sampling Sharpening for Reasoning Enhancement

**Cost:** low · **BTL strength** 0.0305 (4/8 pairwise wins)

**Prior art: PORT** — `[2601.21590] (2026-01) Scalable Power Sampling: Unlocking Efficient, Training-Free Reasoning for LLMs via Distribution Sharpening`. The idea matches test-time distribution sharpening and temperature modification for reasoning without retraining as in this paper.

**Mechanism.** Modify sampling temperature and distribution sharpening at inference to mimic RL gains in reasoning without retraining

**Run this.** Evaluate reasoning accuracy on chain-of-thought tasks across sampling parameters, identify optimal sharpening

**Kills it.** No improvement or consistent degradation in reasoning accuracy across all tested parameters

**Needs from you.** 8GB GPU for inference, reasoning datasets, scripting for sampling control

**Retrieved:** `2601.21590`, `2607.09693`, `2602.10273`, `2602.19169`, `2605.04542`, `2510.02611`, `2606.00755`, `2605.28142`

<details><summary>Sceptical review</summary>

MECHANISM:  
Test-time sampling sharpening works by concentrating probability mass on higher-likelihood sequences, effectively mimicking the effect of RL fine-tuning without weight updates. By lowering temperature or applying power transformations to the output distribution, the model favors more confident, coherent reasoning paths, potentially improving reasoning accuracy per parameter in a small model constrained to 8GB. This leverages the pretrained model’s latent capabilities rather than requiring costly retraining.

EVIDENCE:  
The literature consistently supports that distribution sharpening at inference recovers much of the reasoning gains attributed to RL, e.g., [1], [3], and [5] show power sampling concentrates on high-likelihood sequences, improving reasoning without retraining. [2] confirms that sampling methods guided by entropy or depth metrics enhance reasoning. However, [8] cautions that sharpening full completions may entangle reasoning traces with final answers, suggesting limits. None report dramatic gains beyond modest improvements, especially in small models.

WHAT WOULD FALSIFY IT:  
If test-time sharpening fails to improve reasoning accuracy on standard benchmarks compared to baseline sampling, or if gains vanish when controlling for output diversity, it would falsify the claim. Also, if sharpening reduces reasoning robustness or leads to overconfident but incorrect answers, that would disprove its utility.

RISK:  
Sharpening can reduce output diversity, causing the model to repeat confident but flawed reasoning patterns, inflating headline accuracy while degrading real-world reliability. It may also mask underlying model weaknesses, giving a false sense of improved reasoning without true capability gains.

</details>

## 6. Sparse Expert Routing via Frontier API Feedback

**Cost:** high · **BTL strength** 0.0147 (3/8 pairwise wins)

**Prior art: UNVERIFIED**. No exact or close match found in papers or own work for sparse expert routing via Frontier API feedback clustering. arXiv and OpenAlex were searched (63 hits) and none matched.

**Mechanism.** Use frontier API to identify reasoning subtask clusters, then train a small model with sparse expert modules specialized per cluster, routing inputs accordingly to boost reasoning efficiency.

**Run this.** Cluster reasoning tasks, train sparse experts on each, evaluate reasoning accuracy and parameter efficiency against dense baseline.

**Kills it.** Sparse expert model shows no accuracy or efficiency improvement over dense baseline on reasoning tasks.

**Needs from you.** Cloud API for clustering, GPU for sparse expert training, task dataset.

**Retrieved:** `2604.13694`, `2602.02685`, `2606.02502`, `2508.02587`, `2608.09251`, `2605.00334`, `2510.02345`, `2605.02960`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Sparse Expert Routing via Frontier API Feedback could work by decomposing complex reasoning into subtasks, each handled by specialized expert modules. The Frontier API clusters inputs by reasoning type, enabling targeted routing that leverages parameter efficiency—small experts focus on narrow skills, boosting reasoning per parameter. This modularity can reduce interference and improve generalization within each cluster, fitting a capable model within 8GB.

**EVIDENCE:**  
The retrieved literature provides partial support. Papers on MoE dynamics and routing [4,7] highlight benefits of expert specialization and dynamic clustering, addressing load balancing and parameter redundancy. [5] shows task-oriented expert specialization improves complex task handling. [6] discusses routing smaller models for subtask efficiency, aligning with the Frontier API idea. However, none directly validate Frontier API feedback for reasoning subtask clustering or demonstrate gains in small, open-weight models under strict memory constraints.

**WHAT WOULD FALSIFY IT:**  
If routing inputs by Frontier API clusters fails to improve reasoning accuracy or efficiency compared to a dense baseline of similar size, or if expert specialization leads to overfitting on subtasks and poor generalization, the mechanism would be falsified. Also, if routing overhead or cluster misclassification negates parameter savings, the approach would not work.

**RISK:**  
This design could inflate headline reasoning metrics by optimizing for clustered subtasks but degrade overall robustness and flexibility. Over-specialized experts might fail on out-of-distribution inputs or subtasks not well captured by Frontier clusters, reducing real-world utility despite apparent parameter efficiency gains.

</details>

## 7. Modular Verification Head Addition

**Cost:** low · **BTL strength** 0.0067 (2/8 pairwise wins)

**Prior art: UNVERIFIED**. No prior or external work explicitly attaches a lightweight verification head to frozen small models for reasoning step correctness scoring. arXiv and OpenAlex were searched (40 hits) and none matched.

**Mechanism.** Attach a lightweight verification head to a frozen small model to explicitly score reasoning step correctness, enabling iterative refinement without full retraining.

**Run this.** Train verification head on reasoning step correctness labels, measure improvement in final reasoning accuracy via self-correction loops.

**Kills it.** Verification head fails to improve final reasoning accuracy or harms inference speed beyond usability.

**Needs from you.** GPU for head training, labeled verification data from API or heuristics, inference benchmarking.

**Retrieved:** `2602.08948`, `2510.17498`, `2607.18343`, `2607.08775`, `2511.06209`, `2604.11867`, `2606.30185`, `2607.23806`

<details><summary>Sceptical review</summary>

MECHANISM:  
Adding a lightweight verification head to a frozen small model could work by explicitly scoring the correctness of intermediate reasoning steps, enabling targeted iterative refinement without retraining the entire model. This modular approach isolates verification from generation, potentially improving reasoning per parameter by focusing compute on error detection and correction, which is cheaper than full model updates and can be run within 8GB constraints.

EVIDENCE:  
[1] shows a lightweight controller atop a frozen LLM can guide self-refinement efficiently, supporting modular verification heads. [2] highlights that verification-refinement frameworks rely on strong verifiers, but these are fragile in small open models, suggesting challenges. [5] discusses expensive verification in large models, implying lightweight heads could reduce cost. [6] reports difficulty instilling verification behaviors in small models, indicating potential fragility. Overall, evidence is mixed but leans toward feasibility with caveats.

WHAT WOULD FALSIFY IT:  
If adding a verification head does not improve reasoning accuracy or iterative refinement quality beyond baseline frozen models, or if verification scores fail to correlate with actual reasoning correctness, the mechanism would be invalidated. Also, if the verification head cannot be trained reliably on small models or leads to no gains under 8GB constraints, that would falsify the claim.

RISK:  
The verification head might improve headline metrics by overfitting to superficial signals or heuristics, giving false confidence in reasoning steps without true understanding. This could cause iterative refinement to reinforce errors or waste compute, degrading real-world robustness despite apparent metric gains.

</details>

## 8. Tool-Selection Canary Probes to Improve Small Model Reasoning

**Cost:** low · **BTL strength** 0.0027 (1/8 pairwise wins)

**Prior art: RESTATES** — `2608.04719`. The idea matches the paper titled 'Diagnosing Tool-Selection Reasoning in LLM Agents with Canary Tools' exactly.

**Mechanism.** Embed diagnostic canary tools in model context to identify and correct tool-selection errors that limit reasoning

**Run this.** Augment a small model agent with canary tools, measure reasoning task success and error types with/without canaries

**Kills it.** No reduction in tool-selection errors or reasoning task success rate

**Needs from you.** 8GB GPU, agent scaffolding code, time to implement canary tools and evaluation

**Retrieved:** `2608.04719`, `2608.15579`, `2602.17046`, `2509.23426`, `2601.05366`, `2606.04141`, `2606.30185`, `2605.13706`

<details><summary>Sceptical review</summary>

MECHANISM: Embedding diagnostic canary tools in the model’s context aims to expose specific tool-selection weaknesses by triggering identifiable failure modes. This targeted probing can help the model recognize and correct its tool choices during reasoning, potentially improving accuracy per parameter by reducing misrouted reasoning steps without retraining the core model.

EVIDENCE: Paper [1] directly introduces canary tools as diagnostic probes to identify tool-selection errors in LLM agents, supporting the mechanism. Papers [3] and [7] discuss related improvements in tool selection and dynamic adaptation but do not focus on canary probes specifically. The rest do not address this mechanism. Thus, only [1] provides direct evidence.

WHAT WOULD FALSIFY IT: If embedding canary probes fails to reduce tool-selection errors or does not improve downstream reasoning accuracy in a small, resource-constrained model, despite clear diagnostic signals, this would falsify the claim. Also, if the probes confuse the model or increase error rates, it would show the approach does not work.

RISK: Canary probes might improve measured tool-selection metrics or benchmark scores by overfitting to probe patterns, while actually increasing context complexity and confusion. This could degrade real-world reasoning or generalization, inflating headline numbers but worsening overall system robustness and efficiency.

</details>

---

## Verify before starting

2 idea(s) matched nothing — 2 of them after arXiv and OpenAlex were actually searched. That is still not novelty: both indexes miss OpenReview submissions and unindexed preprints, which is where one of the two papers that killed a novelty claim on 2026-08-20 lives. Re-run these by hand before committing real time.

**6. Sparse Expert Routing via Frontier API Feedback**
- `sparse expert routing reasoning subtask clustering`
- `Frontier API feedback sparse mixture of experts`

**7. Modular Verification Head Addition**
- `modular verification head for reasoning correctness in language models`
- `lightweight verification head frozen model iterative refinement`
