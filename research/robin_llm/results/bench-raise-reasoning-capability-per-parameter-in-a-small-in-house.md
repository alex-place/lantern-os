# Bench list — raise reasoning capability per parameter in a small in-house language model we can serve on 8GB, using open-weight models and verification we can run ourselves

**NOTHING HERE HAS BEEN RUN.** These are ranked proposals, not results. The ranking is a Bradley-Terry-Luce fit over 36 pairwise judgements; it says which ideas an LLM judge preferred given the retrieved literature, and nothing about whether they work.

**Sham control held.** An inert proposal was ranked in disguise alongside these and placed 9 of 9, so the ranking is not simply rewarding plausible prose.

Corpus: 40 papers retrieved, 10 most relevant + 8 most recent shown to the generator. 0 of 8 ideas below retrieved no supporting paper. Generated 2026-08-20.

---

## 1. Test-Time Sampling with Depth-Entropy Guided Decoding

**Cost:** low · **BTL strength** 0.5071 (8/8 pairwise wins)

**Mechanism.** Apply depth-entropy guided sampling at inference to improve reasoning output quality without retraining

**Run this.** Run depth-entropy guided decoding on small open-weight model for multi-step reasoning tasks, measure accuracy vs baseline sampling

**Kills it.** No accuracy improvement or degraded output coherence compared to standard sampling

**Needs from you.** Access to model logits, implementation of guided sampling, inference time

**Retrieved:** `2607.09693`, `2601.03093`, `2606.20244`, `2508.03726`, `2509.00079`, `2606.27550`, `2508.16665`, `2507.17307`

<details><summary>Sceptical review</summary>

MECHANISM:  
Depth-entropy guided sampling aims to improve reasoning by dynamically adjusting token sampling based on uncertainty (entropy) at different transformer depths during inference. By focusing sampling on tokens or layers with higher entropy, the method can prioritize exploring uncertain reasoning paths without retraining, potentially recovering reasoning gains similar to RL fine-tuning but at test time. This leverages internal model signals beyond output logits, guiding generation toward more coherent or logically consistent outputs.

EVIDENCE:  
[1] directly supports this approach, showing that depth-entropy guided sampling at test time can recover much of the reasoning improvement from RL without retraining. [5] and [7] also discuss entropy-based test-time refinement and verification loops that improve reasoning by targeting uncertain tokens. Other papers focus on related verification or steering but not this exact mechanism. Thus, the literature provides moderate support for the core idea.

WHAT WOULD FALSIFY IT:  
If applying depth-entropy guided sampling at inference yields no measurable improvement in reasoning benchmarks compared to standard sampling, or if it consistently degrades output quality or coherence, that would falsify the claim. Also, if the entropy signals at intermediate depths do not correlate with reasoning errors or uncertainty, the mechanism would be invalidated.

RISK:  
This method could increase computational overhead and latency, hurting throughput. It might also bias sampling toward less probable tokens, increasing hallucinations or incoherence, thus inflating reasoning scores on some benchmarks while reducing real-world reliability. Overfitting to entropy heuristics could degrade generalization or produce brittle outputs under distribution shifts.

</details>

## 2. Verification-Refinement Loop on 135M Model

**Cost:** medium · **BTL strength** 0.2515 (7/8 pairwise wins)

**Mechanism.** Iteratively generate chain-of-thought with self-verification and correction to boost reasoning per parameter

**Run this.** Fine-tune L20-Edu-135M with verification-refinement on math reasoning tasks, measure accuracy gains

**Kills it.** No significant accuracy improvement after 3 refinement iterations

**Needs from you.** 135M model checkpoint, math datasets, few days GPU fine-tuning

**Retrieved:** `2510.17498`, `2602.02416`, `2606.22189`, `2606.13156`, `2602.08948`, `2602.00871`, `2606.21724`, `2510.16657`

<details><summary>Sceptical review</summary>

MECHANISM:  
The Verification-Refinement Loop aims to improve reasoning per parameter by having the 135M model generate chain-of-thought (CoT) reasoning, then verify and correct its own outputs iteratively. This could work because self-verification helps localize and fix errors in intermediate reasoning steps, potentially amplifying the model’s effective reasoning capacity without increasing parameters. Iterative refinement can reduce compounding errors in multi-step problems, effectively simulating a deeper reasoning process within a small model’s limited capacity.

EVIDENCE:  
The literature shows mixed support. [1] demonstrates verification-refinement in large proprietary models but notes fragility in smaller open-weight models. [2] supports error localization via structured reasoning steps, which is foundational for effective self-correction. [7] introduces a denoising iterative self-correction method that improves reasoning reliability, but primarily on larger models. [3] confirms feasibility of training 135M models but does not address verification loops. None conclusively prove robust verification-refinement loops improve reasoning in 135M open models.

WHAT WOULD FALSIFY IT:  
If iterative self-verification on the 135M model fails to improve or even degrades reasoning accuracy on benchmark tasks compared to single-pass CoT, especially when verified by human or automated checks, this would falsify the claim. Also, if error localization is unreliable or corrections introduce new errors, the mechanism fails.

RISK:  
The loop might inflate confidence and produce superficially coherent but incorrect reasoning, boosting benchmark scores via repeated token generation without genuine understanding. This could mask brittleness, increase latency, and reduce robustness, ultimately degrading real-world reasoning despite improved headline metrics.

</details>

## 3. Activation Subspace Fine-Tuning for Reasoning Preservation

**Cost:** medium · **BTL strength** 0.1243 (6/8 pairwise wins)

**Mechanism.** Fine-tune only top singular vectors of activations linked to reasoning, preserving core capabilities while improving reasoning per parameter

**Run this.** Identify reasoning-critical activation directions, fine-tune a 135M open-weight model on reasoning tasks, measure reasoning gains vs baseline

**Kills it.** No reasoning improvement or degradation in general language ability

**Needs from you.** One GPU, curated reasoning dataset, 1-2 weeks fine-tuning

**Retrieved:** `2606.31092`, `2510.13003`, `2509.03740`, `2601.21187`, `2605.24549`, `2601.08169`, `2603.06242`, `2604.12384`

<details><summary>Sceptical review</summary>

MECHANISM:  
Activation Subspace Fine-Tuning targets the top singular vectors of activations linked to reasoning, aiming to update only the most relevant functional directions. By focusing on these subspaces, it intends to preserve the bulk of the model’s pre-trained capabilities while improving reasoning efficiency per parameter. This selective fine-tuning could reduce catastrophic forgetting and maintain core knowledge, leveraging the idea that reasoning is encoded in a low-dimensional activation subspace.

EVIDENCE:  
Related work supports aspects of this approach. Fora [1] argues for preserving capabilities by protecting dominant singular directions, though it focuses on weights rather than activations. PALoRA [5] and OPLoRA [2] show that constraining updates in low-rank or orthogonal subspaces can prevent forgetting, but again primarily in weight space. FRISM [4] and DC-Merge [7] highlight benefits of subspace-level merging and directional consistency for capability preservation. None explicitly fine-tune activation singular vectors for reasoning preservation, so direct evidence is limited.

WHAT WOULD FALSIFY IT:  
If fine-tuning only top activation singular vectors fails to improve reasoning metrics or causes degradation in other core tasks, it would falsify the claim. Also, if reasoning improvements come at the cost of overall model robustness or if reasoning-related activations are not stable or identifiable, the mechanism would be invalidated.

RISK:  
Focusing on a narrow activation subspace might improve benchmark reasoning scores superficially while neglecting broader generalization or robustness. It could also cause overfitting to reasoning tasks, reducing performance on other capabilities or increasing brittleness, thus worsening real-world utility despite headline gains.

</details>

## 4. Hybrid Agentic Workflow Using Frontier API for Verification

**Cost:** medium · **BTL strength** 0.0618 (5/8 pairwise wins)

**Mechanism.** Combine small local model for generation with frontier API calls for verification steps, reducing API calls but boosting reasoning

**Run this.** Build agent pipeline where local 134M model generates steps, frontier API verifies/corrects, measure cost vs accuracy tradeoff

**Kills it.** Hybrid pipeline accuracy not better than frontier API alone or too costly to run

**Needs from you.** API budget, local GPUs, integration code, reasoning datasets

**Retrieved:** `2605.00334`, `2606.15079`, `2604.17450`, `2606.12821`, `2509.13597`, `2607.20216`, `2512.07785`, `2606.01019`

<details><summary>Sceptical review</summary>

MECHANISM:  
Using a small local model for initial generation leverages its low latency and low resource use, while selectively invoking a stronger frontier API only for verification steps could improve overall reasoning accuracy per parameter. This hybrid approach aims to reduce expensive API calls by filtering out easy or routine reasoning locally, reserving costly calls for critical verification, thus boosting effective reasoning without exceeding 8GB constraints.

EVIDENCE:  
[1] AgentFloor directly studies which agent workflow parts require large models versus small ones, supporting selective delegation. [3] discusses compiling deterministic workflows to mitigate small model epistemic limits, aligning with verification steps. [8] shows verification can be efficiently allocated in decoding, analogous to verification calls here. Other papers focus on scale or security but do not directly support this hybrid verification approach. Overall, partial support exists but no direct end-to-end demonstration.

WHAT WOULD FALSIFY IT:  
If the hybrid system’s verification calls do not measurably improve reasoning accuracy beyond the small model alone, or if verification overhead negates latency and cost savings, the approach fails. Also, if the small model’s errors are too frequent or subtle for the frontier API to catch reliably, the hybrid workflow would not improve reasoning per parameter.

RISK:  
The system might appear better by reporting improved verification pass rates or fewer API calls, but actual end-to-end reasoning or user-facing correctness could degrade if the small model’s flawed generations mislead verification or if verification is shallow. This could inflate headline metrics while reducing robustness or increasing complexity and maintenance burden.

</details>

## 5. Parameter-Efficient Multi-Task Merging via Spectral Rewiring

**Cost:** high · **BTL strength** 0.0305 (4/8 pairwise wins)

**Mechanism.** Merge multiple small-task-specialist models into one via spectral rewiring to reduce interference and boost reasoning per parameter

**Run this.** Train small models on distinct reasoning subtasks, merge with spectral rewiring, evaluate merged model on composite reasoning benchmark

**Kills it.** Merged model performs worse than individual specialists or baseline

**Needs from you.** Multiple GPUs or cloud hours for specialist training, 2-3 weeks

**Retrieved:** `2607.03065`, `2603.21584`, `2605.01580`, `2606.07289`, `2509.11167`, `2602.12566`, `2606.22589`, `2606.19164`

<details><summary>Sceptical review</summary>

MECHANISM:  
Spectral rewiring aims to merge multiple task-specialist models by aligning their principal parameter subspaces, reducing destructive interference when combining weights. By focusing on dominant spectral components, it preserves task-specific knowledge while enabling parameter sharing, potentially increasing reasoning capability per parameter in a merged model without retraining. This could be especially useful for small models on limited hardware (8GB), as it avoids full fine-tuning and large memory overhead.

EVIDENCE:  
The literature supports spectral methods for model merging and interference reduction [1,4,8]. For example, [4] shows closed-form spectral regularization can minimize interference in multi-task merging, and [8] highlights that task updates concentrate in low-dimensional subspaces, justifying spectral alignment. However, none demonstrate clear reasoning improvements per parameter in small, resource-constrained language models or verify gains on reasoning benchmarks relevant to your goal.

WHAT WOULD FALSIFY IT:  
If merging multiple task experts via spectral rewiring yields no improvement or degrades reasoning benchmark performance per parameter compared to a single-task or naïvely merged model, especially under 8GB constraints, this would falsify the claim. Also, if interference or catastrophic forgetting persists despite spectral alignment, the mechanism fails.

RISK:  
Spectral merging might improve headline metrics by averaging or smoothing weights, superficially boosting some tasks but diluting specialized reasoning capabilities. This could mask reduced robustness or generalization, leading to a model that appears better on benchmarks but performs worse in real-world reasoning or verification tasks.

</details>

## 6. Test-Time Depth-Entropy Sampling on Small Models

**Cost:** low · **BTL strength** 0.0147 (3/8 pairwise wins)

**Mechanism.** Apply depth-entropy guided sampling at inference to sharpen reasoning outputs without retraining

**Run this.** Implement depth-entropy sampling on 135M model, compare reasoning benchmark scores vs standard sampling

**Kills it.** No improvement or degradation in reasoning accuracy or coherence

**Needs from you.** No training, only inference code changes, multiple GPU hours for evaluation

**Retrieved:** `2607.09693`, `2606.20244`, `2603.20441`, `2601.03093`, `2510.17498`, `2603.27665`, `2602.02443`, `2603.15641`

<details><summary>Sceptical review</summary>

MECHANISM:  
Depth-entropy guided sampling at test time aims to sharpen reasoning outputs by dynamically adjusting token sampling based on internal model uncertainty (entropy) across transformer layers ("depth"). This could focus generation on more confident latent states, reducing hallucinations and improving logical coherence without retraining. It leverages the model’s own internal signals to guide output refinement, potentially boosting reasoning per parameter in small models constrained by 8GB memory.

EVIDENCE:  
[1] directly proposes depth-entropy guided sampling for training-free reasoning improvements, showing gains in large LLMs without retraining. However, it focuses on large models, and the method’s efficacy on small, open-weight models is not established. Other papers ([3], [4], [5]) discuss verification and latent steering but require more compute or retraining. None demonstrate clear success of this method on small, memory-limited models or verify reasoning improvements without retraining.

WHAT WOULD FALSIFY IT:  
If applying depth-entropy guided sampling at inference on small models yields no statistically significant improvement in reasoning benchmarks compared to standard sampling, or if it degrades output quality or consistency, this would falsify the claim. Also, if entropy signals do not correlate with reasoning correctness in small models, the mechanism fails.

RISK:  
Sharpening sampling distributions might reduce output diversity, causing overconfident but brittle reasoning that appears better on some metrics but fails on edge cases. It could also increase inference latency or complexity without commensurate gains, or amplify model biases by focusing on confident but incorrect latent states, misleading evaluation.

</details>

## 7. Modular Verification Head Addition

**Cost:** medium · **BTL strength** 0.0067 (2/8 pairwise wins)

**Mechanism.** Add a small verification head module to a base model to verify chain-of-thought steps, offloading verification from large APIs

**Run this.** Train a 135M model with a verification head on synthetic CoT verification data, test end-to-end reasoning accuracy without API calls

**Kills it.** Verification head fails to improve or worsens reasoning accuracy

**Needs from you.** One GPU, synthetic verification data generation, 1 week training

**Retrieved:** `2603.25944`, `2512.00003`, `2510.17498`, `2605.00334`, `2510.09340`, `2603.03332`, `2606.15079`, `2510.18817`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Adding a modular verification head aims to explicitly check chain-of-thought (CoT) reasoning steps, potentially catching errors early and improving overall reasoning accuracy. By offloading verification from large APIs to a small, specialized module, the base model can focus on generation while the verification head enforces logical consistency and correctness, increasing reasoning capability per parameter within tight memory constraints.

**EVIDENCE:**  
[3] discusses verification-refinement frameworks but notes their fragility in small open-weight models, suggesting verification is challenging at this scale. [5] highlights the complexity of multi-step deductive reasoning in small models, implying verification is non-trivial. [1] and [4] show small models can handle structured tasks but do not directly validate modular verification heads. Overall, no retrieved paper directly demonstrates that adding a modular verification head improves reasoning in small models; evidence is indirect or negative.

**WHAT WOULD FALSIFY IT:**  
If adding the verification head fails to improve or even degrades reasoning accuracy on multi-step CoT benchmarks—especially when compared to baseline small models without verification—or if verification outputs are unreliable or inconsistent, this would falsify the claim.

**RISK:**  
The verification head might increase computational overhead and complexity, causing slower inference or overfitting to verification heuristics that do not generalize. This could inflate benchmark scores by catching trivial errors while missing deeper reasoning flaws, giving a false sense of improved capability despite no real reasoning gain.

</details>

## 8. Sparse Activation Routing with Small MoE

**Cost:** medium · **BTL strength** 0.0027 (1/8 pairwise wins)

**Mechanism.** Use a small mixture-of-experts layer to route reasoning subtasks, increasing effective capacity without full parameter growth

**Run this.** Add 4-expert MoE layer to 134M model, train on reasoning benchmarks, compare reasoning accuracy and latency

**Kills it.** MoE routing yields no reasoning accuracy gain or increases latency beyond serving budget

**Needs from you.** Codebase for MoE, GPUs for training, reasoning datasets

**Retrieved:** `2605.02960`, `2606.21428`, `2605.10933`, `2605.06665`, `2603.01697`, `2606.04438`, `2510.10962`, `2606.17952`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Sparse Activation Routing with Small MoE could increase reasoning capability per parameter by selectively routing subtasks to specialized expert modules. This allows the model to leverage a larger effective capacity without increasing the full parameter count or compute per token, fitting within an 8GB memory constraint. By activating only a few experts per input, the model can focus capacity where needed, potentially improving reasoning without a proportional increase in FLOPs or memory.

**EVIDENCE:**  
The literature shows mixed support. [2] questions whether MoE actually improves inference speed or cost on edge hardware, highlighting practical overheads. [3] and [7] emphasize memory and storage bottlenecks from large expert pools, which could challenge in-house deployment on limited hardware. [8] proposes soft routing to improve efficiency but does not guarantee better reasoning per parameter. None conclusively demonstrate improved reasoning capability in small, memory-constrained models, so direct evidence is limited.

**WHAT WOULD FALSIFY IT:**  
If a small MoE model with sparse routing fails to outperform a dense baseline of similar parameter count on reasoning benchmarks, or if the overhead of routing and expert management negates any capacity gains, this would falsify the claim. Also, if memory or latency constraints prevent practical deployment on 8GB hardware, the approach would be invalidated.

**RISK:**  
The headline reasoning improvement might come from increased model complexity or overfitting in experts, while routing overheads degrade latency or increase memory fragmentation. This could yield a model that scores better on benchmarks but is slower, less stable, or harder to verify and maintain in-house, undermining practical utility.

</details>
