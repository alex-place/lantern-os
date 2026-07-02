# A/B Test Report: Hallucination Recall with Model Uncertainty

## Experiment Goal
The primary objective of this A/B test was to evaluate whether incorporating `modelUncertainty` into the groundedness axis of a hallucination detection system improves hallucination recall. A key constraint was to achieve this improvement while either fixing the False Positive Rate (FPR) or allowing it to only slightly increase.

## Methodology
An A/B harness (`experiments/surprise_leak_ab.py`) was developed to simulate model responses and hallucination detection.

- **Baseline (A):** A text-only model where hallucination detection relies solely on the textual output.
- **Canary (B):** A text+surprise model where `modelUncertainty` is integrated into the groundedness evaluation. Specifically, higher `modelUncertainty` makes it more likely for a response to be flagged as ungrounded/hallucinated.

The experiment simulated `5000` model responses for each configuration. For each response, the actual grounded status and hallucination status were simulated. The detection system then predicted hallucination, and metrics (Recall and FPR) were calculated.

## Results

```
# Output from experiments/surprise_leak_ab.py will be inserted here
```

## Analysis
*(To be filled after running the experiment)*

Based on the generated results, we will analyze:
- **Recall Improvement:** Did the canary (text+surprise) model achieve a higher hallucination recall compared to the baseline (text-only)?
- **FPR Impact:** Was the FPR for the canary model fixed (i.e., similar to baseline) or did it only increase marginally?
- **Trade-off:** Is the potential gain in recall worth any observed increase in FPR?

## Conclusion and Recommendation
*(To be filled after analysis)*

Based on the analysis, a recommendation will be made regarding the integration of the surprise signal (modelUncertainty) into the hallucination detection system. This will include whether to keep it on, off, or to define a specific threshold for its usage.
