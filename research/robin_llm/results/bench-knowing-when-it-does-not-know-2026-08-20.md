# Bench list — detect when a language model is answering beyond what it knows, from its own activations, cheaply enough to run on every token in production

**NOTHING HERE HAS BEEN RUN.** These are ranked proposals, not results. The ranking is a Bradley-Terry-Luce fit over 28 pairwise judgements; it says which ideas an LLM judge preferred given the retrieved literature, and nothing about whether they work.

**Sham control held.** An inert proposal was ranked in disguise alongside these and placed 8 of 8, so the ranking is not simply rewarding plausible prose.

Corpus: 40 papers retrieved, 10 most relevant + 8 most recent shown to the generator. 0 of 7 ideas below retrieved no supporting paper. Generated 2026-08-20.

---

## 1. Lightweight Probe Training on Frontier API Activations

**Cost:** medium · **BTL strength** 0.5147 (7/7 pairwise wins)

**Mechanism.** Train a small classifier on frozen activations from a frontier API model to predict hallucination likelihood per token.

**Run this.** Collect activations and hallucination labels from API outputs, train probe, evaluate token-level detection accuracy.

**Kills it.** Probe fails to outperform random baseline in hallucination detection.

**Needs from you.** API usage budget, labeled hallucination data, compute for probe training.

**Retrieved:** `2608.14465`, `2509.04492`, `2608.16970`, `2602.18583`, `2608.09643`, `2606.18284`, `2607.00158`, `2606.29809`

<details><summary>Sceptical review</summary>

MECHANISM:  
Training a lightweight probe on frozen activations from a frontier API model could work because the model’s internal states encode rich latent signals about uncertainty and hallucination risk before output tokens are generated. A small classifier can efficiently map these activations to a hallucination likelihood per token, enabling real-time detection without expensive full-model re-evaluation or multiple forward passes.

EVIDENCE:  
[1] shows that residual stream probes can detect reasoning failures and abstain, supporting the idea that internal activations contain useful signals. [7] demonstrates neuron-level evidence for hallucination detection in medical LLMs using probes. [8] explores lightweight hallucination detection methods, emphasizing feasibility under resource constraints. Other papers focus on related but distinct tasks (e.g., code security [3,5], evaluation [4]) or hallucination detection without internal activations [2]. Overall, evidence supports the feasibility of activation-based lightweight probes but not their definitive accuracy or generality.

WHAT WOULD FALSIFY IT:  
If a probe trained on frozen activations consistently fails to predict hallucination likelihood better than simple baselines (e.g., token entropy or log-probabilities), or if the activations do not contain stable, generalizable signals across tasks and domains, this would falsify the claim.

RISK:  
The probe might overfit to superficial activation patterns correlated with hallucination in training data but fail in deployment, giving a false sense of security. It could also increase latency or complexity without meaningful gains, or encourage reliance on a proxy signal that misses subtle or novel hallucinations, degrading overall system trustworthiness.

</details>

## 2. Activation Confidence as Hallucination Signal

**Cost:** medium · **BTL strength** 0.2538 (6/7 pairwise wins)

**Mechanism.** Use internal logits and attention entropy per token as confidence proxies, hypothesizing low confidence correlates with hallucination onset.

**Run this.** Run inference on benchmark with known hallucinations, record activations and entropy, correlate with hallucination labels token-wise.

**Kills it.** No statistically significant correlation between low confidence activations and hallucination tokens.

**Needs from you.** Access to model activations, hallucination-labeled dataset, GPU for inference and logging.

**Retrieved:** `2604.22271`, `2608.09643`, `2607.00158`, `2605.05166`, `2606.01033`, `2608.18597`, `2603.21693`, `2511.17946`

<details><summary>Sceptical review</summary>

MECHANISM:  
Activation confidence, derived from internal logits and attention entropy, could reflect the model’s uncertainty at each token step. Low confidence might indicate the model is venturing beyond well-supported knowledge, triggering hallucination. Since logits encode the model’s predicted token distribution and attention entropy measures focus dispersion, combining these proxies could cheaply flag unreliable outputs without costly sampling or external checks.

EVIDENCE:  
[1] shows LLMs have internal confidence signals linked to error detection, supporting the idea that internal activations carry useful uncertainty information. [5] demonstrates that per-layer logit entropy correlates with hallucination, aligning with the proposed use of activation confidence. [4] suggests single-token confidence can detect hallucinations, reinforcing the feasibility of token-level signals. Other papers focus on related but distinct methods or domains, so partial support exists but no definitive proof that combining logits and attention entropy alone suffices.

WHAT WOULD FALSIFY IT:  
If low activation confidence (logits + attention entropy) fails to correlate with hallucination onset—e.g., many hallucinations occur despite high confidence or many low-confidence tokens are factually correct—this would falsify the mechanism. Also, if confidence signals lag hallucination onset or are too noisy for reliable token-level detection, the approach would be invalidated.

RISK:  
Optimizing for activation confidence as a hallucination signal might encourage the model to produce overconfident but incorrect tokens, masking hallucinations. It could also increase false positives, causing unnecessary interventions or degraded user experience. Thus, headline improvements in detection metrics might hide worsened real-world reliability or increased computational overhead if not carefully validated.

</details>

## 3. Layerwise Activation Divergence for Out-of-Knowledge Detection

**Cost:** medium · **BTL strength** 0.1236 (5/7 pairwise wins)

**Mechanism.** Measure divergence of token activations from training distribution manifold using PCA or autoencoder residuals per layer.

**Run this.** Collect activations on in-distribution vs out-of-knowledge prompts, quantify divergence, test if divergence spikes predict hallucinations.

**Kills it.** Activation divergence does not differ significantly between hallucinated and factual tokens.

**Needs from you.** Compute for activations across layers, dimensionality reduction tools, labeled hallucination data.

**Retrieved:** `2608.18597`, `2605.09887`, `2607.16448`, `2510.14299`, `2607.08399`, `2510.02324`, `2604.22271`, `2604.08572`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Layerwise Activation Divergence aims to detect out-of-knowledge (OOK) tokens by measuring how much token activations deviate from the training distribution manifold at each layer. Using PCA or autoencoder residuals, it quantifies whether activations lie off the learned low-dimensional subspace, signaling unfamiliar inputs. Since activations encode semantic and syntactic knowledge, large divergence could indicate the model is extrapolating beyond its training, thus flagging hallucinations or guesswork cheaply at every token.

**EVIDENCE:**  
The retrieved literature provides partial support but no direct validation. [2] discusses layerwise variation in autoencoder reconstruction error, implying manifold structure varies by layer, which supports layerwise monitoring. [4] uses submanifold-aware methods for anomaly detection, suggesting manifold deviations can detect abnormal inputs. [6] and [7] relate to internal signals for hallucination and error detection but do not evaluate manifold divergence. None explicitly test PCA or autoencoder residuals per layer for OOK detection in language models.

**WHAT WOULD FALSIFY IT:**  
If layerwise activation divergence fails to correlate with true OOK tokens—e.g., if tokens confidently answered beyond training data show low divergence or if in-distribution tokens frequently produce high divergence—this would falsify the approach. Also, if divergence metrics are noisy or unstable across tokens and layers, making reliable detection impossible in production, the method would be invalidated.

**RISK:**  
Optimizing for divergence thresholds might improve detection metrics superficially by flagging rare but in-distribution tokens as OOK, increasing false positives and degrading user experience. It could also encourage the model to produce more conservative, less informative outputs to avoid triggering divergence, reducing overall utility despite better headline OOK detection numbers.

</details>

## 4. Prompt-Conditioned Internal Consistency Check

**Cost:** high · **BTL strength** 0.0599 (4/7 pairwise wins)

**Mechanism.** Compare model’s token-level activations when answering a question vs when answering a paraphrased or related question, expecting consistency drop on hallucinations.

**Run this.** Generate paraphrases, run model on both, measure activation similarity per token, correlate low similarity with hallucination tokens.

**Kills it.** Activation similarity does not differ between hallucinated and correct tokens.

**Needs from you.** Compute multiple inferences per prompt, paraphrase generation, activation extraction.

**Retrieved:** `2607.11414`, `2606.22864`, `2607.00158`, `2605.05166`, `2605.26242`, `2508.19111`, `2606.02289`, `2509.23510`

<details><summary>Sceptical review</summary>

MECHANISM:  
The Prompt-Conditioned Internal Consistency Check aims to detect hallucinations by comparing token-level activations when the model answers a question versus a paraphrased or related question. The intuition is that a truthful, well-grounded answer should produce stable internal representations across semantically equivalent prompts, while hallucinated answers would cause inconsistent activations. This leverages the model’s own internal state as a cheap, per-token signal without requiring multiple decodes or external classifiers.

EVIDENCE:  
[1] shows internal activations can detect confident hallucinations in financial QA, supporting the idea that internal states carry useful signals. [4] suggests self-consistency is effective but costly, motivating cheaper alternatives. [3] finds neuron-level signals correlate with hallucination but controlling them is harder. [5] warns that introspection claims may conflate surface cues with genuine knowledge. Overall, evidence supports internal consistency as a promising but not fully reliable hallucination indicator.

WHAT WOULD FALSIFY IT:  
If token-level activations remain stable across paraphrases even when the model confidently hallucinates, or conversely, if truthful answers produce inconsistent activations due to prompt variability, the method fails. Also, if the consistency metric cannot distinguish hallucinations better than chance or simpler confidence scores, it would falsify the claim.

RISK:  
Optimizing for internal consistency might encourage the model to produce bland, generic answers that are stable but uninformative, reducing factual richness. It could also incentivize gaming the metric by aligning activations superficially without improving truthfulness, thus inflating detection scores while allowing hallucinations to persist.

</details>

## 5. Attention Head Sparsity Drop as Out-of-Knowledge Indicator

**Cost:** low · **BTL strength** 0.0284 (3/7 pairwise wins)

**Mechanism.** Hallucinations reduce sparsity in attention heads, causing more diffuse attention patterns.

**Run this.** Track per-token attention head sparsity (fraction of near-zero weights) on frontier API outputs; compare hallucinated vs grounded tokens.

**Kills it.** No consistent difference in attention sparsity between hallucinated and grounded tokens.

**Needs from you.** Frontier API activations, code to measure sparsity, hallucination annotations.

**Retrieved:** `2605.07363`, `2511.09596`, `2508.15847`, `2608.14712`, `2606.29563`, `2603.13314`, `2602.13699`, `2605.24059`

<details><summary>Sceptical review</summary>

**MECHANISM:**  
Hallucinations might cause attention heads to distribute their focus more evenly across tokens, reducing sparsity and increasing entropy in attention patterns. This diffuse attention could signal uncertainty or out-of-knowledge responses, as the model fails to concentrate on relevant context. Measuring a drop in sparsity per token could thus serve as a cheap, internal indicator of hallucination.

**EVIDENCE:**  
[7] directly studies attention head entropy correlating with answer correctness, supporting the idea that attention distribution changes with hallucinations. [4] discusses metrics for attention row sparsity but does not link it to hallucination detection. Other papers focus on sparse attention mechanisms ([1],[2]) or interpretability ([3],[8]) without validating sparsity drop as an OOK indicator. Overall, evidence is suggestive but indirect; no paper conclusively demonstrates that attention head sparsity reliably flags hallucinations in production.

**WHAT WOULD FALSIFY IT:**  
If hallucinations occur without any measurable decrease in attention sparsity, or if correct answers sometimes show similarly low sparsity, the mechanism fails. Also, if sparsity changes are inconsistent across heads, layers, or tasks, it would undermine its reliability as a universal OOK signal.

**RISK:**  
Optimizing for sparsity drop detection might encourage the model to produce more sharply focused but confidently wrong attention patterns, masking hallucinations. This could improve detection metrics while increasing undetected errors, degrading overall trustworthiness despite better headline numbers.

</details>

## 6. Cross-Layer Activation Norm Ratio for Overconfident Errors

**Cost:** low · **BTL strength** 0.0128 (2/7 pairwise wins)

**Mechanism.** Hallucinations induce abnormal ratios of activation norms between early and late transformer layers.

**Run this.** Compute ratio of L2 norms of activations at early vs late layers per token; test correlation with confident hallucinations on frontier API outputs.

**Kills it.** Activation norm ratios do not differ significantly for hallucinated tokens.

**Needs from you.** Frontier API activations, lightweight norm computations, labeled hallucination data.

**Retrieved:** `2607.08399`, `2605.07284`, `2606.06188`, `2510.06477`, `2603.20991`, `2608.18597`, `2606.12487`, `2510.15076`

<details><summary>Sceptical review</summary>

MECHANISM:  
The proposed Cross-Layer Activation Norm Ratio leverages the intuition that hallucinations or overconfident errors disrupt normal processing dynamics, causing abnormal shifts in activation magnitudes between early and late transformer layers. If early layers encode input features reliably but late layers amplify spurious signals during hallucination, the ratio of their norms could serve as a cheap, endogenous confidence signal, enabling token-level detection without external supervision.

EVIDENCE:  
None of the retrieved papers directly test cross-layer norm ratios as hallucination detectors. Paper [3] shows that layer-wise ℓ2 norms reflect reasoning intensity, suggesting norms carry meaningful signals. Paper [5] discusses error propagation across layers, hinting that layerwise metrics can reveal processing anomalies. However, no work explicitly links abnormal norm ratios to hallucinations or overconfidence errors, nor validates this as a reliable, cheap detection method.

WHAT WOULD FALSIFY IT:  
If hallucinations occur without consistent or systematic changes in the ratio of early-to-late layer activation norms, or if normal, confident predictions sometimes produce similar abnormal ratios, this would falsify the mechanism. Also, if the ratio fails to distinguish hallucinations from other failure modes or normal uncertainty, it would undermine its utility.

RISK:  
Optimizing for this ratio as a detection signal might encourage the model to mask hallucinations by normalizing activations, reducing detection sensitivity. It could also increase false positives, causing unnecessary refusals or degraded user experience, thus improving headline detection metrics while worsening practical reliability.

</details>

## 7. Token-Level Gradient Magnitude Proxy from Frontier API Logits

**Cost:** medium · **BTL strength** 0.0052 (1/7 pairwise wins)

**Mechanism.** Hallucinated tokens produce unstable logits, reflected in higher gradient magnitudes wrt input embeddings.

**Run this.** Approximate per-token gradient magnitudes via finite differences on frontier API logits; correlate high gradients with hallucination occurrences.

**Kills it.** Gradient magnitudes do not correlate with hallucination labels.

**Needs from you.** Frontier API calls with perturbed inputs, compute resources for finite difference gradients.

**Retrieved:** `2512.23447`, `2605.06216`, `2608.18597`, `2604.26167`, `2606.04459`, `2603.09023`, `2509.03531`, `2603.21693`

<details><summary>Sceptical review</summary>

MECHANISM:  
The proposed design leverages the intuition that hallucinated tokens cause unstable or uncertain model outputs, which manifest as volatile logits. By measuring the gradient magnitude of the logits with respect to input embeddings at each token, one can cheaply approximate this instability. High gradient norms would indicate tokens where the model "struggles," potentially signaling hallucination without expensive external checks.

EVIDENCE:  
None of the retrieved papers directly validate token-level gradient magnitudes as hallucination proxies. [7] discusses real-time hallucination detection but does not use gradients; [8] uses Bayesian confidence metrics rather than gradients. Papers like [5] and [2] touch on logit and embedding properties but not gradient-based hallucination signals. Thus, no direct empirical support for this exact mechanism is found.

WHAT WOULD FALSIFY IT:  
If hallucinated tokens do not consistently produce higher gradient magnitudes than truthful tokens, or if stable logits with low gradients still correspond to hallucinations, the method fails. Also, if gradient magnitudes correlate more with token rarity or syntactic complexity than hallucination, the proxy is invalid.

RISK:  
Optimizing for gradient magnitude thresholds might flag rare or difficult tokens as hallucinations, increasing false positives and degrading user trust. It could also incentivize the model to produce "safe" but bland outputs with artificially low gradient signals, reducing overall output quality while superficially improving detection metrics.

</details>
