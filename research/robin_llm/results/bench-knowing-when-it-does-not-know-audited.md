# Bench list — detect when a language model is answering beyond what it knows, from its own activations, cheaply enough to run on every token in production

**NOTHING HERE HAS BEEN RUN.** These are ranked proposals, not results. The ranking is a Bradley-Terry-Luce fit over 36 pairwise judgements; it says which ideas an LLM judge preferred given the retrieved literature, and nothing about whether they work.

**Sham control held.** An inert proposal was ranked in disguise alongside these and placed 9 of 9, so the ranking is not simply rewarding plausible prose.

**Novelty audit ran** and both of its own controls passed (a planted restatement was caught, a planted already-answered idea was caught): 4 ANSWERED-HERE, 4 INCREMENTAL.

No verdict below says "novel", because nothing here can establish that. `UNVERIFIED` means the local corpus and our own notebook did not match it — the same silence that, read as novelty on 2026-08-20, produced two recommendations a single web search killed.

Corpus: 40 papers retrieved, 10 most relevant + 8 most recent shown to the generator. 0 of 8 ideas below retrieved no supporting paper. Generated 2026-08-20.

---

## 1. Internal Confidence Probing via Linear Classifiers on Activations

**Cost:** low · **BTL strength** 0.5024 (8/8 pairwise wins)

**Prior art: ANSWERED-HERE** — `experiments\v1_10_toy\probe_ladder.py`. Linear probes on hidden states decode truth and confidence signals, matching internal confidence probing via linear classifiers.

**Mechanism.** Internal activations encode confidence signals separable by simple classifiers, enabling cheap token-level confidence estimation

**Run this.** Train linear probes on frozen activations to classify hallucinated vs. factual tokens; evaluate probe accuracy and inference cost

**Kills it.** Linear probes fail to distinguish hallucinated tokens above chance or require complex models

**Needs from you.** Activation extraction, labeled hallucination tokens, modest GPU for probe training

**Retrieved:** `2604.22271`, `2607.11414`, `2509.03531`, `2511.21610`, `2608.18597`, `2603.04069`, `2608.17063`, `2605.28740`

<details><summary>Sceptical review</summary>

MECHANISM:  
Internal activations in LLMs reflect intermediate computations and latent representations, which plausibly encode not only content but also meta-cognitive signals like confidence. A simple linear classifier trained on these activations could extract a scalar confidence estimate cheaply at each token step, enabling real-time uncertainty detection without expensive external models or sampling. This leverages the model’s own internal “awareness” of uncertainty embedded in its hidden states.

EVIDENCE:  
[1] and [2] provide direct support, showing that internal activations contain signals correlated with confidence and error detection, including confident hallucinations. [3] demonstrates a cheap, scalable real-time detection method, though details on linear probing are less explicit. [8] shows supervised token-level uncertainty quantification using internal states in clinical text, supporting feasibility. Other papers focus on related but distinct phenomena (e.g., skill neurons [4], reward hacking [6]) or different domains [5]. Overall, evidence supports the presence of confidence signals in activations and their extractability by simple classifiers.

WHAT WOULD FALSIFY IT:  
If linear classifiers trained on internal activations fail to predict token-level confidence better than output probabilities or simple heuristics, or if confidence signals are not linearly separable and require complex, costly models, this would falsify the claim. Also, if confidence signals degrade significantly in production-scale models or real-time settings, it would undermine practicality.

RISK:  
Optimizing for linear classifier confidence scores might encourage the model to encode spurious or proxy signals that improve the classifier’s metric but do not reflect true uncertainty, leading to overconfident errors or missed hallucinations. This could inflate headline confidence detection accuracy while degrading actual reliability and user trust.

</details>

## 2. Attention Pattern Entropy as a Hallucination Signal

**Cost:** medium · **BTL strength** 0.2508 (7/8 pairwise wins)

**Prior art: INCREMENTAL** — `docs\research\2026-06-30-surprise-leak-layer1-result.md`. Prior work measured surprise (related to entropy) separating hallucination but not directly attention entropy as hallucination signal.

**Mechanism.** Hallucinations correlate with increased entropy or irregularity in attention distributions, reflecting uncertainty or off-manifold reasoning

**Run this.** Compute per-token attention entropy during generation; correlate spikes with hallucination occurrences

**Kills it.** Attention entropy does not correlate with hallucination events or fails to predict them reliably

**Needs from you.** Model attention weights extraction, hallucination-labeled data, GPU for inference

**Retrieved:** `2608.18597`, `2509.10753`, `2508.14496`, `2607.20487`, `2511.10837`, `2511.17946`, `2509.04492`, `2603.16459`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Attention pattern entropy could signal hallucination because when a model is uncertain or reasoning off-distribution, its attention weights may become more diffuse or irregular, reflecting less confident or inconsistent focus on input tokens. This increased entropy in attention distributions might correlate with internal uncertainty or off-manifold activations, providing a cheap, token-level proxy for hallucination detection without expensive sampling or external checks.

**EVIDENCE:**  
The retrieved literature offers mixed support. [5] directly studies hallucinations through attention patterns, suggesting intrinsic hallucinations manifest in attention irregularities, supporting the mechanism. [7] and [8] show token-level entropy correlates with hallucination but focus on output token entropy rather than attention entropy specifically. [3] argues uncertainty measures beyond entropy are needed, implying attention entropy alone may be insufficient. Other papers ([1], [2], [4], [6]) do not directly address attention entropy as a hallucination signal. Overall, evidence is suggestive but not conclusive.

**WHAT WOULD FALSIFY IT:**  
If attention entropy does not reliably increase during hallucinations—e.g., hallucinated tokens have similar or lower attention entropy compared to factual tokens—or if high attention entropy occurs frequently in correct outputs, this would falsify the claim. Also, if attention entropy fails to predict hallucinations better than simpler baselines like output token entropy, the mechanism would be undermined.

**RISK:**  
Optimizing for lower attention entropy as a hallucination signal might encourage the model to produce overly confident but incorrect outputs, reducing diversity and robustness. The system could suppress genuine uncertainty signals, leading to false negatives or brittle behavior, thus improving detection metrics superficially while degrading real-world reliability.

</details>

## 3. Layerwise Activation Variance Drop as Hallucination Signal

**Cost:** medium · **BTL strength** 0.1253 (6/8 pairwise wins)

**Prior art: ANSWERED-HERE** — `experiments/sigma0_hneurons_probe.py`. Our prior work probes neuron activation patterns predicting hallucination, showing collapsed signals in FFN neurons, matching variance drop mechanism.

**Mechanism.** Hallucinations cause internal representations to collapse, reducing variance across neurons in key layers.

**Run this.** Measure per-token activation variance in mid and late transformer layers during known hallucination vs. factual tokens.

**Kills it.** No significant or consistent variance drop between hallucinated and factual tokens.

**Needs from you.** Access to model activations on consumer GPUs, labeled hallucination dataset, moderate compute for inference.

**Retrieved:** `2607.00158`, `2608.18597`, `2606.08705`, `2604.15741`, `2607.08399`, `2510.08389`, `2604.15945`, `2509.13664`

<details><summary>Sceptical review</summary>

MECHANISM:  
Hallucinations might cause internal representations to "collapse," reducing the diversity of neuron activations and thus lowering variance within key layers. This could reflect a loss of nuanced, confident knowledge encoding, making layerwise activation variance a proxy signal for hallucination. Because variance is cheap to compute on activations, it could enable token-level, real-time detection without expensive external checks.

EVIDENCE:  
[6] supports a related idea by linking spectral properties (effective rank) of hidden states to uncertainty and hallucination detection, which is conceptually close to variance collapse. [1] and [3] show neuron-level signals correlate with hallucination but do not specifically confirm variance drop. [4] discusses internal dispersion but highlights challenges in assumptions about hidden state evolution. Overall, direct evidence for variance drop as a reliable hallucination signal is limited; none conclusively validate this exact mechanism.

WHAT WOULD FALSIFY IT:  
If hallucinations occur without any consistent reduction in layerwise activation variance, or if variance drops also occur during confident, correct answers, this would falsify the claim. Additionally, if variance changes are too subtle or noisy to distinguish hallucinations in production, the mechanism fails.

RISK:  
Optimizing for variance drop detection might encourage the model to produce less diverse but superficially "stable" activations, masking hallucinations rather than preventing them. This could improve detection metrics while allowing subtle or plausible-sounding hallucinations to persist, degrading real-world trustworthiness.

</details>

## 4. Cross-Model Consistency Check Using Frontier API as Reference

**Cost:** high · **BTL strength** 0.0632 (5/8 pairwise wins)

**Prior art: INCREMENTAL** — `experiments\sigma0_hneurons_probe.py`. Prior work probes hallucination-related neurons but does not cross-check local activations against external API outputs for consistency.

**Mechanism.** Disagreement between local model activations and frontier API outputs signals hallucination or overconfident errors

**Run this.** Compare local model token-level activations and frontier API token predictions on same prompts; flag tokens with high disagreement

**Kills it.** Disagreement does not correlate with hallucination or is too costly to run per token

**Needs from you.** Access to frontier API, local model activations, budget for API calls, GPU for local inference

**Retrieved:** `2603.16459`, `2603.25450`, `2604.22271`, `2607.08065`, `2606.02289`, `2511.17946`, `2606.29090`, `2608.18597`

<details><summary>Sceptical review</summary>

MECHANISM:  
Cross-model consistency leverages disagreement between a local model’s activations and a stronger, presumably more accurate “frontier” API output as a hallucination signal. If the local model’s internal state predicts one answer but the external API disagrees, this mismatch could indicate overconfident errors or hallucinations. This works because the frontier API acts as a reference standard, and divergence highlights uncertainty or error beyond the local model’s own confidence metrics.

EVIDENCE:  
[2] directly supports cross-model disagreement as a label-free correctness signal, showing it can detect confident errors missed by internal uncertainty. [4] cautions that agreement is not always reliable, indicating the method’s limitations. [1], [3], and [5] focus on internal uncertainty or hallucination taxonomies but do not validate cross-model checks. The rest are unrelated or tangential. Overall, evidence is partial and mixed, with no definitive proof that cross-model disagreement reliably detects hallucinations cheaply at token-level.

WHAT WOULD FALSIFY IT:  
If the local model frequently disagrees with the frontier API on correct answers or agrees on hallucinated outputs, the signal fails. Also, if disagreement correlates poorly with actual hallucinations or is too noisy to use token-by-token, the approach is invalidated.

RISK:  
Relying on an external API for reference may bias detection toward the frontier model’s errors or domain coverage, missing hallucinations unique to the local model. It could inflate headline detection rates by flagging benign differences as hallucinations, leading to unnecessary rejections or degraded user experience despite no real improvement in reliability.

</details>

## 5. Token-Level Activation Clustering to Identify Out-of-Distribution Responses

**Cost:** medium · **BTL strength** 0.032 (4/8 pairwise wins)

**Prior art: ANSWERED-HERE** — `experiments/sigma0_hneurons_probe.py`. H-Neurons probe measures neuron activation patterns predictive of hallucination, clustering hallucinated tokens distinctly from factual ones.

**Mechanism.** Hallucinated tokens activate neuron patterns that cluster separately from in-distribution factual tokens.

**Run this.** Cluster token activations from a held-out set; test if hallucinated tokens form distinct clusters separable by simple classifiers.

**Kills it.** Hallucinated tokens do not form separable clusters from factual tokens in activation space.

**Needs from you.** Activation extraction, clustering tools, labeled hallucination dataset, consumer GPUs for inference.

**Retrieved:** `2509.03531`, `2507.14179`, `2510.26277`, `2603.13418`, `2606.08777`, `2608.18597`, `2605.11906`, `2510.07896`

<details><summary>Sceptical review</summary>

MECHANISM:  
Hallucinated tokens may trigger distinct neuron activation patterns because they represent out-of-distribution (OOD) content not grounded in the training data. Clustering these token-level activations could separate factual (in-distribution) from hallucinated (OOD) tokens, enabling cheap, real-time detection by monitoring neuron patterns rather than relying on costly external verification or post-hoc checks.

EVIDENCE:  
[1] supports the feasibility of real-time hallucination detection but focuses on entity-level signals rather than token-level activation clustering. [3] shows neuron activations correlate with correctness signals, suggesting internal neuron patterns carry useful information about output reliability. [2] discusses activation sparsity and clustering but in the context of computational efficiency, not hallucination detection. Overall, none directly validate token-level activation clustering as a reliable hallucination detector.

WHAT WOULD FALSIFY IT:  
If hallucinated tokens do not form distinct, consistently separable clusters in neuron activation space—i.e., their activations overlap substantially with factual tokens—or if clustering fails to generalize across prompts and domains, the method would be invalidated.

RISK:  
Optimizing for cluster separability might encourage the model to produce token activations that appear “normal” even when hallucinating, masking errors. This could inflate detection metrics while allowing subtle or plausible hallucinations to pass undetected, degrading real-world reliability despite improved headline performance.

</details>

## 6. Activation Norm Thresholding for Hallucination Detection

**Cost:** medium · **BTL strength** 0.0143 (2/7 pairwise wins)

**Prior art: INCREMENTAL** — `experiments\sigma0_hneurons_probe.py`. Prior work probes neuron activations linked to hallucination but does not threshold activation norms per layer as proposed here.

**Mechanism.** Hallucinations cause abnormal activation magnitudes in specific transformer layers, deviating from normal token processing

**Run this.** Measure per-token activation norms on a validation set with known hallucinations; set thresholds to flag hallucinations in real-time

**Kills it.** No significant norm difference between hallucinated and factual tokens or poor detection accuracy

**Needs from you.** Access to model activations, labeled hallucination dataset, GPU for inference and analysis

**Retrieved:** `2511.11087`, `2608.18597`, `2510.00296`, `2509.03531`, `2509.09700`, `2510.08389`, `2510.02324`, `2606.08705`

<details><summary>Sceptical review</summary>

MECHANISM:  
Activation Norm Thresholding posits that hallucinations induce abnormal activation magnitudes in certain transformer layers, reflecting internal model uncertainty or conflict when generating unsupported content. Since activations encode the model’s internal state, unusually high or low norms could signal deviation from normal token processing, enabling cheap, token-level hallucination detection without external verification.

EVIDENCE:  
None of the retrieved papers directly validate simple activation norm thresholding as a reliable hallucination signal. Papers like [3] and [5] emphasize more complex activation patterns or cross-layer attention probing rather than raw norms. [6] suggests uncertainty measures based on spectral properties of activations, not just norms. [4] advocates for scalable real-time detection but does not rely solely on norm thresholds. Overall, the literature points to richer, multi-dimensional activation features rather than single-layer norm thresholds.

WHAT WOULD FALSIFY IT:  
If hallucinations occur without consistent abnormal activation norms—i.e., hallucinated tokens have activation magnitudes indistinguishable from truthful tokens—or if normal tokens sometimes trigger norm deviations, this would falsify the mechanism. Also, if norm thresholding fails to generalize across prompts, models, or layers, it would undermine its utility.

RISK:  
Relying on norm thresholds might improve detection metrics superficially by flagging rare but irrelevant activation spikes, increasing false positives. This could degrade user experience or cause unnecessary fallback behaviors, while missing subtle hallucinations that do not alter norm magnitude, thus giving a false sense of reliability.

</details>

## 7. KV-Cache Surprise: Detecting Hallucination via Unexpected Key-Value Patterns

**Cost:** medium · **BTL strength** 0.0046 (1/7 pairwise wins)

**Prior art: ANSWERED-HERE** — `docs\research\2026-06-30-surprise-leak-layer1-result.md`. Prior work measured surprise in KV cache patterns to separate hallucination signals empirically in production primitives.

**Mechanism.** Hallucinations produce atypical key-value cache distributions, increasing surprise or entropy in attention keys.

**Run this.** Track per-token key-value cache entropy and surprise metrics during generation; correlate with hallucination labels.

**Kills it.** No correlation between KV-cache surprise metrics and hallucination occurrences.

**Needs from you.** Instrumentation of KV-cache during inference, hallucination-labeled tokens, consumer GPUs for token-level logging.

**Retrieved:** `2603.04427`, `2607.24555`, `2607.27600`, `2603.13314`, `2608.07915`, `2606.00024`, `2509.10753`, `2604.15356`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
The proposed change leverages the intuition that hallucinations correspond to atypical or unexpected patterns in the key-value (KV) cache during attention. Since keys guide attention weights and values carry semantic content, unusual distributions or increased entropy in keys could signal the model is generating unsupported or incoherent outputs. Detecting "surprise" in these patterns might provide a cheap, token-level hallucination signal directly from internal activations without external verification.

**EVIDENCE:**  
None of the retrieved papers directly validate that hallucinations produce atypical KV cache distributions or increased surprise in keys. Papers [1], [2], [4], [5], and [6] focus on KV cache compression, efficiency, or structure but do not link these properties to hallucination detection. Paper [3] discusses surprise in KV cache management but in the context of cache compression, not hallucination. Paper [7] proposes a hallucination detection method but unrelated to KV cache surprise. Thus, no direct empirical support exists for the mechanism.

**WHAT WOULD FALSIFY IT:**  
If hallucinations occur without any measurable increase in surprise or entropy in the KV cache keys, or if typical hallucinations produce KV patterns indistinguishable from normal outputs, this would falsify the claim. Also, if a cheap surprise metric fails to correlate with hallucination rates across diverse prompts and models, the mechanism would be invalidated.

**RISK:**  
Optimizing for KV cache surprise as a hallucination proxy might improve detection metrics superficially but miss subtle or context-dependent hallucinations, leading to false confidence. It could also bias the model toward generating less surprising but still incorrect outputs, reducing factuality or creativity while inflating the "surprise" signal’s predictive power.

</details>

## 8. Gradient-Based Sensitivity to Input Perturbations as Hallucination Indicator

**Cost:** high · **BTL strength** 0.0037 (1/8 pairwise wins)

**Prior art: INCREMENTAL** — `docs\research\2026-07-10-hneurons-probe.md`. Prior work probes neuron activations predicting hallucination, related but does not measure gradient sensitivity to input perturbations.

**Mechanism.** Hallucinated tokens arise from fragile internal states, showing higher gradient sensitivity to small input perturbations.

**Run this.** Apply small input perturbations, measure gradient norm changes in activations for hallucinated vs. factual tokens.

**Kills it.** Gradient sensitivity does not differ significantly between hallucinated and factual tokens.

**Needs from you.** Access to gradients during inference, compute for multiple perturbed runs per token, consumer GPUs.

**Retrieved:** `2606.31033`, `2601.21969`, `2603.21693`, `2509.03531`, `2608.15804`, `2512.22508`, `2608.10835`, `2605.06216`

<details><summary>Sceptical review</summary>

MECHANISM:  
Gradient-based sensitivity to input perturbations could work as a hallucination indicator because hallucinated tokens may stem from unstable or fragile internal states in the model. Small changes in input embeddings or context might disproportionately affect the model’s output probabilities for these tokens, reflected in higher gradients. This suggests that hallucinated tokens are less robustly grounded in the input, making gradient sensitivity a plausible cheap proxy for uncertainty or hallucination at the token level.

EVIDENCE:  
None of the retrieved papers directly evaluate gradient-based sensitivity as a hallucination signal. Papers like [1], [4], and [7] focus on token-level hallucination detection using internal representations or learned detectors but do not analyze gradient sensitivity. Methods in [2] and [5] emphasize decoding or alignment strategies rather than gradient metrics. Thus, there is no direct empirical support for this specific mechanism in the literature provided.

WHAT WOULD FALSIFY IT:  
If hallucinated tokens do not consistently exhibit higher gradient sensitivity compared to non-hallucinated tokens, or if tokens with high gradient sensitivity are often factually correct, this would falsify the claim. Additionally, if gradient sensitivity correlates poorly with hallucination across diverse inputs or requires expensive computation negating its cheapness, the mechanism would be invalidated.

RISK:  
Optimizing for gradient sensitivity might improve detection metrics superficially by flagging tokens with inherently unstable embeddings (e.g., rare words) rather than true hallucinations, leading to false positives. This could degrade user experience by over-censoring or mistrusting valid outputs, ultimately reducing system reliability despite improved headline detection scores.

</details>
