# Bench list — raise reasoning capability per parameter in a small in-house language model we can serve on 8GB, using open-weight models and verification we can run ourselves

**NOTHING HERE HAS BEEN RUN.** These are ranked proposals, not results. The ranking is a Bradley-Terry-Luce fit over 28 pairwise judgements; it says which ideas an LLM judge preferred given the retrieved literature, and nothing about whether they work.

**Sham control held.** An inert proposal was ranked in disguise alongside these and placed 7 of 8, so the ranking is not simply rewarding plausible prose.

Corpus: 40 papers retrieved, 10 most relevant + 8 most recent shown to the generator. 0 of 6 ideas below retrieved no supporting paper. Generated 2026-08-20.

---

## 1. Ledger-Guided Meta-Reasoning Policy Distillation

**Cost:** medium · **BTL strength** 0.5147 (7/7 pairwise wins)

**Prior art: UNVERIFIED**. No prior work or papers explicitly meta-learn a policy from a longitudinal ledger to guide reasoning path convergence heuristics. arXiv, OpenAlex and OpenReview were searched (113 hits) and none matched.

**Mechanism.** Use the lab's longitudinal ledger to meta-learn a policy that predicts which reasoning paths yield convergence, distilling this into a small model's inference-time heuristic

**Run this.** Train a policy network on ledger data to guide model reasoning steps, then evaluate reasoning accuracy and efficiency on unseen tasks

**Kills it.** No improvement or degradation in reasoning accuracy or efficiency compared to unguided baseline

**Needs from you.** 8GB GPU, ledger access, weeks

**Retrieved:** `2605.14876`, `2508.16665`, `2602.14077`, `2605.08776`, `2510.16657`, `2509.17489`, `2508.12387`, `2510.06101`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Ledger-Guided Meta-Reasoning Policy Distillation aims to leverage a longitudinal ledger of past reasoning attempts to meta-learn which reasoning paths reliably converge to correct answers. By distilling this meta-policy into a small model’s inference-time heuristic, the model can prioritize promising reasoning trajectories, improving reasoning efficiency and accuracy per parameter. This could reduce redundant or hallucinated steps, effectively compressing reasoning strategies learned from larger or more complex models into a compact form suitable for 8GB deployment.

**EVIDENCE:**  
The retrieved literature provides partial support but no direct validation. [4] Reasoning Compression with Mixed-Policy Distillation shows distillation can shorten reasoning traces in smaller models, aligning with the idea of policy distillation. [2] discusses test-time scaling and distilling reasoning traces, relevant to meta-learning inference heuristics. [1] highlights the need for verified reasoning to avoid hallucinations, which the ledger could address. However, none explicitly demonstrate meta-learning a policy from a ledger or its distillation into a small model’s heuristic.

**WHAT WOULD FALSIFY IT:**  
If distilling a meta-learned policy from the ledger fails to improve or even degrades the small model’s reasoning accuracy or convergence rate compared to baseline heuristics, despite sufficient training data and compute, this would falsify the claim. Also, if the distilled heuristic cannot generalize beyond the ledger’s recorded cases, it would undermine the approach.

**RISK:**  
The approach might improve benchmark scores by overfitting to the ledger’s historical reasoning paths, reducing robustness to novel problems. It could also bias the small model toward conservative or repetitive reasoning patterns, limiting creativity or adaptability, thus worsening real-world performance despite better headline metrics.

</details>

## 2. Ledger-Driven Curriculum Learning for Small Model Reasoning

**Cost:** high · **BTL strength** 0.2538 (6/7 pairwise wins)

**Prior art: UNVERIFIED**. No prior work or papers explicitly use a ledger-driven curriculum prioritizing historically challenging reasoning patterns for small models. arXiv, OpenAlex and OpenReview were searched (71 hits) and none matched.

**Mechanism.** Use the lab’s longitudinal ledger of hypotheses and refutations to construct a curriculum that prioritizes historically challenging reasoning patterns

**Run this.** Train 7B model on curriculum derived from ledger difficulty scores, compare reasoning generalization and sample efficiency to random curriculum

**Kills it.** No improvement in generalization or sample efficiency compared to random curriculum

**Needs from you.** 8GB GPU, ledger data, 1 month

**Retrieved:** `2509.21124`, `2511.14435`, `2605.11255`, `2605.14215`, `2603.00842`, `2510.17498`, `2507.10182`, `2602.07549`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Leveraging a ledger of past hypotheses and refutations to build a curriculum targets historically difficult reasoning patterns, focusing training on the model’s weak spots. This prioritization could improve reasoning per parameter by efficiently allocating limited capacity to challenging cases, fostering deeper chain-of-thought skills and error correction. The curriculum acts as a form of targeted data curation, potentially accelerating learning in a small model constrained by 8GB memory.

**EVIDENCE:**  
Related work supports curriculum learning and targeted reasoning improvements: [3] shows easy-to-hard curricula improve small model benchmarks; [1] highlights benefits of diverse chain-of-thought data; [6] emphasizes verification-refinement frameworks for reasoning, though mostly in larger models. None directly validate ledger-driven curricula from longitudinal refutations in small open-weight models, so evidence is indirect.

**WHAT WOULD FALSIFY IT:**  
If training on ledger-prioritized data fails to improve or even degrades reasoning accuracy compared to random or uniform sampling, especially on historically challenging patterns, this would falsify the claim. Also, if the model overfits to ledger-specific patterns and general reasoning does not improve, the mechanism would be invalidated.

**RISK:**  
Focusing too narrowly on ledger-identified challenges might cause overfitting to idiosyncratic errors, reducing generalization. This could inflate benchmark scores on curated tasks but degrade real-world reasoning diversity, harming robustness and downstream utility despite improved headline metrics.

</details>

## 3. Null-World Counterfactual Training for Robust Reasoning

**Cost:** medium · **BTL strength** 0.1236 (5/7 pairwise wins)

**Prior art: INCREMENTAL** — `research\epistemic_controller\run_mvp.py`. Prior work runs MVP with null-worlds and boundary states, related but does not explicitly train with null-world counterfactuals to reject false premises.

**Mechanism.** Inject null-world scenarios from epistemic controller as counterfactuals during training to improve model's ability to detect and reject false premises

**Run this.** Fine-tune small model with null-world augmented data, measure false premise acceptance rate and reasoning precision on adversarial sets

**Kills it.** No reduction in false premise acceptance or reasoning errors compared to baseline

**Needs from you.** 8GB GPU, null-world data, weeks

**Retrieved:** `2602.20710`, `2602.16787`, `2603.00729`, `2511.15137`, `2603.00842`, `2511.19923`, `2601.11683`, `2510.10965`

<details><summary>Sceptical review</summary>

MECHANISM:  
Null-World Counterfactual Training aims to improve reasoning by explicitly exposing the model to scenarios where premises are false or irrelevant ("null-worlds"). This should teach the model to recognize and reject invalid assumptions, enhancing epistemic vigilance and robustness in reasoning chains. By integrating counterfactuals during training, the model may better learn to detect contradictions or unsupported claims, thus improving reasoning per parameter in a small model.

EVIDENCE:  
The retrieved literature provides partial support but no direct validation. Papers [1] and [2] discuss counterfactual training improving chain-of-thought faithfulness and causal reasoning, respectively, but focus on large models and do not specifically address null-world or false-premise rejection in small models. Paper [8] highlights the challenge of false premise detection but does not evaluate training interventions. Overall, none directly demonstrate that null-world counterfactual training improves reasoning in small open-weight models on 8GB hardware.

WHAT WOULD FALSIFY IT:  
If a small model trained with null-world counterfactuals fails to improve or even degrades in benchmarks measuring false premise detection and reasoning accuracy compared to a baseline, this would falsify the claim. Additionally, if the model becomes overly conservative—rejecting valid premises or producing more refusals without improved correctness—that would also disprove the mechanism’s effectiveness.

RISK:  
This training could increase refusal rates or produce overly cautious outputs, inflating apparent robustness metrics while reducing useful reasoning or answer coverage. It might also cause the model to memorize counterfactual patterns without genuine understanding, leading to brittle or superficial improvements that do not generalize beyond training distributions.

</details>

## 4. Ledger-Guided Epistemic Controller Bootstrapped Curriculum for 8GB 7B Model in Embodied Intelligence

**Cost:** medium · **BTL strength** 0.0599 (4/7 pairwise wins)

**Prior art: INCREMENTAL** — `docs\research\2026-07-09-hardness-depth.md`. Prior work measured adaptive curriculum signals related to hardness and Q-exit adaptivity, similar but not identical to ledger-guided epistemic control.

**Mechanism.** Use the lab’s ledger of convergence records to dynamically generate a curriculum that adapts epistemic controller gate thresholds to embodied intelligence tasks, improving reasoning per parameter by focusing training on failure modes unique to physical interaction domains

**Run this.** Train a 7B model under 8GB with curriculum steps derived from ledger-identified epistemic failures in embodied tasks, measuring reasoning accuracy and escalation rates against a static curriculum baseline

**Kills it.** No statistically significant improvement in reasoning accuracy or reduction in verified cascade escalations compared to static curriculum

**Needs from you.** 8GB GPU, embodied intelligence task dataset, ledger access, weeks of training

**Retrieved:** `2607.11689`, `2608.06756`, `2512.01187`, `2510.21817`, `2606.08850`, `2604.01669`, `2604.14144`, `2607.20448`

<details><summary>Sceptical review</summary>

MECHANISM:  
Using a ledger of convergence records to dynamically adjust epistemic controller gate thresholds creates a feedback loop that targets failure modes specific to embodied intelligence tasks. By focusing training on these hard cases, the model can allocate capacity more efficiently, improving reasoning per parameter. This curriculum bootstraps from past learning trajectories, potentially accelerating convergence and robustness in physical interaction domains where data is sparse and complex.

EVIDENCE:  
The idea aligns loosely with [3], which shows curricula driven by model failures improve robustness via targeted training. [1] and [2] emphasize the importance of embodied reasoning and iterative perception-action loops but do not directly validate ledger-guided curricula. None of the retrieved papers explicitly demonstrate dynamic gate threshold adaptation or ledger-based curriculum generation for small models on 8GB hardware.

WHAT WOULD FALSIFY IT:  
If dynamically adjusting epistemic controller gates based on ledger records fails to improve or even degrades reasoning accuracy or convergence speed on embodied tasks, especially compared to static or random curricula, this would falsify the claim. Additionally, if the overhead of managing the ledger and dynamic gating outweighs benefits on a 7B 8GB model, the mechanism would be invalidated.

RISK:  
Focusing training narrowly on failure modes might overfit the model to rare or noisy errors, reducing generalization. The ledger-guided curriculum could bias learning towards specific embodied scenarios, harming performance on broader reasoning tasks. This might inflate reasoning metrics on curated benchmarks while degrading real-world robustness or increasing inference latency due to complex gating.

</details>

## 5. Prediction-Market-Driven Curriculum for Formal Specification Reasoning

**Cost:** medium · **BTL strength** 0.0284 (3/7 pairwise wins)

**Prior art: UNVERIFIED**. No paper or prior work directly uses live prediction market outcomes to drive formal specification reasoning curricula. arXiv, OpenAlex and OpenReview were searched (116 hits) and none matched.

**Mechanism.** Use live prediction market outcomes to dynamically select formal specification reasoning tasks that maximize learning signal for small models

**Run this.** Iteratively fine-tune model on market-selected tasks, measure reasoning accuracy on held-out formal specs and convergence speed

**Kills it.** No improvement in formal specification reasoning accuracy or slower convergence than random curriculum

**Needs from you.** 8GB GPU, prediction market data, weeks

**Retrieved:** `2511.14435`, `2507.16331`, `2604.22601`, `2507.10182`, `2604.26733`, `2606.30040`, `2509.19153`, `2601.22642`

<details><summary>Sceptical review</summary>

MECHANISM:  
Using live prediction market outcomes to guide curriculum selection could focus training on tasks where the model’s uncertainty or error is highest, maximizing learning signal per parameter. This dynamic, feedback-driven approach might adaptively prioritize formal specification reasoning problems that are both challenging and informative, potentially improving reasoning capabilities in small models constrained by 8GB memory.

EVIDENCE:  
None of the retrieved papers directly evaluate prediction-market-driven curricula for formal reasoning in small LLMs. Papers [5] and [6] discuss prediction markets and real-world outcome rewards but not their use in curriculum design. Papers [2], [3], [4], and [8] explore formal verification and reasoning in LLMs, but none link these to dynamic curricula driven by live market signals.

WHAT WOULD FALSIFY IT:  
If a small model trained with a prediction-market-driven curriculum shows no improvement or worse performance on formal specification reasoning benchmarks compared to a static or heuristic curriculum, this would falsify the claim. Additionally, if the market signals fail to correlate with task difficulty or learning progress, the mechanism would be invalidated.

RISK:  
Focusing on market-driven tasks might overfit the model to idiosyncratic or noisy market signals, reducing generalization. It could also bias training toward tasks with high market volatility rather than intrinsic learning value, inflating headline metrics while degrading robustness or coverage of formal reasoning skills.

</details>

## 6. Prediction-Market-Informed Prompt Selection for 6B Model Reasoning

**Cost:** medium · **BTL strength** 0.0128 (2/7 pairwise wins)

**Prior art: UNVERIFIED**. No exact or closely matching prior work or papers found using prediction markets to dynamically select prompts for reasoning accuracy. arXiv, OpenAlex and OpenReview were searched (99 hits) and none matched.

**Mechanism.** Use live prediction-market outcomes to dynamically select prompts that maximize reasoning accuracy per parameter

**Run this.** Deploy 6B model with prompt selector trained on prediction-market data, compare reasoning accuracy and calibration to static prompt baselines

**Kills it.** No improvement in reasoning accuracy or calibration over static prompt baselines

**Needs from you.** 8GB GPU, prediction-market data, 3 weeks

**Retrieved:** `2603.25184`, `2602.01970`, `2605.23102`, `2608.04719`, `2604.16742`, `2508.19999`, `2508.06692`, `2604.10733`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Using live prediction-market outcomes to select prompts aims to leverage collective, real-time judgments about which prompts yield the most accurate reasoning. This dynamic selection could prioritize high-utility prompts that generate stronger learning signals or better inference, thus improving reasoning accuracy per parameter without increasing model size. By focusing compute on promising prompts, it may reduce wasted effort on low-gradient or uninformative prompts, enhancing efficiency in a small 6B model constrained to 8GB.

**EVIDENCE:**  
The retrieved literature partially supports related ideas but not this exact mechanism. Papers [1] and [2] discuss online prompt selection and RL-based prompt prioritization to improve reasoning efficiency, highlighting the cost of rollout-heavy training and the benefit of selecting informative prompts. However, none explicitly use live prediction markets as a signal. Paper [1] notes many prompts yield negligible gradients, supporting the idea of selective prompt use. Other papers focus on feature selection or diagnostic tools unrelated to prediction markets. Thus, direct evidence for prediction-market-informed prompt selection is absent.

**WHAT WOULD FALSIFY IT:**  
If dynamically selecting prompts based on live prediction-market outcomes fails to improve or even degrades reasoning accuracy per parameter compared to static or heuristic prompt selection, this would falsify the claim. Specifically, if the overhead or noise in market signals leads to poorer prompt choices or no measurable gain in reasoning performance, the mechanism would be invalidated.

**RISK:**  
This approach might improve headline accuracy metrics by overfitting prompt selection to transient market signals or popular prompts, reducing model robustness and generalization. It could bias the system toward prompts that perform well in the market but do not reflect true reasoning improvements, masking underlying model weaknesses or encouraging sycophantic or surface-level responses that inflate scores without genuine capability gains.

</details>

---

## Verify before starting

4 idea(s) matched nothing — 4 of them after arXiv, OpenAlex and OpenReview were actually searched. That is still not novelty: no index covers work published only as a blog post or a model card, or anything too recent to be indexed at all. Re-run these by hand before committing real time.

**1. Ledger-Guided Meta-Reasoning Policy Distillation**
- `ledger-guided meta-reasoning policy distillation`
- `meta-learn reasoning path convergence policy distillation`

**2. Ledger-Driven Curriculum Learning for Small Model Reasoning**
- `ledger-driven curriculum learning for small model reasoning`
- `curriculum learning using hypothesis refutation ledger`

**5. Prediction-Market-Driven Curriculum for Formal Specification Reasoning**
- `prediction market driven curriculum formal specification reasoning`
- `using prediction markets to select formal reasoning tasks`

**6. Prediction-Market-Informed Prompt Selection for 6B Model Reasoning**
- `prediction market informed prompt selection for large language models`
- `using live prediction market outcomes to improve prompt selection in LLM reasoning`
