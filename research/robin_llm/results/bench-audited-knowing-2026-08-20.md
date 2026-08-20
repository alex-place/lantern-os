# Bench list — detect when a language model is answering beyond what it knows, from its own activations, cheaply enough to run on every token in production

**NOTHING HERE HAS BEEN RUN.** These are ranked proposals, not results. The ranking is a Bradley-Terry-Luce fit over 28 pairwise judgements; it says which ideas an LLM judge preferred given the retrieved literature, and nothing about whether they work.

**Sham control held.** An inert proposal was ranked in disguise alongside these and placed 7 of 8, so the ranking is not simply rewarding plausible prose.

**Novelty audit ran** and both of its own controls passed (a planted restatement was caught, a planted already-answered idea was caught): 2 ANSWERED-HERE, 5 UNVERIFIED.

No verdict below says "novel", because nothing here can establish that. `UNVERIFIED` means the local corpus and our own notebook did not match it — the same silence that, read as novelty on 2026-08-20, produced two recommendations a single web search killed.

Corpus: 40 papers retrieved, 10 most relevant + 8 most recent shown to the generator. 0 of 7 ideas below retrieved no supporting paper. Generated 2026-08-20.

---

## 1. Lightweight Probe Training on Frozen Activations

**Cost:** low · **BTL strength** 0.518 (7/7 pairwise wins)

**Prior art: ANSWERED-HERE** — `experiments/sigma0_hneurons_probe.py`. Probe training on frozen activations to predict hallucination at token level was measured by H-Neurons probe in sigma0_hneurons_probe.py.

**Mechanism.** Train a small classifier on frozen activations from a mid-layer to predict hallucination at token level, testing if cheap probes can detect errors

**Run this.** Train and evaluate probe on held-out hallucination-labeled data, measure accuracy and inference overhead

**Kills it.** Probe accuracy near random or too costly for per-token production use

**Needs from you.** GPU for probe training, hallucination-labeled data, coding time

**Retrieved:** `2608.16970`, `2512.20949`, `2606.10487`, `2507.12379`, `2509.03531`, `2607.11414`, `2601.13288`, `2603.12270`

<details><summary>Sceptical review</summary>

MECHANISM:  
Training a lightweight probe on frozen mid-layer activations leverages the model’s internal representations, which may encode signals about uncertainty or hallucination before the final output is produced. Because the probe is small and uses frozen activations, it can run efficiently on every token without retraining the full model, enabling cheap, token-level hallucination detection in production.

EVIDENCE:  
Several papers support this approach. [3] shows hidden states contain signals useful for streaming moderation via lightweight probes. [2] and [6] demonstrate hallucination and confident error detection from internal activations. [7] confirms that token- and layer-selective probes can classify outputs efficiently in a single pass. None report prohibitive costs or lack of signal in frozen activations, supporting feasibility.

WHAT WOULD FALSIFY IT:  
If probes trained on frozen mid-layer activations fail to predict hallucinations better than chance or uncertainty baselines, especially at token granularity, this would falsify the claim. Also, if the probe’s predictions lag behind or do not correlate with actual hallucinations, it would show the internal activations lack reliable early signals.

RISK:  
Optimizing probe accuracy on a benchmark might encourage overfitting to superficial activation patterns that correlate with hallucinations but do not generalize, causing false alarms or missed errors in deployment. This could degrade user trust or system safety despite improved headline detection metrics.

</details>

## 2. Activation Confidence as Hallucination Signal

**Cost:** medium · **BTL strength** 0.2603 (6/7 pairwise wins)

**Prior art: ANSWERED-HERE** — `experiments/sigma0_hneurons_probe.py`. Measured neuron activations as hallucination proxies, testing if specific neurons predict hallucination on our models.

**Mechanism.** Use internal token-level logits entropy and select neuron activations as confidence proxies, hypothesizing low entropy and distinct activations correlate with factual answers

**Run this.** Measure correlation between entropy/activation patterns and ground-truth hallucination labels on benchmark datasets

**Kills it.** No significant correlation or predictive power of activations over simple entropy baseline

**Needs from you.** GPU for inference on benchmark sets, labeled hallucination data, coding time

**Retrieved:** `2607.00158`, `2605.05166`, `2607.07670`, `2603.10195`, `2511.21610`, `2604.22271`, `2511.13240`, `2607.02423`

<details><summary>Sceptical review</summary>

MECHANISM:  
Activation Confidence as a hallucination signal could work because low entropy in token-level logits suggests the model is confident and decisive, while distinct neuron activations may reflect well-learned, factual knowledge patterns. Together, these internal signals might correlate with when the model is generating reliable content versus uncertain or fabricated text, enabling cheap, token-level detection without costly sampling or external checks.

EVIDENCE:  
[3] supports the idea that activation patterns correlate with entity familiarity and factual reliability, indicating internal signals can predict hallucination risk. [6] shows LLMs have internal confidence signals related to error detection, aligning with the entropy proxy. [2] suggests confidence can be estimated early in decoding, though it focuses on output-level signals rather than activations. Other papers like [1], [4], and [5] discuss neuron-level probes and activation patterns but do not directly validate entropy or activation confidence as hallucination detectors. Overall, evidence is suggestive but indirect.

WHAT WOULD FALSIFY IT:  
If low entropy and distinct neuron activations frequently occur during confidently wrong or hallucinated outputs, or if high entropy appears during correct answers, this would break the assumed correlation. Also, if activation patterns fail to generalize across domains or model scales, the mechanism would be invalidated.

RISK:  
Optimizing for low entropy or distinct activations might encourage the model to be overconfident or produce safe but generic answers, reducing factual richness. It could also mask subtle hallucinations that do not trigger entropy spikes, giving a false sense of reliability and degrading real-world trustworthiness despite improved headline detection metrics.

</details>

## 3. Layerwise Activation Divergence for Out-of-Knowledge Detection

**Cost:** medium · **BTL strength** 0.0695 (4/7 pairwise wins)

**Prior art: UNVERIFIED**. No listed papers or prior work measure layerwise activation distribution divergence for hallucination detection as described.

**Mechanism.** Compare activation distributions at each transformer layer for in-distribution vs hallucinated tokens, expecting divergence to spike when model hallucinates

**Run this.** Compute KL divergence of activations between known and hallucinated tokens across layers, test if divergence predicts hallucination

**Kills it.** No consistent divergence pattern or predictive signal emerges across layers

**Needs from you.** GPU for activation extraction, hallucination-labeled data, coding time

**Retrieved:** `2509.23729`, `2512.05038`, `2509.03531`, `2604.08572`, `2605.06216`, `2608.18597`, `2604.21215`, `2605.21333`

<details><summary>Sceptical review</summary>

MECHANISM:  
Layerwise Activation Divergence (LAD) could work because hallucinated tokens may trigger atypical internal activations compared to in-distribution tokens. By measuring divergence in activation distributions at each transformer layer, the model might detect when it ventures beyond learned knowledge, as unusual activations signal uncertainty or error. This leverages the model’s own internal signals without external checks, potentially enabling cheap, token-level detection.

EVIDENCE:  
None of the retrieved papers directly validate LAD for out-of-knowledge detection. Paper [4] discusses activation distribution shifts for out-of-distribution detection but highlights instability and failure modes, suggesting challenges in reliably using activation divergences. Paper [3] proposes real-time hallucination detection but does not focus on layerwise activation divergence. Other papers address quantization, concept activations, or architectural changes unrelated to this mechanism.

WHAT WOULD FALSIFY IT:  
If activation divergences at intermediate layers do not consistently spike or correlate with hallucinated tokens—i.e., if hallucinations occur without measurable divergence or if divergence spikes occur for correct tokens—this would falsify the claim. Also, if the divergence metric is too noisy or computationally expensive to run per token, it would undermine practical utility.

RISK:  
Optimizing for LAD divergence spikes might encourage the model to produce less confident but still incorrect outputs, artificially inflating detection metrics while missing subtle hallucinations. It could also increase false positives, causing unnecessary intervention or degraded user experience, thus improving headline detection rates but worsening overall system reliability.

</details>

## 4. Prefix-Conditioned Activation Variance Reduction for Confidence

**Cost:** high · **BTL strength** 0.0695 (4/7 pairwise wins)

**Prior art: UNVERIFIED**. No listed papers or prior work measure or apply prefix-conditioned activation variance reduction for confidence as described.

**Mechanism.** Model activations become less variable when confident; hallucinations show higher variance conditioned on prefix context.

**Run this.** Measure activation variance across multiple stochastic forward passes per token; test if low variance predicts factual tokens.

**Kills it.** Activation variance does not differ meaningfully between hallucinated and factual tokens.

**Needs from you.** Multiple forward passes per token, GPU time, hallucination-labeled data, coding time.

**Retrieved:** `2607.11414`, `2608.18597`, `2511.13240`, `2604.22271`, `2507.18122`, `2606.29090`, `2606.02289`, `2606.09876`

<details><summary>Sceptical review</summary>

MECHANISM:  
The idea is that when a model is confident, its internal activations stabilize, showing less variance conditioned on the prefix context. Conversely, hallucinations or uncertain outputs cause more erratic activations, reflecting internal conflict or guesswork. Measuring activation variance per token could thus serve as a cheap, intrinsic confidence signal without external calibration or additional models.

EVIDENCE:  
[1] supports the general notion that internal activations correlate with confidence and can detect hallucinations, though it focuses on financial QA and uses more complex signals than simple variance. [4] discusses internal confidence signals but not specifically variance reduction. [7] and [8] highlight the challenge of detecting confident errors but do not validate variance as a reliable metric. Overall, none directly confirm that prefix-conditioned activation variance reduction alone is a robust, generalizable confidence measure.

WHAT WOULD FALSIFY IT:  
If confident hallucinations occur with low activation variance, or if correct, uncertain answers show high variance, the correlation breaks down. Also, if variance fluctuates due to unrelated factors (e.g., token frequency, syntax complexity) rather than confidence, the method fails as a reliable detector.

RISK:  
Optimizing for low activation variance might encourage the model to produce bland, overconfident outputs that appear stable internally but are factually wrong, masking hallucinations. This could improve detection metrics superficially while degrading real-world reliability and trustworthiness.

</details>

## 5. Cross-Model Activation Consistency Check

**Cost:** medium · **BTL strength** 0.0363 (3/7 pairwise wins)

**Prior art: UNVERIFIED**. No listed paper or prior work measures cross-model token-wise activation similarity to detect hallucinations.

**Mechanism.** Run same prompt on two different LLMs, measure cosine similarity of their internal activations token-wise; hypothesis: hallucinations cause activation disagreement

**Run this.** Quantify activation similarity on tokens labeled hallucinated vs factual, test if low similarity predicts hallucination

**Kills it.** Activation similarity does not differ significantly between hallucinated and factual tokens

**Needs from you.** Access to two LLMs (local + frontier API), GPU/cloud for inference, coding time

**Retrieved:** `2607.04222`, `2608.11027`, `2607.11414`, `2608.18597`, `2606.27242`, `2606.02289`, `2606.08129`, `2608.10216`

<details><summary>Sceptical review</summary>

MECHANISM:  
Comparing internal activations of two different LLMs on the same prompt token-by-token could reveal divergence when one model hallucinates. The intuition is that hallucinations reflect internal uncertainty or off-distribution reasoning, causing activation patterns to deviate. Cosine similarity of activations acts as a cheap proxy for agreement in internal feature space, potentially flagging tokens where the models "disagree" on the latent representation of the next token.

EVIDENCE:  
[7] shows that different LLMs often share interaction patterns predicting the same token, supporting the idea that consistent activations correlate with agreement. [3] demonstrates that internal activations can detect confident hallucinations within a single model, but cross-model checks are not directly tested. Other papers focus on activation geometry or embedding similarity but do not directly validate cross-model activation consistency as a hallucination detector. Overall, partial support exists but no direct evidence for this exact mechanism.

WHAT WOULD FALSIFY IT:  
If hallucinations occur without significant divergence in activation similarity between models, or if models disagree internally on non-hallucinated tokens as much as on hallucinated ones, the method fails. Also, if activation similarity correlates poorly with hallucination labels or is dominated by architectural differences rather than semantic errors, the approach is invalidated.

RISK:  
This method could improve detection metrics by flagging tokens where models differ due to architectural or training differences unrelated to hallucination, causing false positives. It might suppress valid novel or creative outputs that differ legitimately, reducing system utility despite better headline hallucination scores. Running two models doubles compute, challenging the "cheap" requirement.

</details>

## 6. Attention Head Sparsity Shift as Hallucination Marker

**Cost:** medium · **BTL strength** 0.0363 (3/7 pairwise wins)

**Prior art: UNVERIFIED**. No listed papers or our prior work measure or analyze attention head sparsity shifts as hallucination markers.

**Mechanism.** Hallucinations cause redistribution of attention weights, increasing sparsity in certain heads as model guesses.

**Run this.** Compute per-head attention sparsity metrics token-wise; test if increased sparsity correlates with hallucinated tokens.

**Kills it.** No consistent increase in attention sparsity during hallucinated token generation.

**Needs from you.** GPU for inference, access to attention weights, hallucination-labeled data, coding time.

**Retrieved:** `2602.22469`, `2509.06596`, `2512.22212`, `2602.09297`, `2605.07209`, `2511.11087`, `2602.17526`, `2607.24017`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Hallucinations may arise when the model relies more on internal priors than on input context, causing attention to concentrate narrowly in certain heads. This would increase sparsity as those heads focus on fewer tokens, reflecting uncertainty or guesswork. Tracking shifts in attention sparsity per head could thus serve as a cheap, token-level signal that the model is "hallucinating" or extrapolating beyond its knowledge.

**EVIDENCE:**  
[1] shows that spatial credit collapse leads to concentrated activations causing hallucinations in vision-language models, supporting the idea that attention patterns shift during hallucination. [2] discusses head importance and gating but finds raw attention weights alone are insufficient to reflect token contribution, suggesting attention sparsity might be an incomplete marker. Other papers focus on related but distinct mechanisms or detection methods ([5], [6]). Overall, direct evidence that attention head sparsity reliably signals hallucination in LLMs is limited or indirect.

**WHAT WOULD FALSIFY IT:**  
If hallucinations occur without any consistent increase in attention sparsity in specific heads, or if attention sparsity fluctuates similarly during both factual and hallucinated outputs, the mechanism would be invalidated. Also, if sparsity changes are not predictive of hallucination at token-level granularity, the approach fails.

**RISK:**  
Optimizing for attention sparsity shifts might encourage the model to produce less sparse but still hallucinated outputs, masking errors. It could also lead to false positives where normal uncertainty triggers sparsity changes, causing unnecessary intervention or degraded fluency, thus improving detection metrics without reducing actual hallucination rates.

</details>

## 7. KV-Cache Activation Norm Drop as Out-of-Knowledge Indicator

**Cost:** medium · **BTL strength** 0.0025 (0/7 pairwise wins)

**Prior art: UNVERIFIED**. No listed papers or prior work measure KV-cache activation norm drops as OOK indicators; no matching mechanism found.

**Mechanism.** When model guesses beyond knowledge, key-value cache activations norm drops due to weaker retrieval signals.

**Run this.** Track KV-cache activation norms per token during generation; test if norm drops predict hallucinations on held-out prompts.

**Kills it.** KV-cache norms do not differ significantly between hallucinated and factual tokens.

**Needs from you.** Access to KV-cache activations, GPU inference, labeled hallucination data, coding time.

**Retrieved:** `2608.07915`, `2607.24555`, `2604.15356`, `2603.13314`, `2604.15409`, `2606.29563`, `2605.22269`, `2602.10238`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
The idea is that when a model ventures beyond its knowledge, the attention mechanism retrieves less relevant or weaker signals from the KV cache, causing the norm (magnitude) of key-value activations to drop. This drop could serve as a cheap, token-level indicator of uncertainty or hallucination, since lower activation norms might reflect weaker contextual grounding or less confident retrieval from past tokens.

**EVIDENCE:**  
None of the retrieved papers directly test or support the claim that KV cache activation norms correlate with out-of-knowledge or hallucination detection. Most focus on compression [1,3,7], efficient caching or eviction [6,8], or structural properties of attention heads [4]. Paper [5] discusses numerical divergence in KV caching but not activation norms as uncertainty signals. Thus, no direct empirical or theoretical support is found.

**WHAT WOULD FALSIFY IT:**  
If empirical measurement shows that KV cache activation norms remain stable or even increase when the model generates hallucinated or unsupported content, or if norm drops occur equally during confident, in-knowledge responses, this would falsify the mechanism. Also, if norm changes correlate more with input length or token frequency than knowledge boundaries, the hypothesis fails.

**RISK:**  
Relying on norm drops might improve a proxy metric (e.g., flagging more tokens as uncertain) without actually detecting true knowledge gaps, leading to false positives or negatives. This could degrade user trust or cause unnecessary fallback behaviors, while masking deeper failure modes not captured by simple norm statistics.

</details>

---

## Verify before starting

5 idea(s) matched nothing locally. That is not novelty — it is an unanswered question. Run these searches first; if any comes back with the same mechanism, the idea is a port, not a discovery.

**3. Layerwise Activation Divergence for Out-of-Knowledge Detection**
- `layerwise activation divergence hallucination detection transformer`
- `activation distribution out-of-knowledge detection large language models`

**4. Prefix-Conditioned Activation Variance Reduction for Confidence**
- `prefix-conditioned activation variance confidence hallucination detection`
- `activation variance reduction model confidence hallucination`

**5. Cross-Model Activation Consistency Check**
- `cross-model activation similarity hallucination detection`
- `token-wise internal activation comparison large language models hallucination`

**6. Attention Head Sparsity Shift as Hallucination Marker**
- `attention head sparsity hallucination detection`
- `hallucination markers in transformer attention patterns`

**7. KV-Cache Activation Norm Drop as Out-of-Knowledge Indicator**
- `KV cache activation norm drop out-of-knowledge detection`
- `LLM key-value cache activation norm hallucination indicator`
