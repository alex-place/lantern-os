# Bench list — raise reasoning capability per parameter in a small in-house language model we can serve on 8GB, using open-weight models and verification we can run ourselves

**NOTHING HERE HAS BEEN RUN.** These are ranked proposals, not results. The ranking is a Bradley-Terry-Luce fit over 36 pairwise judgements; it says which ideas an LLM judge preferred given the retrieved literature, and nothing about whether they work.

**Sham control held.** An inert proposal was ranked in disguise alongside these and placed 9 of 9, so the ranking is not simply rewarding plausible prose.

Corpus: 40 papers retrieved, 10 most relevant + 8 most recent shown to the generator. 0 of 8 ideas below retrieved no supporting paper. Generated 2026-08-20.

---

## 1. Test-Time Sampling Sharpening for Reasoning Enhancement

**Cost:** low · **BTL strength** 0.5071 (8/8 pairwise wins)

**Mechanism.** Use depth-entropy guided sampling to sharpen output distributions at inference, mimicking RL gains without training

**Run this.** Compare reasoning task accuracy of a 6B open-weight model with standard vs depth-entropy guided sampling

**Kills it.** No accuracy gain or increased hallucination rate with sharpened sampling

**Needs from you.** 8GB GPUs, reasoning benchmarks, 3 days inference experiments

**Retrieved:** `2607.09693`, `2602.19169`, `2608.03204`, `2606.09926`, `2510.11686`, `2604.26326`, `2605.28142`, `2606.20244`

<details><summary>Sceptical review</summary>

MECHANISM:  
Test-time sampling sharpening aims to improve reasoning by selectively reducing entropy in the model’s output distribution at key decision points, effectively focusing probability mass on more confident tokens. This mimics RL fine-tuning gains by biasing sampling towards higher-quality reasoning paths without retraining. Depth-entropy guidance leverages internal transformer states to identify where uncertainty is highest, sharpening only those steps to preserve diversity elsewhere, potentially enhancing reasoning coherence and correctness.

EVIDENCE:  
[1] directly supports this approach, showing that depth-entropy guided sampling recovers much of RL’s reasoning improvements without training. [4] and [7] also discuss entropy-based sharpening and power sampling at inference, highlighting benefits and pitfalls. None of the other papers provide strong direct evidence for test-time sharpening as a standalone reasoning enhancer, though [3] and [8] explore related test-time alignment and entropy shaping in multimodal contexts.

WHAT WOULD FALSIFY IT:  
If applying depth-entropy guided sharpening at inference fails to improve or even degrades reasoning accuracy on standard benchmarks compared to baseline sampling, especially in small models, this would falsify the claim. Additionally, if sharpening reduces output diversity but does not increase correctness or coherence, it would show the mechanism is ineffective.

RISK:  
Sharpening may artificially inflate confidence and reduce output entropy, improving metrics like likelihood or self-consistency without genuine reasoning gains. This could lead to overconfident but incorrect answers, harming robustness and generalization. It may also mask model weaknesses by suppressing uncertainty rather than resolving it.

</details>

## 2. Contextual Prompt Ensembles with Lightweight Re-Ranking

**Cost:** low · **BTL strength** 0.2515 (7/8 pairwise wins)

**Mechanism.** Generate multiple reasoning chains per query using small model, then re-rank with a lightweight learned scorer to select best chain

**Run this.** Run ensemble generation and re-ranking on 10B model, measure reasoning correctness and latency

**Kills it.** Re-ranking fails to improve or worsens final reasoning accuracy

**Needs from you.** 8GB GPU for inference, small re-ranker training data, 1 week

**Retrieved:** `2607.09438`, `2604.16535`, `2508.18444`, `2604.21133`, `2606.22862`, `2601.21278`, `2508.19999`, `2510.17498`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Contextual Prompt Ensembles with Lightweight Re-Ranking could improve reasoning per parameter by generating diverse reasoning chains from a small model, increasing the chance that one chain is correct or insightful. The learned scorer then efficiently selects the best chain, effectively amplifying reasoning quality without increasing model size or memory footprint. This leverages test-time compute to compensate for limited model capacity, potentially boosting accuracy on complex queries within 8GB constraints.

**EVIDENCE:**  
The literature supports aspects of this approach. Test-time scaling via multiple candidates and Best-of-N selection improves reasoning in large models [2]. Learned scorers (PRMs) can outperform heuristic ranking [2]. However, small open models show mixed gains from such methods [1], and reliable re-ranking remains challenging without strong verification [3,8]. None directly confirm that lightweight re-ranking on small models reliably raises reasoning per parameter.

**WHAT WOULD FALSIFY IT:**  
If generating multiple chains plus lightweight re-ranking does not improve or even degrades reasoning accuracy compared to a single best chain baseline—especially when measured on held-out reasoning benchmarks—this would falsify the claim. Also, if the learned scorer fails to generalize or consistently misranks better chains, the mechanism fails.

**RISK:**  
This method might inflate headline accuracy by cherry-picking rare correct chains, masking overall model weakness. It could increase latency and complexity, and the scorer might overfit to superficial features, reducing robustness. Thus, apparent gains might not translate to consistent, reliable reasoning improvements in real use.

</details>

## 3. Parameter-Efficient Instruction Tuning on Reasoning Subtasks

**Cost:** medium · **BTL strength** 0.1243 (6/8 pairwise wins)

**Mechanism.** Use LoRA or adapters to instruction-tune a 10B model on targeted reasoning subtasks to boost reasoning per parameter

**Run this.** Fine-tune adapters on math and logic subtasks, evaluate on held-out reasoning benchmarks

**Kills it.** No significant reasoning accuracy gain over base model

**Needs from you.** 8GB GPU, reasoning subtask datasets, 2 weeks

**Retrieved:** `2607.20448`, `2602.15195`, `2507.08044`, `2510.00229`, `2606.12801`, `2510.00206`, `2608.05161`, `2509.03234`

<details><summary>Sceptical review</summary>

MECHANISM:  
Parameter-Efficient Instruction Tuning (PEFT) methods like LoRA or adapters can selectively update a small subset of parameters focused on reasoning subtasks, enabling targeted improvements without full model retraining. This can boost reasoning capability per parameter by concentrating capacity on reasoning patterns and instruction-following, potentially improving sample efficiency and inference cost on a 10B model that fits 8GB VRAM.

EVIDENCE:  
The literature supports LoRA’s efficiency and modularity for fine-tuning [3,6], and its use in instruction tuning for domain-specific tasks [5,7]. Domyn-Small [1] shows a 10B reasoning model benefits from continued pretraining and instruction tuning, though not specifically via LoRA. None directly demonstrate that LoRA-based instruction tuning on reasoning subtasks alone significantly raises reasoning *per parameter* in small models.

WHAT WOULD FALSIFY IT:  
If LoRA or adapter tuning on reasoning subtasks fails to improve reasoning benchmarks relative to full fine-tuning or larger models, or if improvements come only from increased parameter count or data scale rather than tuning method, the claim would be falsified.

RISK:  
Focusing on parameter-efficient tuning might improve benchmark scores superficially by overfitting reasoning subtasks or instruction formats, while degrading generalization or robustness. This could inflate headline reasoning metrics but reduce real-world reasoning reliability or increase vulnerability to adversarial inputs.

</details>

## 4. Tool-Use Routing with Canary Tools in Small Models

**Cost:** low · **BTL strength** 0.0618 (5/8 pairwise wins)

**Mechanism.** Embed diagnostic canary tools to identify and correct tool-selection errors in agent workflows

**Run this.** Deploy a small 7B model agent with canary tools on AgentFloor tasks, measure tool-selection accuracy and reasoning gains

**Kills it.** No measurable improvement in tool selection or downstream reasoning performance

**Needs from you.** 8GB GPUs, AgentFloor benchmark, 1 week integration and testing

**Retrieved:** `2608.04719`, `2509.23426`, `2602.17046`, `2608.15579`, `2605.00334`, `2605.27957`, `2607.03953`, `2606.30185`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Embedding canary tools acts as targeted diagnostic probes that reveal specific tool-selection errors by triggering known failure modes (e.g., semantic decoys or parameter traps). This explicit error signal can guide the model or controller to recognize and correct misrouted calls, improving reasoning per parameter by reducing wasted steps and incorrect tool invocations. In small models constrained by memory and compute, this focused feedback loop could compensate for limited internal reasoning by externalizing error detection and correction.

**EVIDENCE:**  
[1] directly introduces canary tools and a taxonomy of tool-selection weaknesses, demonstrating their diagnostic value in identifying why models pick wrong tools. [5] discusses routing challenges in small open-weight models, highlighting the importance of precise tool selection. However, none of the papers provide conclusive evidence that embedding canary tools improves reasoning capability per parameter or overall system performance in small models on limited hardware.

**WHAT WOULD FALSIFY IT:**  
If embedding canary tools does not reduce tool-selection errors or fails to improve downstream task accuracy and reasoning quality in small models—especially when measured against a baseline without canaries—this would falsify the claim. Additionally, if the overhead of canary tools leads to no net gain or even regression in effective reasoning per parameter, the mechanism would be invalidated.

**RISK:**  
Canary tools might inflate apparent reasoning metrics by catching trivial or contrived errors without improving genuine reasoning or task success. They could also increase context size or complexity, causing latency or memory issues on 8GB hardware, thereby degrading real-world usability despite improved diagnostic signals. This could mislead evaluation to overstate gains while masking practical regressions.

</details>

## 5. Spectral Rewiring for Parameter-Efficient Reasoning Boost

**Cost:** medium · **BTL strength** 0.0305 (4/8 pairwise wins)

**Mechanism.** Apply spectral rewiring to selectively update subnetworks to reduce interference and improve reasoning

**Run this.** Fine-tune a 6B open-weight model on reasoning tasks with spectral rewiring vs standard fine-tuning

**Kills it.** No improvement or degradation in reasoning accuracy or parameter efficiency

**Needs from you.** 8GB GPUs, reasoning datasets, 2 weeks fine-tuning

**Retrieved:** `2607.03065`, `2507.06558`, `2508.08665`, `2606.31092`, `2602.09314`, `2606.01806`, `2508.12387`, `2608.09250`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Spectral rewiring aims to selectively update subnetworks by manipulating the spectral properties (e.g., singular values or eigen-directions) of weight matrices. This can reduce interference between learned features and preserve useful reasoning pathways, potentially improving parameter efficiency by focusing updates on critical subspaces rather than the full parameter space. For a small 8GB model, this targeted adaptation could boost reasoning per parameter by avoiding destructive interference common in dense fine-tuning.

**EVIDENCE:**  
[1] discusses spectral rewiring to reduce interference and improve reasoning in large models, supporting the core idea. [4] also highlights preserving capabilities via dominant spectral directions, aligning with selective subnetwork updates. However, none of the papers directly demonstrate spectral rewiring’s effectiveness specifically for small, resource-constrained models or reasoning improvements per parameter. Other papers focus on related but distinct methods (e.g., LoRA in [2], federated training in [8]) or general small model scaling ([6], [7]).

**WHAT WOULD FALSIFY IT:**  
If applying spectral rewiring to a small 7B or similar model yields no improvement—or even degradation—in reasoning benchmarks per parameter compared to standard fine-tuning or LoRA, especially when controlling for compute and memory, this would falsify the claim. Also, if interference is not measurably reduced or reasoning pathways are not preserved, the mechanism fails.

**RISK:**  
Spectral rewiring might improve headline reasoning scores by overfitting or focusing on narrow subspaces, reducing generalization or robustness. It could also increase training complexity and overhead, negating parameter efficiency gains. Worse, it might mask failures in multi-step reasoning by stabilizing superficial patterns rather than true capability improvements.

</details>

## 6. Self-Consistency Verification via Multi-Pass Reasoning Sampling

**Cost:** low · **BTL strength** 0.0147 (3/8 pairwise wins)

**Mechanism.** Sample multiple reasoning paths per query, then verify consistency across outputs to improve confidence and accuracy

**Run this.** Generate multiple chains on 10B model, measure accuracy gain from self-consistency voting

**Kills it.** Self-consistency voting does not improve or reduces accuracy

**Needs from you.** 8GB GPU, reasoning benchmark, 1 week

**Retrieved:** `2602.02443`, `2511.00751`, `2608.14420`, `2602.07594`, `2603.21301`, `2510.15444`, `2606.17312`, `2606.21724`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Self-Consistency Verification via Multi-Pass Reasoning Sampling works by generating multiple independent reasoning chains for the same query, then aggregating or verifying consistency across these outputs. This can reduce errors caused by single-path hallucinations or reasoning shortcuts, as consensus among diverse samples may indicate higher confidence and correctness. It leverages the model’s stochasticity to explore alternative reasoning trajectories, potentially surfacing more robust answers.

**EVIDENCE:**  
The literature provides mixed support. Early work [5] shows self-consistency can improve reasoning accuracy by aggregating multiple samples. However, [2] warns that as models improve, returns diminish and costs rise, sometimes degrading performance on reliably solved problems. [4] highlights that models struggle with self-verification, limiting gains from consistency checks. [8] suggests iterative verification loops can help but require careful design. Overall, evidence supports potential benefits but also significant caveats and diminishing returns.

**WHAT WOULD FALSIFY IT:**  
If multi-pass sampling and consistency verification fail to improve or even reduce accuracy on reasoning benchmarks—especially when controlling for compute—and if consensus answers do not correlate with correctness, this would falsify the mechanism. Additionally, if verification consistently fails to detect or correct errors in sampled reasoning paths, the approach would be invalidated.

**RISK:**  
This method could inflate headline accuracy by favoring frequent but incorrect consensus answers, masking rare but correct solutions. It may also increase latency and compute costs, reducing practical throughput. Over-reliance on consensus might suppress answer diversity, leading to brittle or overconfident outputs that degrade user trust or downstream verification.

</details>

## 7. Verification-Refinement Loop on 10B Open-Weight Model

**Cost:** medium · **BTL strength** 0.0067 (2/8 pairwise wins)

**Mechanism.** Iteratively generate chain-of-thought with self-verification and correction to boost reasoning per parameter

**Run this.** Run multi-step math reasoning tasks with and without verification-refinement on Domyn-Small 10B

**Kills it.** No significant accuracy or coherence improvement after 3 refinement cycles

**Needs from you.** 8GB GPU, curated reasoning benchmarks, 1 week of fine-tuning and evaluation

**Retrieved:** `2510.17498`, `2602.02416`, `2606.13156`, `2602.08948`, `2603.25944`, `2602.00871`, `2606.21724`, `2607.20448`

<details><summary>Sceptical review</summary>

**MECHANISM:**
The proposed verification-refinement loop aims to boost reasoning by mimicking human problem-solving. The model would first generate a chain-of-thought, then critically evaluate

</details>

## 8. Modular Verification Heads for Localized Reasoning

**Cost:** medium · **BTL strength** 0.0027 (1/8 pairwise wins)

**Mechanism.** Add small specialized verification heads to frozen base model layers to improve local reasoning checks without full retraining

**Run this.** Attach and fine-tune verification heads on 10B model layers, measure reasoning accuracy on multi-step logic tasks

**Kills it.** No accuracy improvement or degraded reasoning despite heads added

**Needs from you.** 8GB GPU for fine-tuning heads, curated reasoning dataset, 1-2 weeks

**Retrieved:** `2607.28669`, `2607.03065`, `2603.00729`, `2606.20244`, `2605.31268`, `2603.03335`, `2605.00334`, `2602.18649`

<details><summary>Sceptical review</summary>

MECHANISM:  
Adding modular verification heads to frozen base model layers could improve local reasoning by explicitly checking intermediate representations for consistency or correctness. These small specialized heads act as lightweight monitors or validators, enabling targeted corrections or confidence assessments without retraining the entire model. This modular approach leverages frozen weights to save compute and memory, while enhancing reasoning by isolating and verifying subcomponents of the reasoning chain.

EVIDENCE:  
None of the retrieved papers directly evaluate modular verification heads for local reasoning in frozen models. [1] LARA shows lightweight residual adapters can adapt frozen models efficiently but focuses on adaptation rather than verification. [4] SPOT-E uses test-time interventions to improve evidence readout but in vision-language models, not language-only reasoning. [6] shows capability localization in attention heads, suggesting some modularity, but does not test added verification modules. Overall, no direct empirical support for the proposed mechanism is found.

WHAT WOULD FALSIFY IT:  
If adding verification heads to frozen layers fails to improve or even degrades reasoning benchmarks compared to the base model, especially when controlling for parameter count and compute, this would falsify the claim. Also, if verification heads cannot reliably detect or correct local reasoning errors, or if their outputs do not correlate with improved final answers, the approach would be invalidated.

RISK:  
Verification heads might improve intermediate metrics or confidence scores without improving end-task reasoning, creating a false sense of progress. They could also increase inference latency or complexity, harming throughput. Worse, they might bias the model toward overconfident but incorrect local checks, reducing overall robustness despite raising headline reasoning scores.

</details>
